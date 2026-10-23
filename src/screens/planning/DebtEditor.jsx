import { useEffect, useId, useRef, useState } from 'react';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { amountOwed, isArchived } from '../../lib/accounts';
import { accountOwner } from '../../lib/debt';
import { formatMoney } from '../../lib/money';
import '../money/TransactionEditor.css';

// Where a debt's balance lives: a loan or card account, so net worth counts it.
// NEW makes the account along with the debt; '' leaves the debt unlinked.
const NEW = 'new';

const blank = (v) => String(v).trim() === '';
const FIELDS = ['balance', 'name', 'apr', 'minimum'];

function initialForm(debt, linked) {
  if (debt) {
    return {
      name: debt.name,
      note: debt.note ?? '',
      account: debt.account_id ?? '',
      balance: String(linked ? amountOwed(linked) : (debt.balance ?? '')),
      original_amount: debt.original_amount != null ? String(debt.original_amount) : '',
      apr_pct: String(debt.apr_pct ?? ''),
      minimum_payment: String(debt.minimum_payment ?? ''),
      owner: debt.is_shared ? 'shared' : (debt.owner_member_id ?? ''),
    };
  }
  return { name: '', note: '', account: NEW, balance: '', original_amount: '', apr_pct: '', minimum_payment: '', owner: 'shared' };
}

