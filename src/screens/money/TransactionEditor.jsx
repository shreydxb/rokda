import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import { formatMoney } from '../../lib/money';
import './TransactionEditor.css';

function initialForm(tx, accounts) {
  if (tx) {
    return {
      type: Number(tx.amount) >= 0 ? 'income' : 'expense',
      amount: String(Math.abs(Number(tx.amount))),
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
    merchant: '',
    occurred_at: new Date().toISOString().slice(0, 10),
    account_id: accounts[0]?.id ?? '',
    category_id: '',
    owner: 'shared',
    note: '',
    needs_review: false,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A record like this already exists — same account, same merchant, same
// amount, within a few days. Real data, not the design's fixed example.
function findDuplicate(form, allTransactions, excludeId) {
  const merchant = form.merchant.trim().toLowerCase();
  const amount = Number(form.amount);
  if (!merchant || !amount || !form.account_id || !form.occurred_at) return null;
  const occurred = new Date(form.occurred_at).getTime();

  return (
    allTransactions.find((t) => {
      if (t.id === excludeId) return false;
      if (t.account_id !== form.account_id) return false;
      if ((t.merchant ?? '').trim().toLowerCase() !== merchant) return false;
      if (Math.abs(Math.abs(Number(t.amount)) - amount) > 0.01) return false;
      const diffDays = Math.abs(new Date(t.occurred_at).getTime() - occurred) / DAY_MS;
      return diffDays <= 3;
    }) ?? null
  );
}

export default function TransactionEditor({ tx, householdId, accounts, categories, members, allTransactions, onClose, onSaved, onOpenOther }) {
  // Closed accounts aren't offered for new entries, but an existing record that
  // already points at one keeps it so saving doesn't move it (QA-01).
  const selectable = selectableAccounts(accounts, tx?.account_id ?? null);
  const [form, setForm] = useState(() => initialForm(tx, selectableAccounts(accounts, tx?.account_id ?? null)));
  const [dirty, setDirty] = useState(false);
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);
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
    if (key === 'merchant' || key === 'amount' || key === 'occurred_at' || key === 'account_id') setDuplicateDismissed(false);
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
  const kindCategories = categories.filter((c) => c.kind === form.type && (!c.archived || c.id === form.category_id));

  const duplicate = useMemo(
    () => (tx ? null : duplicateDismissed ? null : findDuplicate(form, allTransactions, tx?.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.merchant, form.amount, form.occurred_at, form.account_id, allTransactions, duplicateDismissed, tx]
  );

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
      currency: 'AED',
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
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{tx ? 'Edit transaction' : 'New entry'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{tx ? tx.merchant || 'Transaction' : 'Add a transaction'}</div>
          </div>
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

          <div>
            <div className="te-hero-label">Amount</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                className="te-hero-input"
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                aria-invalid={!!amountError}
                placeholder="0"
              />
            </div>
          </div>

          {duplicate && (
            <div className="te-duplicate" role="status">
              <div className="te-duplicate-title">A record like this already exists</div>
              <div className="te-duplicate-body">
                {duplicate.merchant}, {formatMoney(duplicate.amount)},{' '}
                {new Date(duplicate.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — within a few days
                of this one. Saving both is allowed if the household really spent twice.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
                <button type="button" className="om-btn" onClick={() => setDuplicateDismissed(true)}>
                  Both are real
                </button>
                {onOpenOther && (
                  <button type="button" className="om-btn" onClick={() => onOpenOther(duplicate)}>
                    Open the other record
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Merchant</span>
              <input className="te-fieldvalue" type="text" value={form.merchant} onChange={(e) => set('merchant', e.target.value)} placeholder="Type a merchant name" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Date</span>
              <input className="te-fieldvalue" type="date" value={form.occurred_at} onChange={(e) => set('occurred_at', e.target.value)} />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Account</span>
              <select className="te-fieldvalue" value={form.account_id} onChange={(e) => set('account_id', e.target.value)} aria-invalid={!!accountError}>
                <option value="" disabled>
                  Choose…
                </option>
                {selectable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountOptionLabel(a, { members, accounts: selectable })}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <span className="te-fieldlabel">Category</span>
            <div className="te-chips">
              <button type="button" className="om-seg" data-active={form.category_id === ''} onClick={() => set('category_id', '')}>
                Uncategorised
              </button>
              {kindCategories.map((c) => (
                <button key={c.id} type="button" className="om-seg" data-active={form.category_id === c.id} onClick={() => set('category_id', c.id)}>
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="te-fieldlabel">Whose spend</span>
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

          <div className="te-fieldcell">
            <span className="te-fieldlabel">Note</span>
            <textarea className="te-fieldvalue" rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} />
          </div>

          <button type="button" className="te-togglerow" onClick={() => set('needs_review', !form.needs_review)}>
            <div>
              <div className="te-togglelabel">Needs review</div>
              <div className="te-togglenote">Flags it for the other person to check</div>
            </div>
            <span className={`te-togglestate ${form.needs_review ? 'te-togglestate-warn' : ''}`}>{form.needs_review ? 'Flagged' : 'Clear'}</span>
          </button>

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
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
                      {saving ? 'Saving…' : tx ? 'Save changes' : 'Add transaction'}
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
