import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function ForecastAssumptionsEditor({ householdId, assumptions, currentMonthlySaving, onClose, onSaved }) {
  const [nominal, setNominal] = useState(assumptions?.nominal_return_pct != null ? String(assumptions.nominal_return_pct) : '6.0');
  const [inflation, setInflation] = useState(assumptions?.inflation_pct != null ? String(assumptions.inflation_pct) : '2.5');
  const [swr, setSwr] = useState(assumptions?.safe_withdrawal_pct != null ? String(assumptions.safe_withdrawal_pct) : '4.0');
  const [leanSpend, setLeanSpend] = useState(assumptions?.lean_annual_spend != null ? String(assumptions.lean_annual_spend) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const hasBaseline = !!assumptions?.baseline_set_at;

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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label="Forecast assumptions">
        <div className="te-head">
          <div className="ov-kicker">Forecast assumptions</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div className="te-row">
            <label className="te-field te-amount">
              <span>Investment return (nominal %/yr)</span>
              <input type="number" step="0.1" value={nominal} onChange={(e) => setNominal(e.target.value)} />
            </label>
            <label className="te-field te-currency">
              <span>Inflation (%/yr)</span>
              <input type="number" step="0.1" value={inflation} onChange={(e) => setInflation(e.target.value)} />
            </label>
          </div>

          <label className="te-field">
            <span>Safe withdrawal rate (%/yr)</span>
            <input type="number" step="0.1" value={swr} onChange={(e) => setSwr(e.target.value)} />
          </label>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -8 }}>
            The independence target is annual spend ÷ this rate — 4% is the common default (25× spend).
          </div>

          <label className="te-field">
            <span>Essentials-only annual spend</span>
            <input type="number" step="0.01" value={leanSpend} onChange={(e) => setLeanSpend(e.target.value)} placeholder="optional — for a lean number" />
          </label>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -8 }}>
            Optional. Set it to see a "lean" target next to the full one — travel and discretionary spend stripped out.
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

          <div className="te-actions">
            <div className="te-actions-right" style={{ marginLeft: 'auto' }}>
              <button type="button" className="om-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
