import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { householdToday } from '../../lib/day';
import { dividendRefusalMessage, movementLines, shortDate } from '../../lib/dividends';

const money2 = (n) => formatMoney(n, { decimals: 2 });
const asText = (v) => (v == null ? '' : String(Number(v)));

// Where a dividend can be paid: an open account in its currency, its broker
// funds first.
function destinationsFor(accounts, currency) {
  return (accounts ?? [])
    .filter((a) => a.currency === currency && !a.archived_at)
    .sort((a, b) => (a.type === 'broker_funds') === (b.type === 'broker_funds') ? 0 : a.type === 'broker_funds' ? -1 : 1);
}

// Where an added dividend goes unless the member says otherwise: where the
// holding's fund sends its dividends, else the fund itself, else the first
// account that can take it. The database works out the same when none is sent.
function defaultDestination(holding, accounts, destinations) {
  const fund = (accounts ?? []).find((a) => a.id === holding.funds_account_id);
  const target = fund?.dividends_into_account_id ?? fund?.id;
  return destinations.find((a) => a.id === target)?.id ?? destinations[0]?.id ?? '';
}

// The form's fields as the dividend has them now, as text. Only what the
// member changes is sent.
function initialForm(dividend, holding, accounts, destinations) {
  if (!dividend) {
    return {
      ex_date: '', credited_on: '', units: '', per_share: '', tax_pct: asText(holding.dividend_tax_pct),
      paid_into_account_id: defaultDestination(holding, accounts, destinations), received_gross: '', received_tax: '', received_fees: '',
    };
  }
  const received = dividend.status === 'received';
  return {
    ex_date: dividend.ex_date ?? '',
    // Recording starts from the pay date: left as it is, the database takes
    // the pay date itself and asks about a balance confirmed since.
    credited_on: dividend.credited_on ?? dividend.pay_date ?? '',
    units: asText(dividend.units),
    per_share: asText(dividend.per_share),
    tax_pct: asText(dividend.tax_pct),
    paid_into_account_id: dividend.paid_into_account_id ?? '',
    received_gross: received ? asText(dividend.received_gross) : '',
    received_tax: received ? asText(dividend.received_tax) : '',
    received_fees: received ? asText(dividend.received_fees) : '',
  };
}

// Which fields each change shows.
function fieldsFor(action, dividend) {
  const status = dividend?.status;
  return {
    exDate: action === 'add',
    creditedOn: action === 'record' || action === 'add' || (action === 'fix' && (status === 'received' || status === 'presumed')),
    figures: action === 'fix' || action === 'add',
    received: action === 'record' || (action === 'fix' && status === 'received'),
    destination: action === 'fix' || action === 'add',
  };
}

const NUMBER_FIELDS = ['units', 'per_share', 'tax_pct', 'received_gross', 'received_tax', 'received_fees'];

// The change to send, from what differs from how the dividend was opened (or,
// adding one, from every field given), with what is missing or not a number.
function buildChange(action, form, initial, shown, holding, addId) {
  const errors = {};
  const change = { action };
  // The dividend being added is named once, when the form opens, so a save
  // sent again after a lost answer finds the first rather than recording it
  // twice (round 2 of the outside review).
  if (action === 'add') {
    change.id = addId;
    change.holding_id = holding.id;
  }
  const given = (key) => form[key].trim() !== '' && (action === 'add' || form[key] !== initial[key]);
  const keys = [
    ...(shown.exDate ? ['ex_date'] : []),
    ...(shown.creditedOn ? ['credited_on'] : []),
    ...(shown.figures ? ['units', 'per_share', 'tax_pct'] : []),
    ...(shown.destination ? ['paid_into_account_id'] : []),
    ...(shown.received ? ['received_gross', 'received_tax', 'received_fees'] : []),
  ];
  for (const key of keys) {
    if (!given(key)) continue;
    if (NUMBER_FIELDS.includes(key)) {
      const n = Number(form[key]);
      if (!Number.isFinite(n) || n < 0) {
        errors[key] = 'Enter a number of 0 or more.';
        continue;
      }
      change[key] = n;
    } else {
      change[key] = form[key];
    }
  }
  if (action === 'add') {
    if (!change.ex_date && !change.credited_on) errors.ex_date = 'Enter the ex-date or the day it was credited.';
    if (!(change.units > 0) && !errors.units) errors.units = 'Enter the units held.';
    if (change.per_share == null && !errors.per_share) errors.per_share = 'Enter the amount per share.';
  }
  if (action === 'fix' && change.units === 0) errors.units = 'Enter the units held.';
  if (change.tax_pct > 100) errors.tax_pct = 'Enter a percentage up to 100.';
  return Object.keys(errors).length ? { errors, change: null } : { errors, change };
}

