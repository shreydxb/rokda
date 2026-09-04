import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import './TransactionEditor.css';

export default function BudgetEditor({ item, householdId, categories, year, month, onClose, onSaved }) {
  const [categoryId, setCategoryId] = useState(item?.category_id ?? categories.find((c) => c.kind === 'expense')?.id ?? '');
  const [amount, setAmount] = useState(item ? String(item.amount) : '');
  const [applyTo, setApplyTo] = useState('month'); // 'month' | 'year'
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

  const amountError = amount.trim() === '' || Number(amount) < 0 ? 'Enter an amount of zero or more.' : '';
  const categoryName = categories.find((c) => c.id === categoryId)?.name ?? 'Uncategorised';

  async function handleSave(e) {
    e.preventDefault();
    if (amountError || !categoryId) {
      setError(amountError || 'Choose a category.');
      return;
    }
    setSaving(true);
    setError('');

    const months = applyTo === 'year' ? Array.from({ length: 12 }, (_, i) => i + 1) : [month];
    const rows = months.map((m) => ({
      household_id: householdId,
      category_id: categoryId,
      year,
      month: m,
      amount: Number(amount),
    }));

    const { error: saveError } = await supabase.from('budgets').upsert(rows, {
      onConflict: 'household_id,category_id,year,month',
    });
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    await onSaved();
  }

  async function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    const { error: delError } = await supabase.from('budgets').delete().eq('id', item.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={item ? 'Edit budget' : 'Set budget'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{item ? 'Edit budget' : 'New budget'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{item ? `${categoryName} budget` : 'Set a category budget'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <div className="te-hero-label">Monthly limit</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                className="te-hero-input"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setDirty(true);
                }}
                aria-invalid={!!amountError}
                placeholder="0"
              />
            </div>
          </div>

          {item ? (
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Category</span>
              <div className="te-fieldvalue" style={{ borderBottom: 'none', paddingTop: 4 }}>
                {categoryName}
              </div>
            </div>
          ) : (
            <div>
              <span className="te-fieldlabel">Category</span>
              <div className="te-chips">
                {categories
                  .filter((c) => c.kind === 'expense' && !c.archived)
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="om-seg"
                      data-active={categoryId === c.id}
                      onClick={() => {
                        setCategoryId(c.id);
                        setDirty(true);
                      }}
                    >
                      {c.name}
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div>
            <span className="te-fieldlabel">Apply to</span>
            <div className="te-chips">
              <button
                type="button"
                className="om-seg"
                data-active={applyTo === 'month'}
                onClick={() => {
                  setApplyTo('month');
                  setDirty(true);
                }}
              >
                This month
              </button>
              <button
                type="button"
                className="om-seg"
                data-active={applyTo === 'year'}
                onClick={() => {
                  setApplyTo('year');
                  setDirty(true);
                }}
              >
                Whole year ({year})
              </button>
            </div>
          </div>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {item && (
                <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                  {confirmingDelete ? 'Confirm delete?' : 'Delete'}
                </button>
              )}
              <div className="te-actions-right">
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
