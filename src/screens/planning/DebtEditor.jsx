import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { isArchived } from '../../lib/accounts';
import { formatMoney } from '../../lib/money';
import '../money/TransactionEditor.css';

// Where a debt's balance lives: a loan or card account, so net worth counts it.
// NEW makes the account along with the debt; '' leaves the debt unlinked.
const NEW = 'new';

const owed = (account) => Math.abs(Number(account.balance ?? 0));

function initialForm(debt, linked) {
  if (debt) {
    return {
      name: debt.name,
      note: debt.note ?? '',
      account: debt.account_id ?? '',
      balance: String(linked ? owed(linked) : (debt.balance ?? '')),
      original_amount: debt.original_amount != null ? String(debt.original_amount) : '',
      apr_pct: String(debt.apr_pct ?? ''),
      minimum_payment: String(debt.minimum_payment ?? ''),
      owner: debt.is_shared ? 'shared' : (debt.owner_member_id ?? ''),
    };
  }
  return { name: '', note: '', account: NEW, balance: '', original_amount: '', apr_pct: '', minimum_payment: '', owner: 'shared' };
}

export default function DebtEditor({ debt, householdId, members, accounts = [], debts = [], onClose, onSaved }) {
  // Open loan and card accounts no other debt already plans for: one plan per loan.
  const takenByOthers = new Set(debts.filter((d) => d.account_id && d.id !== debt?.id).map((d) => d.account_id));
  const liabilityAccounts = accounts.filter((a) => (a.type === 'loan' || a.type === 'credit_card') && !takenByOthers.has(a.id) && (!isArchived(a) || a.id === debt?.account_id));
  const [form, setForm] = useState(() => initialForm(debt, accounts.find((a) => a.id === debt?.account_id)));
  const linked = form.account && form.account !== NEW ? (accounts.find((a) => a.id === form.account) ?? null) : null;
  // A balance in another currency is kept in Wealth, where its currency is.
  const foreign = linked && String(linked.currency ?? 'AED').toUpperCase() !== 'AED';
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

  // Linking an account takes its balance and owner: the account is the record.
  function chooseAccount(id) {
    const account = accounts.find((a) => a.id === id);
    setForm((f) => ({
      ...f,
      account: id,
      ...(account ? { balance: String(owed(account)), owner: account.is_shared ? 'shared' : (account.owner_member_id ?? 'shared') } : {}),
    }));
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
  const balanceError = form.balance === '' || Number(form.balance) < 0 ? 'Enter a balance.' : '';

  async function handleSave(e) {
    e.preventDefault();
    if (nameError || balanceError) {
      setError(nameError || balanceError);
      return;
    }
    setSaving(true);
    setError('');
    const fail = (message) => {
      setSaving(false);
      setError(message);
    };

    // The loan's account first, so the debt can point at it.
    let accountId = linked?.id ?? null;
    let createdAccount = null;
    if (form.account === NEW) {
      const { data: created, error: accountError } = await supabase
        .from('accounts')
        .insert({
          household_id: householdId,
          name: form.name.trim(),
          type: 'loan',
          currency: 'AED',
          balance: Number(form.balance),
          is_shared: form.owner === 'shared',
          owner_member_id: form.owner === 'shared' ? null : form.owner,
          balance_as_of: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (accountError) return fail(accountError.message);
      accountId = created.id;
      createdAccount = created.id;
    } else if (linked && !foreign && Number(form.balance) !== owed(linked)) {
      // A new balance entered here is a new balance for the account, confirmed today.
      const now = new Date().toISOString();
      const { error: accountError } = await supabase.from('accounts').update({ balance: Number(form.balance), balance_as_of: now, updated_at: now }).eq('id', linked.id);
      if (accountError) return fail(accountError.message);
    }

    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      note: form.note.trim(),
      balance: foreign ? Math.abs(Number(linked.balance_aed ?? form.balance)) : Number(form.balance),
      original_amount: form.original_amount ? Number(form.original_amount) : null,
      apr_pct: Number(form.apr_pct) || 0,
      minimum_payment: Number(form.minimum_payment) || 0,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      account_id: accountId,
    };

    const query = debt ? supabase.from('debts').update(payload).eq('id', debt.id) : supabase.from('debts').insert(payload);
    const { error: saveError } = await query;
    if (saveError) {
      // Leave no account behind for a debt that was never saved.
      if (createdAccount) await supabase.from('accounts').delete().eq('id', createdAccount);
      return fail(saveError.message);
    }
    setSaving(false);
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
    <div className="te-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="te-drawer" role="dialog" aria-modal="true" aria-label={debt ? 'Edit debt' : 'Add debt'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{debt ? 'Edit debt' : 'New debt'}</span>
              {dirty && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{debt ? debt.name : 'Add a debt'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="te-form" onSubmit={handleSave}>
          <div>
            <div className="te-hero-label">Balance owed</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              {foreign ? (
                <span className="te-hero-input fig">{linked.balance_aed != null ? formatMoney(Math.abs(Number(linked.balance_aed))) : '—'}</span>
              ) : (
                <input type="number" step="0.01" className="te-hero-input" value={form.balance} onChange={(e) => set('balance', e.target.value)} aria-invalid={!!balanceError} placeholder="0" aria-label="Balance owed" />
              )}
            </div>
            {foreign && <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>{linked.name} is in {linked.currency}: update its balance in Wealth.</div>}
          </div>

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <label className="te-fieldlabel" htmlFor="debt-account">
                Account
              </label>
              <select id="debt-account" className="te-fieldvalue" value={form.account} onChange={(e) => chooseAccount(e.target.value)}>
                {!debt?.account_id && <option value={NEW}>Create a loan account</option>}
                {liabilityAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type === 'loan' ? 'loan' : 'card'})
                  </option>
                ))}
                <option value="">Not linked: not in net worth</option>
              </select>
              <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                {form.account === NEW
                  ? 'A loan account is added in Wealth with this balance, so net worth counts it.'
                  : linked
                    ? 'The balance is the account\'s: a change here updates it, and net worth counts it.'
                    : 'Net worth does not count a debt with no account.'}
              </div>
            </div>
          </div>

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Name</span>
              <input className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Note</span>
              <input className="te-fieldvalue" type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. fixed term to Jan 2030" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">APR (%/yr)</span>
              <input className="te-fieldvalue" type="number" step="0.01" value={form.apr_pct} onChange={(e) => set('apr_pct', e.target.value)} />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Minimum payment (AED/mo)</span>
              <input className="te-fieldvalue" type="number" step="0.01" value={form.minimum_payment} onChange={(e) => set('minimum_payment', e.target.value)} />
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Original amount</span>
              <input className="te-fieldvalue" type="number" step="0.01" value={form.original_amount} onChange={(e) => set('original_amount', e.target.value)} placeholder="optional — for a paid-down bar" />
            </div>
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

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
              {error}
            </p>
          )}

          <div className="te-sticky-actions">
            <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
              {debt && (
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
                      {saving ? 'Saving…' : debt ? 'Save changes' : 'Add debt'}
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
