import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { householdToday } from '../../lib/day';
import { formatMoney } from '../../lib/money';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { shortDate } from '../../lib/dividends';
import { dividendsInYear, financialYearOf, taxRefusalMessage, taxYearLabel, taxYears } from '../../lib/dividendTax';
import { checkWords, eventLine, returnLines, shareLines, stageWords, unassignedWords } from '../../lib/dividendTaxText';
import TaxReturnForm from './TaxReturnForm';
import TaxEventForm from './TaxEventForm';

// What the section reads; one that never loaded is said, and the rest of the
// tab goes on without it.
const TAX_SOURCES = ['taxReturns', 'taxReturnEvents', 'taxStatements', 'taxStatementLines'];
const fmt = (n) => `INR ${formatMoney(n, { decimals: 2 })}`;
const paise = (n) => Math.round(Number(n) * 100);
const BASES = [
  ['declared', 'Declared that year (a final dividend)'],
  ['paid', 'Paid that year (an interim dividend)'],
  ['statement', 'A statement says so'],
  ['household', 'Our own reading'],
];

// The year's dividends and tax withheld, the presumed part beside.
function dividendWords(year) {
  const { confirmed, presumed } = year.rokda;
  if (confirmed.count + presumed.count === 0) return 'no Indian dividends recorded';
  const gross = (paise(confirmed.gross) + paise(presumed.gross)) / 100;
  const tax = (paise(confirmed.tax) + paise(presumed.tax)) / 100;
  let words = `dividends ${fmt(gross)}, tax withheld ${fmt(tax)}`;
  if (presumed.count) words += ` (${fmt(presumed.tax)} of it presumed)`;
  return year.provisional ? `${words}, provisional` : words;
}

// Wealth → Dividends → Tax years (dividend tax years, spec section 6): each
// member's Indian dividends by tax year, in rupees, checked against the AIS
// and Form 26AS, with the return and what became of its refund. The figures
// come from src/lib/dividendTax.js, the words from dividendTaxText.js.
export default function TaxYears({ members, scopeMemberId, data }) {
  const [opened, setOpened] = useState(null);
  const missing = neverLoaded(data, TAX_SOURCES);
  const { years, unassigned } = useMemo(
    () => taxYears({
      holdings: data.holdings ?? [], dividends: data.holdingDividends ?? [], statements: data.taxStatements ?? [], lines: data.taxStatementLines ?? [],
      returns: data.taxReturns ?? [], events: data.taxReturnEvents ?? [],
    }),
    [data.holdings, data.holdingDividends, data.taxStatements, data.taxStatementLines, data.taxReturns, data.taxReturnEvents],
  );
  const shown = scopeMemberId ? years.filter((y) => y.memberId === scopeMemberId) : years;
  if (!missing.length && shown.length === 0 && unassigned.length === 0) return null;
  const nameOf = (id) => members.find((m) => m.id === id)?.display_name ?? 'A member';
  const shared = unassignedWords(unassigned);

  return (
    <section className="dv-section" aria-labelledby="dv-tax">
      <h3 className="ov-kicker dv-title" id="dv-tax">
        Tax years
      </h3>
      {missing.length ? (
        <p className="ov-warn dv-note" role="alert">
          {couldntLoad(missing)} Refresh the page to try again.
        </p>
      ) : (
        <>
          <p className="ov-muted dv-note">Indian dividends by tax year, checked against the AIS (income) and Form 26AS (tax credit). In rupees.</p>
          <ul className="ht-list">
            {shown.map((y) => {
              const key = `${y.memberId}-${y.year}`;
              const isOpen = opened === key;
              return (
                <li key={key} className="ht-row hd-row">
                  <button type="button" className="dv-rowbutton" aria-expanded={isOpen} onClick={() => setOpened(isOpen ? null : key)}>
                    <span className="mn-row-main">
                      <span className="dv-name">{scopeMemberId ? y.label : `${y.label} · ${nameOf(y.memberId)}`}</span>
                      <span className="ov-muted dv-detail">{[dividendWords(y), checkWords(y), stageWords(y, fmt)].join(' · ')}</span>
                    </span>
                  </button>
                  {isOpen && <YearDetail year={y} data={data} />}
                </li>
              );
            })}
          </ul>
          {shared && <p className="ov-muted dv-note dv-gap">{shared}</p>}
          <p className="ov-muted dv-note">{"A holding's dividends count for its owner today: changing its owner moves them."}</p>
        </>
      )}
    </section>
  );
}

