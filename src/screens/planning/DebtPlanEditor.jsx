import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function DebtPlanEditor({ householdId, assumptions, onClose, onSaved }) {
  const [extraPayment, setExtraPayment] = useState(assumptions?.debt_extra_payment != null ? String(assumptions.debt_extra_payment) : '');
  const [cardUsage, setCardUsage] = useState(
    assumptions?.debt_assume_no_new_card_spend === true ? 'no' : assumptions?.debt_assume_no_new_card_spend === false ? 'yes' : ''
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const payload = {
      household_id: householdId,
      debt_extra_payment: extraPayment === '' ? null : Number(extraPayment),
      debt_assume_no_new_card_spend: cardUsage === '' ? null : cardUsage === 'no',
      updated_at: new Date().toISOString(),
    };

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
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label="Debt payoff inputs">
        <div className="te-head">
          <div className="ov-kicker">Debt payoff inputs</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <label className="te-field">
            <span>Committed extra payment (AED / mo)</span>
            <input type="number" step="0.01" value={extraPayment} onChange={(e) => setExtraPayment(e.target.value)} placeholder="e.g. 3000" />
          </label>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -8 }}>
            On top of every debt's minimum, rolled onto whichever debt is first in the current payoff order.
          </div>

          <label className="te-field">
            <span>New spend on the revolving card</span>
            <select value={cardUsage} onChange={(e) => setCardUsage(e.target.value)}>
              <option value="">Not set</option>
              <option value="no">Stops — nothing new charged</option>
              <option value="yes">Continues at the current rate</option>
            </select>
          </label>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -8 }}>
            A payoff date assumes no new spend. If new spend continues, the projection is shown as a floor, not a date.
          </div>

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
