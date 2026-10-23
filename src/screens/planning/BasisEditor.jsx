import { useEffect, useId, useMemo, useState } from 'react';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { basisChoice, monthKeyLabel, recordsFromOptions } from '../../lib/forecast';
import '../money/TransactionEditor.css';

// What every projection is worked out on: the budget or the recorded months,
// and the month the records count from (Planning audit, 2.9). Saved with the
// planning assumptions, so it holds for both partners and on every tab.
export default function BasisEditor({ householdId, assumptions, recordedMonths = [], onClose, onSaved }) {
  const uid = useId();
  const drawerRef = useDrawerFocus();
  const saved = basisChoice(assumptions);
  const [basis, setBasis] = useState(saved.basis);
  const [from, setFrom] = useState(saved.recordsFrom ?? '');
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // A month saved before the first record still shows as itself.
  const options = useMemo(() => {
    const months = recordsFromOptions(recordedMonths);
    return saved.recordsFrom && !months.includes(saved.recordsFrom) ? [...months, saved.recordsFrom].sort().reverse() : months;
  }, [recordedMonths, saved.recordsFrom]);

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

  function choose(next) {
    setBasis(next);
    setDirty(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    const { error: saveError } = await supabase.from('planning_assumptions').upsert(
      {
        household_id: householdId,
        planning_basis: basis,
        records_from: from ? `${from}-01` : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'household_id' }
    );
    setSaving(false);
    if (saveError) {
      setError(`The basis wasn't saved: ${saveError.message}`);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Planning basis">
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">Planning</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">Basis</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave} noValidate>
          <div>
            <div className="om-scope-list" role="group" aria-label="Spending and saving from">
              <button type="button" className="om-scope" data-active={basis === 'budget'} aria-pressed={basis === 'budget'} onClick={() => choose('budget')}>
                Your budget
              </button>
              <button type="button" className="om-scope" data-active={basis === 'recorded'} aria-pressed={basis === 'recorded'} onClick={() => choose('recorded')}>
                Recorded months
              </button>
            </div>
            <span className="ov-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
              {basis === 'budget'
                ? 'Your spending budget and savings target: the plan you wrote down, whatever the records say. Recorded months stand in only while no month has a spending budget.'
                : basis === 'recorded'
                  ? 'The average of up to your last twelve ended months. Your budget stands in until three have ended.'
                  : 'Not chosen: your budget until three months have ended, then the recorded months.'}
            </span>
          </div>

          <div className="te-fieldcell">
            <label className="te-fieldlabel" htmlFor={`${uid}-from`}>
              Records count from
            </label>
            <select
              id={`${uid}-from`}
              className="te-fieldvalue"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setDirty(true);
              }}
            >
              <option value="">Every recorded month</option>
              {options.map((key) => (
                <option key={key} value={key}>
                  {monthKeyLabel(key)}
                </option>
              ))}
            </select>
            <span className="ov-muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.6 }}>
              Leave out a first month or two recorded only in part: a month with its pay but little of its spending reads as saving most of it.
            </span>
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
                      {saving ? 'Saving…' : 'Save'}
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
