import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

export default function BudgetEditor({ item, householdId, categories, year, month, onClose, onSaved }) {
  const [categoryId, setCategoryId] = useState(item?.category_id ?? categories[0]?.id ?? '');
  const [amount, setAmount] = useState(item ? String(item.amount) : '');
  const [applyTo, setApplyTo] = useState('month'); // 'month' | 'year'
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const amountError = amount.trim() === '' || Number(amount) < 0 ? 'Enter an amount of zero or more.' : '';

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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={item ? 'Edit budget' : 'Set budget'}>
        <div className="te-head">
          <div className="ov-kicker">{item ? 'Edit budget' : 'Set budget'}</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <label className="te-field">
            <span>Category</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!!item}>
              {categories.filter((c) => !c.archived || c.id === categoryId).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="te-field">
            <span>Monthly amount</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!amountError}
            />
          </label>

          <div className="te-field">
            <span>Apply to</span>
            <div className="te-type">
              <button type="button" className="om-seg" data-active={applyTo === 'month'} onClick={() => setApplyTo('month')}>
                This month
              </button>
              <button type="button" className="om-seg" data-active={applyTo === 'year'} onClick={() => setApplyTo('year')}>
                Whole year ({year})
              </button>
            </div>
          </div>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-actions">
            {item && (
              <button type="button" className="om-btn te-delete" onClick={handleDelete} disabled={saving}>
                {confirmingDelete ? 'Confirm delete?' : 'Delete'}
              </button>
            )}
            <div className="te-actions-right">
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
