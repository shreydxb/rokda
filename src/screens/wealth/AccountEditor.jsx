import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

const TYPES = ['checking', 'savings', 'credit_card', 'investment', 'loan', 'cash', 'other'];

function initialForm(account) {
  if (account) {
    return {
      name: account.name,
      type: account.type,
      currency: account.currency ?? 'AED',
      balance: String(account.balance ?? 0),
      owner: account.is_shared ? 'shared' : (account.owner_member_id ?? ''),
      credit_limit: account.credit_limit !== null ? String(account.credit_limit) : '',
      statement_day: account.statement_day !== null ? String(account.statement_day) : '',
      due_day: account.due_day !== null ? String(account.due_day) : '',
    };
  }
  return { name: '', type: 'checking', currency: 'AED', balance: '', owner: 'shared', credit_limit: '', statement_day: '', due_day: '' };
}

export default function AccountEditor({ account, householdId, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(account));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const nameError = form.name.trim() === '' ? 'Name it.' : '';
  const isCard = form.type === 'credit_card';

  async function handleSave(e) {
    e.preventDefault();
    if (nameError) {
      setError(nameError);
      return;
    }
    setSaving(true);
    setError('');

    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      type: form.type,
      currency: form.currency || 'AED',
      balance: Number(form.balance) || 0,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      credit_limit: isCard && form.credit_limit ? Number(form.credit_limit) : null,
      statement_day: isCard && form.statement_day ? Number(form.statement_day) : null,
      due_day: isCard && form.due_day ? Number(form.due_day) : null,
    };

    const query = account
      ? supabase.from('accounts').update(payload).eq('id', account.id)
      : supabase.from('accounts').insert(payload);

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
    const { error: delError } = await supabase.from('accounts').delete().eq('id', account.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={account ? 'Edit account' : 'Add account'}>
        <div className="te-head">
          <div className="ov-kicker">{account ? 'Edit account' : 'Add account'}</div>
          <button type="button" className="te-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <label className="te-field">
            <span>Name</span>
            <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} />
          </label>

          <label className="te-field">
            <span>Type</span>
            <select value={form.type} onChange={(e) => set('type', e.target.value)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>

          <div className="te-row">
            <label className="te-field te-amount">
              <span>{isCard ? 'Balance owed' : 'Balance'}</span>
              <input type="number" step="0.01" value={form.balance} onChange={(e) => set('balance', e.target.value)} />
            </label>
            <label className="te-field te-currency">
              <span>Currency</span>
              <input type="text" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
            </label>
          </div>

          {isCard && (
            <>
              <label className="te-field">
                <span>Credit limit</span>
                <input type="number" step="0.01" value={form.credit_limit} onChange={(e) => set('credit_limit', e.target.value)} />
              </label>
              <div className="te-row">
                <label className="te-field te-amount">
                  <span>Statement day</span>
                  <input type="number" min="1" max="31" value={form.statement_day} onChange={(e) => set('statement_day', e.target.value)} />
                </label>
                <label className="te-field te-amount">
                  <span>Due day</span>
                  <input type="number" min="1" max="31" value={form.due_day} onChange={(e) => set('due_day', e.target.value)} />
                </label>
              </div>
            </>
          )}

          <label className="te-field">
            <span>Owner</span>
            <select value={form.owner} onChange={(e) => set('owner', e.target.value)}>
              <option value="shared">Shared</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-actions">
            {account && (
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
