import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

const CARD_USAGE = [
  { id: '', label: 'Not set' },
  { id: 'no', label: 'Stops — nothing new charged' },
  { id: 'yes', label: 'Continues at the current rate' },
];

export default function DebtPlanEditor({ householdId, assumptions, onClose, onSaved }) {
  const [extraPayment, setExtraPayment] = useState(assumptions?.debt_extra_payment != null ? String(assumptions.debt_extra_payment) : '');
  const [cardUsage, setCardUsage] = useState(
    assumptions?.debt_assume_no_new_card_spend === true ? 'no' : assumptions?.debt_assume_no_new_card_spend === false ? 'yes' : ''
  );
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label="Debt payoff inputs">
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">Debt payoff inputs</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">Extra payment &amp; card usage</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <div className="te-hero-label">Committed extra payment (per month)</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input
                type="number"
                step="0.01"
                className="te-hero-input"
                value={extraPayment}
                onChange={(e) => {
                  setExtraPayment(e.target.value);
                  setDirty(true);
                }}
                placeholder="0"
              />
            </div>
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -10 }}>
            On top of every debt's minimum, rolled onto whichever debt is first in the current payoff order.
          </div>

          <div>
            <span className="te-fieldlabel">New spend on the revolving card</span>
            <div className="te-chips">
              {CARD_USAGE.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="om-seg"
                  data-active={cardUsage === o.id}
                  onClick={() => {
                    setCardUsage(o.id);
                    setDirty(true);
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -10 }}>
            A payoff date assumes no new spend. If new spend continues, the projection is shown as a floor, not a date.
          </div>

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