function YearDetail({ year, data }) {
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [refusal, setRefusal] = useState(null);
  // Focus goes back where it came from: to the button that opened a form,
  // or, from the remove question, to "Keep it" and then back to Remove.
  const buttonsRef = useRef({});
  const returnToRef = useRef(null);
  const focusNextRef = useFocusAfterRender(buttonsRef);
  const taxReturn = year.taxReturn;
  const filed = Number(taxReturn?.revision ?? 0) >= 1;
  const events = (data.taxReturnEvents ?? []).filter((e) => e.return_id === taxReturn?.id);
  const interest = events.some((e) => e.kind === 'processed' && Number(e.refund_interest) > 0);

  const open = (value, key) => {
    returnToRef.current = key;
    setEditing(value);
  };
  const close = () => {
    focusNextRef.current = returnToRef.current;
    setEditing(null);
  };
  async function saved() {
    await data.reload();
    close();
  }

  async function remove(event) {
    setRefusal(null);
    const { data: result, error } = await supabase.rpc('remove_tax_return_event', { p_member_id: year.memberId, p_event_id: event.id, p_expected_version: event.version });
    setRemoving(null);
    focusNextRef.current = 'add';
    if (error || !result?.ok) {
      setRefusal({ id: event.id, message: error ? `Couldn't remove that: ${error.message}. Nothing was changed.` : taxRefusalMessage(result?.error) });
      return;
    }
    await data.reload();
  }

  return (
    <div className="tx-detail">
      {year.shares.length > 0 && (
        <>
          <h4 className="te-fieldlabel tx-subtitle">Shares</h4>
          <ul className="ht-list">
            {year.shares.map((s) => {
              const lines = shareLines(s, fmt);
              const own = dividendsInYear({ holdings: data.holdings, dividends: data.holdingDividends, memberId: year.memberId, year: year.year, key: s.key });
              return (
                <li key={s.key} className="ht-row hd-row">
                  <div className="mn-row-main">
                    <div className="dv-name">{s.name}</div>
                    <div className="ov-muted dv-detail">{lines.income}</div>
                    <div className="ov-muted dv-detail">{lines.tax}</div>
                  </div>
                  {own.length > 0 && (
                    <details className="dv-fold">
                      <summary>{`Dividends (${own.length})`}</summary>
                      <ul className="ht-list">
                        {own.map((d) => (
                          <DividendYearRow key={d.id} dividend={d} onSaved={data.reload} />
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h4 className="te-fieldlabel tx-subtitle">Return</h4>
      {editing === 'return' ? (
        <TaxReturnForm memberId={year.memberId} year={year.year} taxReturn={taxReturn} onSaved={saved} onCancel={close} />
      ) : (
        <div className="tx-lines">
          {returnLines(taxReturn, fmt).map((line) => (
            <div key={line} className="ov-muted dv-detail">
              {line}
            </div>
          ))}
          <div className="ht-actions hd-actions">
            <button type="button" className="om-btn" ref={(el) => (buttonsRef.current.return = el)} onClick={() => open('return', 'return')}>
              {taxReturn ? 'Edit' : 'Set claim basis'}
            </button>
          </div>
        </div>
      )}

      {filed && (
        <>
          <h4 className="te-fieldlabel tx-subtitle">What happened to the refund</h4>
          {events.length > 0 && (
            <ul className="ht-list">
              {events.map((ev) => (
                <li key={ev.id} className="ht-row hd-row">
                  {editing === ev.id ? (
                    <TaxEventForm memberId={year.memberId} year={year.year} taxReturn={taxReturn} event={ev} onSaved={saved} onCancel={close} />
                  ) : (
                    <>
                      <div className="mn-row-main">{eventLine(ev, taxReturn, fmt)}</div>
                      {refusal?.id === ev.id && (
                        <p className="ov-warn tx-hint" role="alert">
                          {refusal.message}
                        </p>
                      )}
                      {removing === ev.id ? (
                        <div className="ht-actions hd-actions">
                          <span className="tx-hint">Remove this record?</span>
                          <button
                            type="button"
                            className="om-btn"
                            ref={(el) => (buttonsRef.current[`keep-${ev.id}`] = el)}
                            onClick={() => {
                              focusNextRef.current = `remove-${ev.id}`;
                              setRemoving(null);
                            }}
                          >
                            Keep it
                          </button>
                          <button type="button" className="om-btn te-delete" onClick={() => remove(ev)}>
                            Remove
                          </button>
                        </div>
                      ) : (
                        <div className="ht-actions hd-actions">
                          <button type="button" className="om-btn" ref={(el) => (buttonsRef.current[`fix-${ev.id}`] = el)} onClick={() => open(ev.id, `fix-${ev.id}`)}>
                            Fix
                          </button>
                          <button
                            type="button"
                            className="om-btn"
                            ref={(el) => (buttonsRef.current[`remove-${ev.id}`] = el)}
                            onClick={() => {
                              focusNextRef.current = `keep-${ev.id}`;
                              setRemoving(ev.id);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editing === 'add' ? (
            <TaxEventForm memberId={year.memberId} year={year.year} taxReturn={taxReturn} event={null} onSaved={saved} onCancel={close} />
          ) : (
            <div className="ht-actions hd-actions">
              <button type="button" className="om-btn" ref={(el) => (buttonsRef.current.add = el)} onClick={() => open('add', 'add')}>
                Add
              </button>
            </div>
          )}
          {interest && <p className="ov-muted tx-hint">{"Refund interest is income of the year it arrives: include it in that year's return."}</p>}
        </>
      )}
    </div>
  );
}

// One dividend counted in the year, and where its year can be set: a final
// dividend declared in March and paid in April belongs to the March year.
function DividendYearRow({ dividend, onSaved }) {
  const received = dividend.status === 'received';
  const creditYear = financialYearOf(dividend.credited_on);
  const latest = financialYearOf(householdToday());
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const buttonsRef = useRef({});
  const focusNextRef = useFocusAfterRender(buttonsRef);
  const own = dividend.tax_financial_year;
  const close = () => {
    focusNextRef.current = 'set';
    setForm(null);
  };
  let line = `${shortDate(dividend.credited_on)} · ${fmt(received ? dividend.received_gross : dividend.expected_gross)}, tax ${fmt(received ? dividend.received_tax : dividend.expected_tax)} · ${received ? 'Received' : 'Presumed'}`;
  if (own != null) line += ` · counted in ${taxYearLabel(own)}`;

  async function save(year, basis) {
    setBusy(true);
    setMessage('');
    const { data, error } = await supabase.rpc('set_dividend_tax_year', {
      p_dividend_id: dividend.id, p_financial_year: year, p_basis: basis, p_expected_version: form.version,
    });
    setBusy(false);
    if (error || !data?.ok) {
      setMessage(error ? `Couldn't save that: ${error.message}. Nothing was changed.` : taxRefusalMessage(data?.error));
      return;
    }
    close();
    await onSaved();
  }

  return (
    <li className="ht-row hd-row">
      <div className="mn-row-main ov-muted dv-detail">{line}</div>
      {form ? (
        <div className="ht-form">
          <div className="te-fieldgrid">
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor={`${dividend.id}-year`}>
                Tax year
              </label>
              <select id={`${dividend.id}-year`} ref={(el) => (buttonsRef.current.year = el)} className="te-fieldvalue" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })}>
                {[creditYear - 1, creditYear, creditYear + 1].filter((y) => y <= latest).map((y) => (
                  <option key={y} value={String(y)}>
                    {taxYearLabel(y)}
                  </option>
                ))}
              </select>
            </div>
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor={`${dividend.id}-basis`}>
                Why
              </label>
              <select id={`${dividend.id}-basis`} className="te-fieldvalue" value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value })}>
                {BASES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {message && (
            <p className="ov-warn tx-hint" role="alert">
              {message}
            </p>
          )}
          <div className="ht-form-actions">
            <button type="button" className="om-btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            {own != null && (
              <button type="button" className="om-btn" onClick={() => save(null, null)} disabled={busy}>
                {"Use the credit date's year"}
              </button>
            )}
            <button type="button" className="om-btn ov-btn-primary" onClick={() => save(Number(form.year), form.basis)} disabled={busy}>
              Save tax year
            </button>
          </div>
        </div>
      ) : (
        <div className="ht-actions hd-actions">
          <button
            type="button"
            className="om-btn"
            ref={(el) => (buttonsRef.current.set = el)}
            onClick={() => {
              focusNextRef.current = 'year';
              // The version as opened: a refresh while the form is open
              // brings a partner's change, which a save must not overwrite
              // (the fresh review of round 2; E2-1 for refund records).
              setForm({ year: String(own ?? creditYear), basis: dividend.tax_year_basis ?? 'declared', version: dividend.version });
            }}
          >
            Set tax year
          </button>
        </div>
      )}
    </li>
  );
}

// Moves focus, after the next render, to the control named in the returned
// ref (one of buttonsRef.current's keys): a control that was just mounted, so it
// can't be focused before React has drawn it.
function useFocusAfterRender(buttonsRef) {
  const focusNextRef = useRef(null);
  useLayoutEffect(() => {
    const key = focusNextRef.current;
    if (key && buttonsRef.current[key]) {
      buttonsRef.current[key].focus();
      focusNextRef.current = null;
    }
  });
  return focusNextRef;
}
