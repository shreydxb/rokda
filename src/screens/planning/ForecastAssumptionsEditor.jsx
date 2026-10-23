import { useEffect, useId, useRef, useState } from 'react';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

// What a blank field saves. Never 0: a 0% return or 0% inflation is an answer
// someone has to type, not what an emptied box should quietly become. Baseline's
// columns always hold a number, so a blank there is the default its placeholder
// names; a blank on Custom saves nothing, and that figure follows Baseline.
const DEFAULTS = { nominal: 6.0, inflation: 2.5, swr: 4.0 };

// The limits the database enforces (planning_assumptions_*_range), the same
// return range as the life plan's after work, and inflation's as a goal's rise.
const LIMITS = {
  nominal: { min: -20, max: 50, message: 'A return between −20% and 50%.' },
  inflation: { min: -10, max: 30, message: 'Inflation between −10% and 30%.' },
  swr: { min: 1, max: 10, message: 'A withdrawal rate between 1% and 10%.' },
};
const FIELDS = ['nominal', 'inflation', 'swr', 'lean'];

const str = (v) => (v == null ? '' : String(Number(v)));
const blank = (v) => String(v).trim() === '';

export default function ForecastAssumptionsEditor({ householdId, assumptions, currentMonthlySaving, scenario = 'baseline', onClose, onSaved }) {
  const drawerRef = useDrawerFocus();
  const isCustom = scenario === 'custom';
  const uid = useId();
  const fieldRefs = useRef({});
  // Baseline's figures, which a blank on Custom follows.
  const baseline = {
    nominal: assumptions?.nominal_return_pct != null ? Number(assumptions.nominal_return_pct) : DEFAULTS.nominal,
    inflation: assumptions?.inflation_pct != null ? Number(assumptions.inflation_pct) : DEFAULTS.inflation,
    swr: assumptions?.safe_withdrawal_pct != null ? Number(assumptions.safe_withdrawal_pct) : DEFAULTS.swr,
  };
  // Custom starts from Baseline's figures the first time. Once saved, a figure
  // saved blank opens blank again, so saving it again doesn't pin it.
  const customSaved = assumptions?.custom_updated_at != null;
  const customValue = (column, key) => str(customSaved ? assumptions[column] : baseline[key]);
  const [form, setForm] = useState(() =>
    isCustom
      ? {
          nominal: customValue('custom_nominal_return_pct', 'nominal'),
          inflation: customValue('custom_inflation_pct', 'inflation'),
          swr: customValue('custom_safe_withdrawal_pct', 'swr'),
          lean: '',
        }
      : { nominal: str(baseline.nominal), inflation: str(baseline.inflation), swr: str(baseline.swr), lean: str(assumptions?.lean_annual_spend) },
  );
  const [dirty, setDirty] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const hasBaseline = !!assumptions?.baseline_set_at;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirmingClose]);

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  function set(key) {
    return (e) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      setDirty(true);
    };
  }

  function rangeProblem(key) {
    if (blank(form[key])) return '';
    const n = Number(form[key]);
    const { min, max, message } = LIMITS[key];
    return Number.isFinite(n) && n >= min && n <= max ? '' : message;
  }
  // Each field carries its own message once a save has been tried, and the
  // message follows the field as it is corrected.
  const fieldProblems = {
    nominal: rangeProblem('nominal'),
    inflation: rangeProblem('inflation'),
    swr: rangeProblem('swr'),
    lean: !isCustom && !blank(form.lean) && !(Number.isFinite(Number(form.lean)) && Number(form.lean) > 0) ? 'Essentials-only spend is an amount above zero.' : '',
  };
  const invalid = (key) => (triedSave && fieldProblems[key] ? { 'aria-invalid': true, 'aria-describedby': `${uid}-${key}-problem` } : { 'aria-invalid': false });
  const problemText = (key) =>
    triedSave &&
    fieldProblems[key] && (
      <span className="te-fieldproblem" id={`${uid}-${key}-problem`}>
        {fieldProblems[key]}
      </span>
    );
  const value = (key) => (blank(form[key]) ? (isCustom ? null : DEFAULTS[key]) : Number(form[key]));
  const placeholder = (key) => (isCustom ? `blank: Baseline's ${baseline[key].toFixed(1)}` : `blank: ${DEFAULTS[key].toFixed(1)}`);

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    const firstProblem = FIELDS.find((key) => fieldProblems[key]);
    if (firstProblem) {
      setTriedSave(true);
      setError('Fix the marked field to save.');
      fieldRefs.current[firstProblem]?.focus();
      return;
    }
    setSaving(true);
    setError('');

    const payload = isCustom
      ? {
          household_id: householdId,
          custom_nominal_return_pct: value('nominal'),
          custom_inflation_pct: value('inflation'),
          custom_safe_withdrawal_pct: value('swr'),
          custom_updated_at: new Date().toISOString(),
        }
      : {
          household_id: householdId,
          nominal_return_pct: value('nominal'),
          inflation_pct: value('inflation'),
          safe_withdrawal_pct: value('swr'),
          lean_annual_spend: blank(form.lean) ? null : Number(form.lean),
          updated_at: new Date().toISOString(),
        };

    if (!isCustom && !hasBaseline) {
      payload.baseline_set_at = new Date().toISOString();
      payload.baseline_nominal_return_pct = payload.nominal_return_pct;
      payload.baseline_inflation_pct = payload.inflation_pct;
      payload.baseline_monthly_saving = currentMonthlySaving;
    }

    const { error: saveError } = await supabase.from('planning_assumptions').upsert(payload, { onConflict: 'household_id' });
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  const field = (key, label, aria, props = {}) => (
    <div className="te-fieldcell">
      <label className="te-fieldlabel" htmlFor={`${uid}-${key}`}>
        {label}
      </label>
      <input
        id={`${uid}-${key}`}
        ref={(el) => {
          fieldRefs.current[key] = el;
        }}
        className="te-fieldvalue"
        type="number"
        step="0.1"
        value={form[key]}
        onChange={set(key)}
        placeholder={placeholder(key)}
        aria-label={aria}
        {...props}
        {...invalid(key)}
      />
      {problemText(key)}
    </div>
  );

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Forecast assumptions">
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{isCustom ? 'Custom scenario' : 'Assumptions'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{isCustom ? 'Custom scenario assumptions' : 'Forecast assumptions'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave} noValidate>
          <div className="te-fieldgrid">
            {field('nominal', 'Return (%/yr)', 'Investment return, nominal percent a year', { min: LIMITS.nominal.min, max: LIMITS.nominal.max })}
            {field('inflation', 'Inflation (%/yr)', 'Inflation, percent a year', { min: LIMITS.inflation.min, max: LIMITS.inflation.max })}
            {field('swr', 'Safe withdrawal rate (%/yr)', 'Safe withdrawal rate, percent a year', { min: LIMITS.swr.min, max: LIMITS.swr.max })}
            {!isCustom && (
              <div className="te-fieldcell">
                <label className="te-fieldlabel" htmlFor={`${uid}-lean`}>
                  Essentials-only annual spend
                </label>
                <input
                  id={`${uid}-lean`}
                  ref={(el) => {
                    fieldRefs.current.lean = el;
                  }}
                  className="te-fieldvalue"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.lean}
                  onChange={set('lean')}
                  placeholder="optional"
                  aria-label="Essentials-only annual spend"
                  {...invalid('lean')}
                />
                {problemText('lean')}
              </div>
            )}
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            {isCustom
              ? 'These numbers apply only while the Custom scenario is selected — Baseline and its saved plan are untouched. A field left blank follows Baseline. The return is before inflation.'
              : 'The return is before inflation. The independence target is annual spend ÷ safe withdrawal rate — 4% is the common default (25× spend). Essentials-only spend is optional; set it to see a "lean" target next to the full one.'}
          </div>

          {!isCustom && !hasBaseline && (
            <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
              This is the first time assumptions are being saved — these numbers become the baseline everything else is compared
              against. Editing again later won't move the baseline.
            </div>
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              <div className="te-actions-right" style={{ marginLeft: 'auto' }}>
                {confirmingClose ? (
                  <>
                    <span className="ov-muted" style={{ marginRight: 8 }}>
                      Discard changes?
                    </span>
                    <button type="button" className="om-btn" onClick={onClose}>
                      Discard
                    </button>
                    <button type="button" className="om-btn" onClick={() => setConfirmingClose(false)}>
                      Keep editing
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="om-btn" onClick={requestClose}>
                      Cancel
                    </button>
                    <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                      {saving ? 'Saving…' : 'Save changes'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
