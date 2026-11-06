import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { householdToday } from '../../lib/day';
import { taxRefusalMessage } from '../../lib/dividendTax';
import { parseAmount, revisionLabel } from '../../lib/dividendTaxText';

const FIGURES = [
  ['dividend_income', 'Dividend income'],
  ['dividend_tax', 'Dividend tax'],
  ['dividend_tds_claimed', 'Tax credit claimed on dividends'],
  ['tds_claimed_total', 'Tax credit claimed in all'],
];
const BASES = [
  ['', 'Not set'],
  ['domestic', 'Domestic rate'],
  ['treaty', 'Treaty rate'],
  ['manual', 'Another rate'],
];
const AMOUNT_HINT = 'Enter an amount, like 1000.50';
const asText = (v) => (v == null ? '' : String(Number(v)));

function formOf(taxReturn) {
  const r = taxReturn ?? {};
  return {
    claim_basis: r.claim_basis ?? '', claim_rate_pct: asText(r.claim_rate_pct), revision: String(r.revision ?? 0), filed_on: r.filed_on ?? '',
    ...Object.fromEntries(FIGURES.map(([key]) => [key, asText(r[key])])), note: r.note ?? '',
  };
}

// What changed, as save_tax_return takes it, or the fields' errors. An
// unfiled return carries no filing date or figures, so choosing "Not filed"
// clears them.
function buildChange(form, initial) {
  const errors = {};
  const change = {};
  const unfiled = Number(form.revision) === 0;
  const now = unfiled ? { ...form, filed_on: '', ...Object.fromEntries(FIGURES.map(([key]) => [key, ''])) } : form;
  if (now.claim_basis !== initial.claim_basis || now.claim_rate_pct !== initial.claim_rate_pct) {
    const rate = parseAmount(now.claim_rate_pct);
    if (Number.isNaN(rate)) errors.claim_rate_pct = 'Enter a rate, like 10';
    change.claim_basis = now.claim_basis || null;
    change.claim_rate_pct = rate;
  }
  if (now.revision !== initial.revision) change.revision = Number(now.revision);
  if (now.filed_on !== initial.filed_on) change.filed_on = now.filed_on || null;
  for (const [key] of FIGURES) {
    if (now[key] === initial[key]) continue;
    const value = parseAmount(now[key]);
    if (Number.isNaN(value)) errors[key] = AMOUNT_HINT;
    change[key] = value;
  }
  if (now.note !== initial.note) change.note = now.note.trim() || null;
  return { errors, change: Object.keys(errors).length ? null : change };
}

// A member's return for a tax year (dividend tax years): its claim basis,
// whether and when it was filed, and its dividend figures. Saved through
// save_tax_return at the version it was opened on; a refusal keeps what was
// typed.
export default function TaxReturnForm({ memberId, year, taxReturn, onSaved, onCancel }) {
  const uid = useId();
  const firstRef = useRef(null);
  const initial = formOf(taxReturn);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (key) => `${uid}-${key}`;
  const filed = Number(form.revision) > 0;
  const revisions = Array.from({ length: Math.max(2, Number(taxReturn?.revision ?? 0) + 1) + 1 }, (_, n) => n);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    if (busy) return;
    const { errors: found, change } = buildChange(form, initial);
    setErrors(found);
    setMessage('');
    if (!change) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('save_tax_return', {
      p_member_id: memberId, p_financial_year: year, p_change: change, p_expected_version: taxReturn?.version ?? 0,
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

  const input = (key, label, { type = 'text', span = false } = {}) => (
    <div className={`te-fieldcell${span ? ' te-span2' : ''}`}>
      <label className="te-fieldlabel" htmlFor={field(key)}>
        {label}
      </label>
      <input
        id={field(key)}
        className="te-fieldvalue"
        type={type}
        inputMode={type === 'text' && key !== 'note' ? 'decimal' : undefined}
        max={type === 'date' ? householdToday() : undefined}
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
    <div className="ht-form" onKeyDown={onKeyDown}>
      <div className="te-fieldgrid">
        <div className="te-fieldcell">
          <label className="te-fieldlabel" htmlFor={field('claim_basis')}>
            Claim basis
          </label>
          <select id={field('claim_basis')} ref={firstRef} className="te-fieldvalue" value={form.claim_basis} aria-describedby={`${field('claim_basis')}-hint`}
            onChange={(e) => set('claim_basis', e.target.value)}>
            {BASES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {input('claim_rate_pct', 'Rate (%)')}
        <p className="ov-muted te-span2 tx-hint" id={`${field('claim_basis')}-hint`}>
          {"The rate on gross dividends you'll claim at for this year. A treaty rate needs the residence and documents the treaty asks for."}
        </p>
        <div className="te-fieldcell">
          <label className="te-fieldlabel" htmlFor={field('revision')}>
            Return
          </label>
          <select id={field('revision')} className="te-fieldvalue" value={form.revision} onChange={(e) => set('revision', e.target.value)}>
            {revisions.map((n) => (
              <option key={n} value={String(n)}>
                {revisionLabel(n)}
              </option>
            ))}
          </select>
        </div>
        {filed && input('filed_on', 'Filed on', { type: 'date' })}
        {filed && FIGURES.map(([key, label]) => <Fragment key={key}>{input(key, label)}</Fragment>)}
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
          Save return
        </button>
      </div>
    </div>
  );
}
