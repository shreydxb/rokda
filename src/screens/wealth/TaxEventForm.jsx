import { useEffect, useId, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { householdToday } from '../../lib/day';
import { taxRefusalMessage } from '../../lib/dividendTax';
import { parseAmount, revisionLabel } from '../../lib/dividendTaxText';

const KINDS = [
  ['processed', 'Processed (intimation)'],
  ['refund_credited', 'Refund credited'],
  ['offset_against_demand', 'Set against a demand'],
  ['refund_failed', 'Refund failed'],
];
// The figures each kind takes, with their labels. A demand is the one
// figure below zero.
const FIGURES = {
  processed: [
    ['refund_determined', 'Refund determined', 'A demand as a negative amount.'],
    ['refund_interest', 'Interest'],
    ['tds_allowed_total', 'Tax credit allowed in all'],
  ],
  refund_credited: [['amount', 'Amount']],
  offset_against_demand: [['amount', 'Amount']],
  refund_failed: [['amount', 'Amount (if known)']],
};
const AMOUNT_HINT = 'Enter an amount, like 1000.50';
const asText = (v) => (v == null ? '' : String(Number(v)));
const longDate = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// What happened to a filed return (dividend tax years): a processing, a
// refund credited, an amount set against a demand, or a failed refund, tied
// to the return it concerns. Adds one, or with an event replaces it whole.
export default function TaxEventForm({ memberId, year, taxReturn, event, onSaved, onCancel }) {
  const uid = useId();
  const firstRef = useRef(null);
  const latest = Number(taxReturn.revision);
  const [form, setForm] = useState({
    kind: event?.kind ?? 'processed', happened_on: event?.happened_on ?? '', revision: String(event?.revision ?? latest),
    refund_determined: asText(event?.refund_determined), refund_interest: event ? asText(event.refund_interest) : '0',
    tds_allowed_total: asText(event?.tds_allowed_total), amount: asText(event?.amount), note: event?.note ?? '',
  });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (key) => `${uid}-${key}`;
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  // Nothing happens to a return before its tax year has ended.
  const yearEnded = `${year + 1}-04-01`;

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  async function save() {
    if (busy) return;
    const found = {};
    const sent = { kind: form.kind, happened_on: form.happened_on };
    for (const [key] of FIGURES[form.kind]) {
      const value = parseAmount(form[key]);
      if (Number.isNaN(value) || (value < 0 && key !== 'refund_determined')) found[key] = AMOUNT_HINT;
      else if (value != null) sent[key] = value;
    }
    // The database would refuse these with a sentence about amounts or
    // input in general; said here, they name what is missing.
    if (form.kind === 'processed' && !found.refund_determined && sent.refund_determined == null) found.refund_determined = 'Give the refund determined.';
    if ((form.kind === 'refund_credited' || form.kind === 'offset_against_demand') && !found.amount && !sent.amount) found.amount = 'Give the amount.';
    if (!form.happened_on) found.happened_on = 'Give the date it happened.';
    else if (form.happened_on < yearEnded) found.happened_on = `A date after the tax year ended, from ${longDate(yearEnded)}.`;
    sent.revision = Number(form.revision);
    if (form.note.trim()) sent.note = form.note.trim();
    setErrors(found);
    setMessage('');
    if (Object.keys(found).length) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('save_tax_return_event', {
      p_member_id: memberId, p_financial_year: year, p_event: sent, p_event_id: event?.id ?? null, p_expected_version: event?.version ?? null,
    });
    if (error || !data?.ok) {
      setBusy(false);
      setMessage(error ? `Couldn't save that: ${error.message}. Nothing was changed.` : taxRefusalMessage(data?.error));
      return;
    }
    await onSaved();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  const input = (key, label, { type = 'text', hint, span = false } = {}) => {
    const described = [errors[key] && `${field(key)}-error`, hint && `${field(key)}-hint`].filter(Boolean).join(' ') || undefined;
    return (
      <div key={key} className={`te-fieldcell${span ? ' te-span2' : ''}`}>
        <label className="te-fieldlabel" htmlFor={field(key)}>
          {label}
        </label>
        <input
          id={field(key)}
          className="te-fieldvalue"
          type={type}
          inputMode={type === 'text' && key !== 'note' ? 'decimal' : undefined}
          min={type === 'date' ? yearEnded : undefined}
          max={type === 'date' ? householdToday() : undefined}
          value={form[key]}
          aria-invalid={errors[key] ? true : undefined}
          aria-describedby={described}
          onChange={(e) => set(key, e.target.value)}
        />
        {hint && (
          <span className="ov-muted tx-hint" id={`${field(key)}-hint`}>
            {hint}
          </span>
        )}
        {errors[key] && (
          <span className="ov-warn ht-error" id={`${field(key)}-error`}>
            {errors[key]}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="ht-form" onKeyDown={onKeyDown}>
      <div className="te-fieldgrid">
        <div className="te-fieldcell">
          <label className="te-fieldlabel" htmlFor={field('kind')}>
            What happened
          </label>
          <select id={field('kind')} ref={firstRef} className="te-fieldvalue" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            {KINDS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {input('happened_on', 'Date', { type: 'date' })}
        {FIGURES[form.kind].map(([key, label, hint]) => input(key, label, { hint }))}
        {latest > 1 && (
          <div className="te-fieldcell">
            <label className="te-fieldlabel" htmlFor={field('revision')}>
              For
            </label>
            <select id={field('revision')} className="te-fieldvalue" value={form.revision} onChange={(e) => set('revision', e.target.value)}>
              {Array.from({ length: latest }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>
                  {revisionLabel(n)}
                </option>
              ))}
            </select>
          </div>
        )}
        {input('note', 'Note', { span: true })}
      </div>

      {message && (
        <p className="ov-warn tx-hint" role="alert">
          {message}
        </p>
      )}

      <div className="ht-form-actions">
        <button type="button" className="om-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="om-btn ov-btn-primary" onClick={save} disabled={busy}>
          Save
        </button>
      </div>
    </div>
  );
}
