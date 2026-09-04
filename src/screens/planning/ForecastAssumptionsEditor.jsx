import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function ForecastAssumptionsEditor({ householdId, assumptions, currentMonthlySaving, onClose, onSaved }) {
  const [nominal, setNominal] = useState(assumptions?.nominal_return_pct != null ? String(assumptions.nominal_return_pct) : '6.0');
  const [inflation, setInflation] = useState(assumptions?.inflation_pct != null ? String(assumptions.inflation_pct) : '2.5');
  const [swr, setSwr] = useState(assumptions?.safe_withdrawal_pct != null ? String(assumptions.safe_withdrawal_pct) : '4.0');
  const [leanSpend, setLeanSpend] = useState(assumptions?.lean_annual_spend != null ? String(assumptions.lean_annual_spend) : '');
  const [dirty, setDirty] = useState(false);
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

  function set(setter) {
    return (e) => {
      setter(e.target.value);
      setDirty(true);
    };
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const payload = {
      household_id: householdId,
      nominal_return_pct: Number(nominal) || 0,
      inflation_pct: Number(inflation) || 0,
      safe_withdrawal_pct: Number(swr) || 0,
      lean_annual_spend: leanSpend === '' ? null : Number(leanSpend),
      updated_at: new Date().toISOString(),
    };

    if (!hasBaseline) {
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

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label="Forecast assumptions">
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">Assumptions</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">Forecast assumptions</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div className="te-fieldgrid">
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Investment return (nominal %/yr)</span>
              <input className="te-fieldvalue" type="number" step="0.1" value={nominal} onChange={set(setNominal)} />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Inflation (%/yr)</span>
              <input className="te-fieldvalue" type="number" step="0.1" value={inflation} onChange={set(setInflation)} />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Safe withdrawal rate (%/yr)</span>
              <input className="te-fieldvalue" type="number" step="0.1" value={swr} onChange={set(setSwr)} />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Essentials-only annual spend</span>
              <input className="te-fieldvalue" type="number" step="0.01" value={leanSpend} onChange={set(setLeanSpend)} placeholder="optional" />
            </div>
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            The independence target is annual spend ÷ safe withdrawal rate — 4% is the common default (25× spend). Essentials-only
            spend is optional; set it to see a "lean" target next to the full one.
          </div>

          {!hasBaseline && (
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
