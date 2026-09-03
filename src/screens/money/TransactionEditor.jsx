import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import './TransactionEditor.css';

function initialForm(tx, accounts) {
  if (tx) {
    return {
      type: Number(tx.amount) >= 0 ? 'income' : 'expense',
      amount: String(Math.abs(Number(tx.amount))),
      currency: tx.currency ?? 'AED',
      merchant: tx.merchant ?? '',
      occurred_at: tx.occurred_at,
      account_id: tx.account_id ?? '',
      category_id: tx.category_id ?? '',
      owner: tx.is_shared ? 'shared' : (tx.owner_member_id ?? ''),
      note: tx.note ?? '',
      needs_review: !!tx.needs_review,
    };
  }
  return {
    type: 'expense',
    amount: '',
    currency: accounts[0]?.currency ?? 'AED',
    merchant: '',
    occurred_at: new Date().toISOString().slice(0, 10),
    account_id: accounts[0]?.id ?? '',
    category_id: '',
    owner: 'shared',
    note: '',
    needs_review: false,
  };
}

export default function TransactionEditor({ tx, householdId, accounts, categories, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(tx, accounts));
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

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  const amountError = form.amount.trim() === '' || Number(form.amount) <= 0 ? 'Enter an amount greater than zero.' : '';
  const accountError = !form.account_id ? 'Choose an account.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (amountError || accountError) {
      setError(amountError || accountError);
      return;
    }
    setSaving(true);
    setError('');

    const signed = form.type === 'income' ? Math.abs(Number(form.amount)) : -Math.abs(Number(form.amount));
    const payload = {
      household_id: householdId,
      account_id: form.account_id,
      category_id: form.category_id || null,
      amount: signed,
      currency: form.currency || 'AED',
      merchant: form.merchant.trim() || null,
      note: form.note.trim() || null,
      occurred_at: form.occurred_at,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      needs_review: form.needs_review,
    };

    const query = tx
      ? supabase.from('transactions').update(payload).eq('id', tx.id)
      : supabase.from('transactions').insert(payload);

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
    const { error: delError } = await supabase.from('transactions').delete().eq('id', tx.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={tx ? 'Edit transaction' : 'Add transaction'}>
        <div className="te-head">
          <div className="ov-kicker">{tx ? 'Edit transaction' : 'Add transaction'}</div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div className="te-type">
            <button type="button" className="om-seg" data-active={form.type === 'expense'} onClick={() => set('type', 'expense')}>
              Expense
            </button>
            <button type="button" className="om-seg" data-active={form.type === 'income'} onClick={() => set('type', 'income')}>
              Income
            </button>
          </div>

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
            <span>Merchant</span>
            <input type="text" value={form.merchant} onChange={(e) => set('merchant', e.target.value)} />
          </label>

          <label className="te-field">
            <span>Date</span>
            <input type="date" value={form.occurred_at} onChange={(e) => set('occurred_at', e.target.value)} />
          </label>

          <label className="te-field">
            <span>Account</span>
            <select value={form.account_id} onChange={(e) => set('account_id', e.target.value)} aria-invalid={!!accountError}>
              <option value="" disabled>
                Choose…
              </option>
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
            <span>Whose spend</span>
            <select value={form.owner} onChange={(e) => set('owner', e.target.value)}>
              <option value="shared">Shared</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>

          <label className="te-field">
            <span>Note</span>
            <textarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} />
          </label>

          <label className="te-checkrow">
            <input type="checkbox" checked={form.needs_review} onChange={(e) => set('needs_review', e.target.checked)} />
            <span>Needs review</span>
          </label>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-actions">
            {tx && (
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
        </form>
      </div>
    </div>
  );
}