export default function DebtEditor({ debt, householdId, members, accounts = [], debts = [], onClose, onSaved }) {
  const drawerRef = useDrawerFocus();
  // Open loan and card accounts no other debt already plans for: one plan per loan.
  const takenByOthers = new Set(debts.filter((d) => d.account_id && d.id !== debt?.id).map((d) => d.account_id));
  const liabilityAccounts = accounts.filter((a) => (a.type === 'loan' || a.type === 'credit_card') && !takenByOthers.has(a.id) && (!isArchived(a) || a.id === debt?.account_id));
  const [form, setForm] = useState(() => initialForm(debt, accounts.find((a) => a.id === debt?.account_id)));
  // The account balance the form was filled from. A balance is written back
  // only when one different from it was typed, and only over it: accounts
  // reload while the editor is open, and a balance changed meanwhile, here or
  // by the bot, must not be overwritten with the one the editor opened with.
  const [filledFrom, setFilledFrom] = useState(() => {
    const account = accounts.find((a) => a.id === debt?.account_id);
    return account ? { id: account.id, balance: account.balance } : null;
  });
  const linked = form.account && form.account !== NEW ? (accounts.find((a) => a.id === form.account) ?? null) : null;
  const linkedOwner = linked ? accountOwner(linked) : null;
  const linkedOwnerName = linkedOwner ? (linkedOwner.is_shared ? 'Shared' : (members.find((m) => m.id === linkedOwner.owner_member_id)?.display_name ?? 'Shared')) : null;
  // A balance in another currency is kept in Wealth, where its currency is.
  const foreign = linked && String(linked.currency ?? 'AED').toUpperCase() !== 'AED';
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const uid = useId();
  const fieldRefs = useRef({});

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
    setFilledFrom(account ? { id: account.id, balance: account.balance } : null);
    setForm((f) => ({
      ...f,
      account: id,
      ...(account ? { balance: String(amountOwed(account)), owner: account.is_shared ? 'shared' : (account.owner_member_id ?? 'shared') } : {}),
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

  // The rate and the minimum drive the payoff order and every date on Debt
  // payoff, so neither is guessed: a blank is not taken for 0. A loan at 0% or
  // with no minimum is real, and is entered as 0.
  const aprText = String(form.apr_pct).trim();
  const minimumText = String(form.minimum_payment).trim();
  const fieldProblems = {
    balance: !foreign && (blank(form.balance) || !(Number(form.balance) >= 0)) ? 'Enter a balance.' : '',
    name: form.name.trim() === '' ? 'Name it.' : '',
    apr: blank(aprText) ? 'Enter the rate, 0 if it has none.' : !(Number(aprText) >= 0 && Number(aprText) <= 100) ? 'A rate between 0% and 100%.' : '',
    minimum: blank(minimumText) ? 'Enter the minimum payment, 0 if there is none.' : !(Number(minimumText) >= 0) ? 'A minimum of zero or more.' : '',
  };
  // Each field carries its own message once a save has been tried, and the
  // message follows the field as it is corrected.
  const invalid = (key) => (triedSave && fieldProblems[key] ? { 'aria-invalid': true, 'aria-describedby': `${uid}-${key}-problem` } : { 'aria-invalid': false });
  const problemText = (key) =>
    triedSave &&
    fieldProblems[key] && (
      <span className="te-fieldproblem" id={`${uid}-${key}-problem`}>
        {fieldProblems[key]}
      </span>
    );
  const fieldRef = (key) => (el) => {
    fieldRefs.current[key] = el;
  };

  async function handleSave(e) {
    e.preventDefault();
    if (saving) return;
    const firstProblem = FIELDS.find((key) => fieldProblems[key]);
    if (firstProblem) {
      setTriedSave(true);
      setError('Fix the marked field to save.');
      fieldRefs.current[firstProblem]?.focus();
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
    const openedBalance = linked ? (filledFrom?.id === linked.id ? filledFrom.balance : linked.balance) : null;
    const typedBalance = linked && !foreign && Number(form.balance) !== amountOwed(linked, openedBalance);
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
    } else if (typedBalance) {
      // A new balance entered here is a new balance for the account, confirmed
      // today, written only over the one the editor showed.
      const now = new Date().toISOString();
      const { data: written, error: accountError } = await supabase
        .from('accounts')
        .update({ balance: Number(form.balance), balance_as_of: now, updated_at: now })
        .eq('id', linked.id)
        .eq('balance', openedBalance)
        .select('id');
      if (accountError) return fail(accountError.message);
      if (!written?.length) return fail(`${linked.name}'s balance was changed after you opened this, so neither it nor the debt was saved. Cancel and open the debt again to see the new balance.`);
    }

    const payload = {
      household_id: householdId,
      name: form.name.trim(),
      note: form.note.trim(),
      balance: foreign ? amountOwed(linked, linked.balance_aed ?? form.balance) : linked && !typedBalance ? amountOwed(linked) : Number(form.balance),
      original_amount: form.original_amount ? Number(form.original_amount) : null,
      apr_pct: Number(aprText),
      minimum_payment: Number(minimumText),
      // A linked debt belongs to whoever its account does.
      ...(linked ? accountOwner(linked) : { is_shared: form.owner === 'shared', owner_member_id: form.owner === 'shared' ? null : form.owner }),
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
      <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={debt ? 'Edit debt' : 'Add debt'}>
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

        <form className="te-form" onSubmit={handleSave} noValidate>
          <div>
            <div className="te-hero-label">Balance owed</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">AED</span>
              {foreign ? (
                <span className="te-hero-input fig">{linked.balance_aed != null ? formatMoney(amountOwed(linked, linked.balance_aed)) : '—'}</span>
              ) : (
                <input
                  ref={fieldRef('balance')}
                  type="number"
                  min="0"
                  step="0.01"
                  className="te-hero-input"
                  value={form.balance}
                  onChange={(e) => set('balance', e.target.value)}
                  placeholder="0"
                  aria-label="Balance owed"
                  {...invalid('balance')}
                />
              )}
            </div>
            {problemText('balance')}
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
              <label className="te-fieldlabel" htmlFor={`${uid}-name`}>
                Name
              </label>
              <input id={`${uid}-name`} ref={fieldRef('name')} className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} {...invalid('name')} />
              {problemText('name')}
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Note</span>
              <input className="te-fieldvalue" type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. fixed term to Jan 2030" />
            </div>
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor={`${uid}-apr`}>
                APR (%/yr)
              </label>
              <input
                id={`${uid}-apr`}
                ref={fieldRef('apr')}
                className="te-fieldvalue"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.apr_pct}
                onChange={(e) => set('apr_pct', e.target.value)}
                {...invalid('apr')}
              />
              {problemText('apr')}
            </div>
            <div className="te-fieldcell">
              <label className="te-fieldlabel" htmlFor={`${uid}-minimum`}>
                Minimum (AED/mo)
              </label>
              <input
                id={`${uid}-minimum`}
                ref={fieldRef('minimum')}
                className="te-fieldvalue"
                type="number"
                min="0"
                step="0.01"
                value={form.minimum_payment}
                onChange={(e) => set('minimum_payment', e.target.value)}
                {...invalid('minimum')}
              />
              {problemText('minimum')}
            </div>
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Original amount</span>
              <input className="te-fieldvalue" type="number" step="0.01" value={form.original_amount} onChange={(e) => set('original_amount', e.target.value)} placeholder="optional — for a paid-down bar" />
            </div>
          </div>

          <div>
            <span className="te-fieldlabel">Owner</span>
            {linked ? (
              <div className="ov-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                {linkedOwnerName}, as {linked.name} is in Wealth, where its owner is changed.
              </div>
            ) : (
              <div className="om-scope-list" style={{ marginTop: 10 }}>
                <button type="button" className="om-scope" data-active={form.owner === 'shared'} aria-pressed={form.owner === 'shared'} onClick={() => set('owner', 'shared')}>
                  Shared
                </button>
                {members.map((m) => (
                  <button key={m.id} type="button" className="om-scope" data-active={form.owner === m.id} aria-pressed={form.owner === m.id} onClick={() => set('owner', m.id)}>
                    {m.display_name}
                  </button>
                ))}
              </div>
            )}
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
