import { useEffect, useState } from 'react';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

// An extra payment on the debts, as a what-if: Debt payoff dates the debts
// at their minimums whether or not one is set. It used to ask too whether new
// spend continues on the card, an answer that changed nothing it worked out
// (Planning audit, 1.4); the column is left as it was, unread.
export default function DebtPlanEditor({ householdId, assumptions, onClose, onSaved }) {
  const drawerRef = useDrawerFocus();
  const [extraPayment, setExtraPayment] = useState(assumptions?.debt_extra_payment != null ? String(assumptions.debt_extra_payment) : '');
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

  // Blank is none; a negative payment is no payment at all, and the database
  // refuses it too.
  const extraProblem = extraPayment.trim() !== '' && !(Number(extraPayment) >= 0) ? 'An extra payment of zero or more.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    if (extraProblem) {
      setError(extraProblem);
      return;
    }
    setSaving(true);
    setError('');

    const payload = {
      household_id: householdId,
      debt_extra_payment: extraPayment.trim() === '' ? null : Number(extraPayment),
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
      <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Debt payoff inputs">
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">Debt payoff inputs</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">Extra payment</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave} noValidate>
          <div>
            <div className="te-hero-label">Extra payment (per month)</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input
                type="number"
                min="0"
                step="0.01"
                className="te-hero-input"
                value={extraPayment}
                onChange={(e) => {
                  setExtraPayment(e.target.value);
                  setDirty(true);
                }}
                placeholder="0"
                aria-label="Extra payment, AED a month"
                aria-invalid={!!error && !!extraProblem}
              />
            </div>
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -10 }}>
            A what-if: on top of every debt&rsquo;s minimum, to the first debt in the payoff order, then the next once it clears. Leave it
            blank for none.
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
