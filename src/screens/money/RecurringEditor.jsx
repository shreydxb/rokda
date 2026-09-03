import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { CADENCES } from '../../lib/recurring';
import '../money/TransactionEditor.css';

function initialForm(item, accounts) {
  if (item) {
    return {
      type: Number(item.amount) >= 0 ? 'income' : 'expense',
      amount: String(Math.abs(Number(item.amount))),
      currency: item.currency ?? 'AED',
      name: item.name ?? '',
      cadence: item.cadence ?? 'monthly',
      next_due_date: item.next_due_date,
      account_id: item.account_id ?? '',
      category_id: item.category_id ?? '',
      owner: item.is_shared ? 'shared' : (item.owner_member_id ?? ''),
      autopay: !!item.autopay,
      is_fixed: item.is_fixed !== false,
      active: item.active !== false,
    };
  }
  return {
    type: 'expense',
    amount: '',
    currency: accounts[0]?.currency ?? 'AED',
    name: '',
    cadence: 'monthly',
    next_due_date: new Date().toISOString().slice(0, 10),
    account_id: accounts[0]?.id ?? '',
    category_id: '',
    owner: 'shared',
    autopay: false,
    is_fixed: true,
    active: true,
  };
}

export default function RecurringEditor({ item, householdId, accounts, categories, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(item, accounts));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const amountError = form.amount.trim() === '' || Number(form.amount) <= 0 ? 'Enter an amount greater than zero.' : '';
  const nameError = form.name.trim() === '' ? 'Name it.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (amountError || nameError) {
      setError(amountError || nameError);
      return;
    }
    setSaving(true);
    setError('');

    const signed = form.type === 'income' ? Math.abs(Number(form.amount)) : -Math.abs(Number(form.amount));
    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      account_id: form.account_id || null,
      category_id: form.category_id || null,
      amount: signed,
      currency: form.currency || 'AED',
      cadence: form.cadence,
      next_due_date: form.next_due_date,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      autopay: form.autopay,
      is_fixed: form.is_fixed,
      active: form.active,
    };

    const query = item
      ? supabase.from('recurring').update(payload).eq('id', item.id)
      : supabase.from('recurring').insert(payload);

    const { error: saveError } = await query;
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
    const { error: delError } = await supabase.from('recurring').delete().eq('id', item.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={item ? 'Edit recurring item' : 'Add recurring item'}>
        <div className="te-head">
          <div className="ov-kicker">{item ? 'Edit recurring' : 'Add recurring'}</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div className="te-type">
            <button type="button" className="om-seg" data-active={form.type === 'expense'} onClick={() => set('type', 'expense')}>
              Bill
            </button>
            <button type="button" className="om-seg" data-active={form.type === 'income'} onClick={() => set('type', 'income')}>
              Expected income
            </button>
          </div>

          <label className="te-field">
            <span>Name</span>
            <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} />
          </label>

          <div className="te-row">
            <label className="te-field te-amount">
              <span>Amount</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                aria-invalid={!!amountError}
              />
            </label>
            <label className="te-field te-currency">
              <span>Currency</span>
              <input type="text" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
            </label>
          </div>

          <label className="te-field">
            <span>Cadence</span>
            <select value={form.cadence} onChange={(e) => set('cadence', e.target.value)}>
              {CADENCES.map((c) => (
                <option key={c} value={c}>
                  {c[0].toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </label>

          <label className="te-field">
            <span>Next due date</span>
            <input type="date" value={form.next_due_date} onChange={(e) => set('next_due_date', e.target.value)} />
          </label>

          <label className="te-field">
            <span>Account</span>
            <select value={form.account_id} onChange={(e) => set('account_id', e.target.value)}>
              <option value="">Not linked</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="te-field">
            <span>Category</span>
            <select value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
              <option value="">Uncategorised</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="te-field">
            <span>Whose</span>
            <select value={form.owner} onChange={(e) => set('owner', e.target.value)}>
              <option value="shared">Shared</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>

          <label className="te-checkrow">
            <input type="checkbox" checked={form.autopay} onChange={(e) => set('autopay', e.target.checked)} />
            <span>Autopay</span>
          </label>
          <label className="te-checkrow">
            <input type="checkbox" checked={form.is_fixed} onChange={(e) => set('is_fixed', e.target.checked)} />
            <span>Fixed amount (uncheck if it varies)</span>
          </label>
          <label className="te-checkrow">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
            <span>Active</span>
          </label>

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
