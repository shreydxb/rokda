import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { closurePlan, isArchived } from '../../lib/accounts';
import '../money/TransactionEditor.css';

const TYPES = ['checking', 'savings', 'credit_card', 'investment', 'loan', 'cash', 'other'];

function initialForm(account, defaultType) {
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
  return { name: '', type: defaultType ?? 'checking', currency: 'AED', balance: '', owner: 'shared', credit_limit: '', statement_day: '', due_day: '' };
}

export default function AccountEditor({ account, defaultType, householdId, members, transactions = [], onClose, onSaved }) {
  const [form, setForm] = useState(() => initialForm(account, defaultType));
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

  // Closing keeps the ledger; deleting is only offered for an account that was
  // never used. The foreign key enforces the same rule server-side (QA-01).
  const plan = account ? closurePlan(account, transactions) : null;

  async function handleClose() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    setError('');
    const { error: mutationError } =
      plan.action === 'delete'
        ? await supabase.from('accounts').delete().eq('id', account.id)
        : await supabase
            .from('accounts')
            .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', account.id);
    setSaving(false);
    if (mutationError) {
      setError(mutationError.message);
      return;
    }
    await onSaved();
  }

  async function handleReopen() {
    setSaving(true);
    setError('');
    const { error: mutationError } = await supabase
      .from('accounts')
      .update({ archived_at: null, updated_at: new Date().toISOString() })
      .eq('id', account.id);
    setSaving(false);
    if (mutationError) {
      setError(mutationError.message);
      return;
    }
    await onSaved();
  }

  return (
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={account ? 'Edit account' : 'Add account'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{account ? 'Edit account' : 'New account'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{account ? account.name : 'Add an account'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <div className="te-hero-label">{isCard ? 'Balance owed' : 'Current balance'}</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input type="number" step="0.01" className="te-hero-input" value={form.balance} onChange={(e) => set('balance', e.target.value)} placeholder="0" />
            </div>
          </div>

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Name</span>
              <input className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} placeholder="e.g. ADCB Savings" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Type</span>
              <select className="te-fieldvalue" value={form.type} onChange={(e) => set('type', e.target.value)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Currency</span>
              <input className="te-fieldvalue" type="text" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
            </div>
            {isCard && (
              <>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Credit limit</span>
                  <input className="te-fieldvalue" type="number" step="0.01" value={form.credit_limit} onChange={(e) => set('credit_limit', e.target.value)} />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Statement day</span>
                  <input className="te-fieldvalue" type="number" min="1" max="31" value={form.statement_day} onChange={(e) => set('statement_day', e.target.value)} />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Due day</span>
                  <input className="te-fieldvalue" type="number" min="1" max="31" value={form.due_day} onChange={(e) => set('due_day', e.target.value)} />
                </div>
              </>
            )}
          </div>

          <div>
            <span className="te-fieldlabel">Owner</span>
            <div className="om-scope-list" style={{ marginTop: 10 }}>
              <button type="button" className="om-scope" data-active={form.owner === 'shared'} onClick={() => set('owner', 'shared')}>
                Shared
              </button>
              {members.map((m) => (
                <button key={m.id} type="button" className="om-scope" data-active={form.owner === m.id} onClick={() => set('owner', m.id)}>
                  {m.display_name}
                </button>
              ))}
            </div>
          </div>

          {account && confirmingDelete && (
            <p className="ov-muted" style={{ fontSize: 12.5 }}>
              {plan.detail}
            </p>
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {account && isArchived(account) && (
                <button type="button" className="om-btn" onClick={handleReopen} disabled={saving}>
                  Reopen account
                </button>
              )}
              {account && !isArchived(account) && (
                <button type="button" className="om-btn te-delete" onClick={handleClose} disabled={saving}>
                  {confirmingDelete
                    ? plan.action === 'delete'
                      ? 'Confirm delete?'
                      : 'Confirm close?'
                    : plan.action === 'delete'
                      ? 'Delete'
                      : 'Close account'}
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
                      {saving ? 'Saving…' : account ? 'Save changes' : 'Add account'}
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
