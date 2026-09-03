import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import '../money/TransactionEditor.css';

function initialForm(debt) {
  if (debt) {
    return {
      name: debt.name,
      note: debt.note ?? '',
      balance: String(debt.balance ?? ''),
      original_amount: debt.original_amount != null ? String(debt.original_amount) : '',
      apr_pct: String(debt.apr_pct ?? ''),
      minimum_payment: String(debt.minimum_payment ?? ''),
      owner: debt.is_shared ? 'shared' : (debt.owner_member_id ?? ''),
    };
  }
  return { name: '', note: '', balance: '', original_amount: '', apr_pct: '', minimum_payment: '', owner: 'shared' };
}

export default function DebtEditor({ debt, householdId, members, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(debt));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const nameError = form.name.trim() === '' ? 'Name it.' : '';
  const balanceError = form.balance === '' || Number(form.balance) < 0 ? 'Enter a balance.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (nameError || balanceError) {
      setError(nameError || balanceError);
      return;
    }
    setSaving(true);
    setError('');

    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      note: form.note.trim(),
      balance: Number(form.balance),
      original_amount: form.original_amount ? Number(form.original_amount) : null,
      apr_pct: Number(form.apr_pct) || 0,
      minimum_payment: Number(form.minimum_payment) || 0,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
    };

    const query = debt ? supabase.from('debts').update(payload).eq('id', debt.id) : supabase.from('debts').insert(payload);
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
    const { error: delError } = await supabase.from('debts').delete().eq('id', debt.id);
    setSaving(false);
    if (delError) {
      setError(delError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={debt ? 'Edit debt' : 'Add debt'}>
        <div className="te-head">
          <div className="ov-kicker">{debt ? 'Edit debt' : 'Add a debt'}</div>
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
            <span>Note</span>
            <input type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. fixed term to Jan 2030" />
          </label>

          <div className="te-row">
            <label className="te-field te-amount">
              <span>Balance owed (AED)</span>
              <input type="number" step="0.01" value={form.balance} onChange={(e) => set('balance', e.target.value)} aria-invalid={!!balanceError} />
            </label>
            <label className="te-field te-currency">
              <span>APR (%/yr)</span>
              <input type="number" step="0.01" value={form.apr_pct} onChange={(e) => set('apr_pct', e.target.value)} />
            </label>
          </div>

          <div className="te-row">
            <label className="te-field te-amount">
              <span>Minimum payment (AED/mo)</span>
              <input type="number" step="0.01" value={form.minimum_payment} onChange={(e) => set('minimum_payment', e.target.value)} />
            </label>
            <label className="te-field te-currency">
              <span>Original amount</span>
              <input type="number" step="0.01" value={form.original_amount} onChange={(e) => set('original_amount', e.target.value)} placeholder="optional" />
            </label>
          </div>
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -6 }}>
            Original amount is optional — set it to see a "paid down" bar.
          </div>

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
            {debt && (
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