const TITLES = { record: 'Record', fix: 'Fix', skip: 'Skip', restore: 'Restore' };
const NOTES = {
  record: 'It arrived. Leave the figures blank to take what was expected.',
  skip: 'It never came: it no longer counts as earned or received.',
  restore: 'Back to earned, to record when it arrives.',
  add: 'One the feed missed, or one received before Rokda followed this share.',
};

// Records, fixes, skips, restores or adds a dividend (SHR-366). Nothing here
// works out what a change does: "Check" asks the database
// (preview_dividend), shows its answer, and "Save dividend" saves exactly the
// change that was checked, on the version and fund confirmations it was
// checked against. Any change to a field clears the check.
export default function DividendForm({ holding, dividend = null, action, accounts = [], onCancel, onSaved }) {
  const uid = useId();
  const currency = dividend?.currency ?? holding.currency;
  const destinations = useMemo(() => destinationsFor(accounts, currency), [accounts, currency]);
  const [initial] = useState(() => initialForm(dividend, holding, accounts, destinations));
  const [addId] = useState(() => (action === 'add' ? crypto.randomUUID() : null));
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [checked, setChecked] = useState(null);
  // Whether the database asked if the receipt was already in a confirmed
  // balance (the day of that confirmation, as the database read it), and the
  // member's answer: saving waits for one.
  const [asked, setAsked] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = fieldsFor(action, dividend);

  // Opening the form moves focus into it: the button that opened it is gone.
  const rootRef = useRef(null);
  useEffect(() => {
    rootRef.current?.querySelector('input, select, button')?.focus();
  }, []);

  // Counts the form's changes and checks: a check that comes back after the
  // figures changed is about figures no longer on screen, so it is dropped.
  // It used to turn Save on for them (outside review, E-01).
  const checkSeqRef = useRef(0);

  function set(key, value) {
    checkSeqRef.current += 1;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setChecked(null);
    setAsked(null);
    setAnswer(null);
    setMessage('');
  }

  async function check(given = null) {
    if (busy) return;
    const { errors: found, change } = buildChange(action, form, initial, shown, holding, addId);
    setErrors(found);
    setMessage('');
    setChecked(null);
    if (!change) return;
    const sent = given === null ? change : { ...change, already_included: given };
    setBusy(true);
    const mine = (checkSeqRef.current += 1);
    const { data, error } = await supabase.rpc('preview_dividend', { p_dividend_id: dividend?.id ?? null, p_change: sent });
    setBusy(false);
    if (mine !== checkSeqRef.current) return;
    if (error) {
      setMessage(`Couldn't check this dividend: ${error.message}. Nothing was saved.`);
      return;
    }
    if (!data?.ok) {
      setMessage(dividendRefusalMessage(data?.error));
      return;
    }
    if (given === null) {
      setAsked(data.asks === 'already_included' ? (data.asks_confirmed_on ?? '') : null);
      setAnswer(null);
    }
    setChecked({ change: sent, data });
  }

  function choose(value) {
    setAnswer(value);
    check(value);
  }

  async function save() {
    if (!checked || busy || (asked !== null && answer === null)) return;
    // Stays busy after a save that worked, until the screen has reloaded and
    // closed the form.
    setBusy(true);
    const { data, error } = await supabase.rpc('save_dividend', {
      p_dividend_id: dividend?.id ?? null,
      p_change: checked.change,
      p_expected_version: checked.data.version,
      p_expected_confirmations: checked.data.confirmations,
    });
    if (error || !data?.ok) {
      setBusy(false);
      // The form keeps what was typed; checking again reads the dividend and
      // the funds afresh.
      setChecked(null);
      setAsked(null);
      setAnswer(null);
      setMessage(error ? `Couldn't save this dividend: ${error.message}. Nothing was saved.` : dividendRefusalMessage(data?.error));
      return;
    }
    await onSaved();
  }

  // This form sits inside the holding editor's own form. Enter in one of its
  // fields must check the change, never submit (save) the holding around it.
  function onKeyDown(e) {
    if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && e.target.type !== 'radio') {
      e.preventDefault();
      check();
    }
  }

  const field = (key) => `${uid}-${key}`;
  const day = dividend ? (dividend.ex_date ?? dividend.credited_on) : null;
  const title = action === 'add' ? 'Add a dividend' : `${TITLES[action]} the ${day ? shortDate(day) : 'undated'} dividend`;
  const result = checked?.data.dividend;
  const net = result ? (result.status === 'received' ? result.received_net : result.expected_net) : null;
  const confirmedOn = asked ? shortDate(asked) : 'its last confirmation';
  const expected = (key) => (dividend ? `${money2(dividend[`expected_${key}`])} expected` : undefined);

  const input = (key, label, { type = 'number', span = false, placeholder } = {}) => (
    <div className={`te-fieldcell${span ? ' te-span2' : ''}`}>
      <label className="te-fieldlabel" htmlFor={field(key)}>
        {label}
      </label>
      <input
        id={field(key)}
        className="te-fieldvalue"
        type={type}
        step={type === 'number' ? 'any' : undefined}
        min={type === 'number' ? '0' : undefined}
        inputMode={type === 'number' ? 'decimal' : undefined}
        max={type === 'date' ? householdToday() : undefined}
        placeholder={placeholder}
        value={form[key]}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `${field(key)}-error` : undefined}
        onChange={(e) => set(key, e.target.value)}
      />
      {errors[key] && (
        <span className="ov-warn ht-error" id={`${field(key)}-error`}>
          {errors[key]}
        </span>
      )}
    </div>
  );

  return (
    <div className="ht-form" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="te-fieldlabel">{title}</div>
      {NOTES[action] && (
        <p className="ov-muted" style={{ fontSize: 12.5, margin: 0 }}>
          {NOTES[action]}
        </p>
      )}

      {(shown.exDate || shown.creditedOn || shown.figures || shown.received || shown.destination) && (
        <div className="te-fieldgrid">
          {shown.exDate && input('ex_date', 'Ex-date', { type: 'date' })}
          {shown.creditedOn && input('credited_on', action === 'add' ? 'Credited on (blank if not yet)' : 'Credited on', { type: 'date' })}
          {shown.figures && input('units', 'Units held on the ex-date')}
          {shown.figures && input('per_share', `Amount per share (${currency})`)}
          {shown.figures && input('tax_pct', 'Withholding (%)')}
          {shown.received && input('received_gross', `Received before tax (${currency})`, { placeholder: expected('gross') })}
          {shown.received && input('received_tax', `Tax withheld (${currency})`, { placeholder: expected('tax') })}
          {shown.received && input('received_fees', `Fees (${currency})`, { placeholder: expected('fees') })}
          {shown.destination && (
            <div className="te-fieldcell te-span2">
              <label className="te-fieldlabel" htmlFor={field('paid_into_account_id')}>
                Paid into
              </label>
              <select id={field('paid_into_account_id')} className="te-fieldvalue" value={form.paid_into_account_id} onChange={(e) => set('paid_into_account_id', e.target.value)}>
                {destinations.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {message && (
        <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
          {message}
        </p>
      )}

      {/* The region is there before the preview, so a screen reader hears
          the preview arrive rather than missing a region born with it. */}
      <div aria-live="polite">
        {checked && (
          <div className="ht-preview">
            {net != null && action !== 'skip' && action !== 'restore' && <div>{`Net ${currency} ${money2(net)}`}</div>}
            {movementLines(checked.data.movements).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
      </div>

      {asked !== null && (
        <fieldset className="hd-question">
          <legend className="te-fieldlabel">Was it already in the fund&rsquo;s confirmed balance?</legend>
          <label className="hd-choice">
            <input type="radio" name={field('included')} checked={answer === true} disabled={busy} onChange={() => choose(true)} />
            {`Already in the balance confirmed on ${confirmedOn}`}
          </label>
          <label className="hd-choice">
            <input type="radio" name={field('included')} checked={answer === false} disabled={busy} onChange={() => choose(false)} />
            Arrived after it
          </label>
        </fieldset>
      )}

      <div className="ht-form-actions">
        {/* Not "Cancel": the holding editor around this form has its own. */}
        <button type="button" className="om-btn" onClick={onCancel} disabled={busy}>
          Back to dividends
        </button>
        <button type="button" className="om-btn" onClick={() => check()} disabled={busy}>
          Check
        </button>
        <button type="button" className="om-btn ov-btn-primary" onClick={save} disabled={busy || !checked || (asked !== null && answer === null)}>
          Save dividend
        </button>
      </div>
    </div>
  );
}
