import { useState } from 'react';
import { useCloseGuard } from '../../lib/useCloseGuard';
import DiscardPrompt from '../DiscardPrompt';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { ACCOUNT_TYPE_LABELS, COMPOUNDING_LABELS, closurePlan, isArchived } from '../../lib/accounts';
import { isBalanceConfirmed } from '../../lib/balance';
import { todayISODate } from '../../lib/valuation';
import { householdToday } from '../../lib/day';
import '../money/TransactionEditor.css';
import OwnerPicker from '../OwnerPicker';


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
      principal: account.principal !== null ? String(account.principal) : '',
      interest_rate_pct: account.interest_rate_pct !== null ? String(account.interest_rate_pct) : '',
      compounding: account.compounding ?? 'simple',
      opened_date: account.opened_date ?? '',
      maturity_date: account.maturity_date ?? '',
      dividends_into: account.dividends_into_account_id ?? '',
    };
  }
  return {
    name: '',
    type: defaultType ?? 'checking',
    currency: 'AED',
    balance: '',
    owner: 'shared',
    credit_limit: '',
    statement_day: '',
    due_day: '',
    principal: '',
    interest_rate_pct: '',
    compounding: 'simple',
    opened_date: '',
    maturity_date: '',
    dividends_into: '',
  };
}

export default function AccountEditor({ account, defaultType, householdId, members, accounts = [], transactions = [], onClose, onSaved }) {
  const drawerRef = useDrawerFocus();
  const [form, setForm] = useState(() => initialForm(account, defaultType));
  // A balance is a claim someone makes as of a date. Until it is confirmed it
  // stays unknown rather than becoming a confident zero (QA-02).
  const [confirmBalance, setConfirmBalance] = useState(() => !account || !isBalanceConfirmed(account));
  const [balanceAsOf, setBalanceAsOf] = useState(() => todayISODate());
  const [dirty, setDirty] = useState(false);
  const { confirmingClose, requestClose, keepEditing } = useCloseGuard({ dirty, onClose });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // The database refused to delete the account because trades went through
  // it; from then on the only way to remove it is to close it.
  const [deleteRefused, setDeleteRefused] = useState(false);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  }

  const nameError = form.name.trim() === '' ? 'Name it.' : '';
  const isCard = form.type === 'credit_card';
  const isLoan = form.type === 'loan';
  const isFd = form.type === 'fd';

  function startNewTerm() {
    setForm((f) => ({
      ...f,
      principal: String(account?.balance ?? f.principal),
      opened_date: householdToday(),
      maturity_date: '',
    }));
    setDirty(true);
  }

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
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      credit_limit: isCard && form.credit_limit ? Number(form.credit_limit) : null,
      statement_day: isCard && form.statement_day ? Number(form.statement_day) : null,
      due_day: isCard && form.due_day ? Number(form.due_day) : null,
      principal: isFd && form.principal ? Number(form.principal) : null,
      interest_rate_pct: isFd && form.interest_rate_pct ? Number(form.interest_rate_pct) : null,
      compounding: isFd ? form.compounding : null,
      opened_date: isFd && form.opened_date ? form.opened_date : null,
      maturity_date: isFd && form.maturity_date ? form.maturity_date : null,
      // Only a broker fund names where its dividends land (SHR-366); the
      // database refuses one on any other account.
      dividends_into_account_id: form.type === 'broker_funds' ? form.dividends_into || null : null,
      updated_at: new Date().toISOString(),
      // Only an explicit confirmation dates the balance, and only for a
      // manually-claimed balance -- an FD's value is computed server-side
      // from principal/rate/dates, never a claim someone is confirming, so
      // it never gets a balance_as_of stamp.
      ...(!isFd && confirmBalance ? { balance_as_of: new Date(`${balanceAsOf}T00:00:00Z`).toISOString() } : {}),
    };
    // The balance is sent only when it was typed here, or when the type
    // changed and the loan rule below may change how it is stored. A trade
    // moves a broker fund's balance while this editor may be open, and
    // sending the figure it opened with would put the old balance back
    // (SHR-367).
    if (!account || form.balance !== initialForm(account).balance || form.type !== account.type) {
      // A loan's balance is the amount owed, and a loan cannot be in credit,
      // so a loan typed below zero is stored as what it owes. Net worth read
      // a negative loan as money held (Planning audit, 0b-D).
      payload.balance = isLoan ? Math.abs(Number(form.balance) || 0) : Number(form.balance) || 0;
    }

    // An update reads back the row it changed: none means the account was
    // deleted elsewhere, and closing as if saved hid that (outside review,
    // E-10).
    const query = account
      ? supabase.from('accounts').update(payload).eq('id', account.id).select('id')
      : supabase.from('accounts').insert(payload);

    const { data: changed, error: saveError } = await query;
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    if (account && (changed?.length ?? 0) !== 1) {
      setError("This account wasn't saved: it may have been deleted elsewhere. Close it and refresh.");
      return;
    }
    await onSaved();
  }

  // Closing keeps the ledger; deleting is only offered for an account that was
  // never used. The foreign key enforces the same rule server-side (QA-01).
  const plan = account
    ? deleteRefused
      ? {
          ...closurePlan(account, transactions),
          action: 'archive',
          title: 'Close this account?',
          detail: 'It stops being offered for new entries; everything recorded through it stays.',
        }
      : closurePlan(account, transactions)
    : null;

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
    // A foreign key refused the delete: trades went through this account (a
    // broker fund), which the transactions above do not show. Closing keeps
    // them, so that is what is offered instead of the database's error.
    if (mutationError && plan.action === 'delete' && mutationError.code === '23503') {
      setDeleteRefused(true);
      setConfirmingDelete(false);
      setError("Money moved through this account in recorded trades, so it can't be deleted. Close it instead: everything recorded through it stays.");
      return;
    }
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
      <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={account ? 'Edit account' : 'Add account'}>
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
            <div className="te-hero-label">{isCard ? 'Balance owed' : isLoan ? 'Amount owed' : isFd ? 'Current value (auto-calculated)' : 'Current balance'}</div>
            <div className="te-hero-row">
              <span className="te-hero-currency">{form.currency || 'AED'}</span>
              {isFd ? (
                <span className="te-hero-input" style={{ display: 'flex', alignItems: 'center' }}>
                  {account ? Number(account.balance).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                </span>
              ) : (
                <input aria-label={isCard ? 'Balance owed' : isLoan ? 'Amount owed' : isFd ? 'Current value (auto-calculated)' : 'Current balance'}
                  type="number"
                  step="0.01"
                  className="te-hero-input"
                  value={form.balance}
                  onChange={(e) => {
                    set('balance', e.target.value);
                    setConfirmBalance(true);
                  }}
                  placeholder="0"
                />
              )}
            </div>
            {isFd && (
              <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                Computed daily from principal, rate and dates below — never edited directly.
              </div>
            )}
            {isCard && (
              <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                A card in credit is entered below zero.
              </div>
            )}
          </div>

          {isFd && account?.fd_status === 'matured' && (
            <div className="ov-warn" role="alert" style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span>This fixed deposit has matured at {Number(account.balance).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Roll it into a new term?</span>
              <button type="button" className="om-btn" onClick={startNewTerm}>
                Start new term
              </button>
            </div>
          )}

          {!isFd && (
            <>
              <div className="te-fieldgrid">
                <div className="te-fieldcell te-span2">
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                    <input type="checkbox" checked={confirmBalance} onChange={(e) => setConfirmBalance(e.target.checked)} />
                    <span>Confirm this balance{form.balance.trim() === '' || Number(form.balance) === 0 ? ' — including that it is zero' : ''}</span>
                  </label>
                </div>
                <div className="te-fieldcell">
                  <label className="te-fieldlabel" htmlFor="balance-as-of">
                    Balance as of
                  </label>
                  <input
                    id="balance-as-of"
                    className="te-fieldvalue"
                    type="date"
                    value={balanceAsOf}
                    max={todayISODate()}
                    disabled={!confirmBalance}
                    onChange={(e) => setBalanceAsOf(e.target.value)}
                  />
                </div>
              </div>
              <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -10 }}>
                {confirmBalance
                  ? 'Balances are manual snapshots — this records what you say it is, as of that date.'
                  : account && isBalanceConfirmed(account)
                    ? 'Leaving this unticked keeps the existing balance and its date.'
                    : 'Until you confirm it, this balance is shown as not set rather than as a zero.'}
              </div>
            </>
          )}

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Name</span>
              <input aria-label="Name" className="te-fieldvalue" type="text" value={form.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!nameError} placeholder="e.g. ADCB Savings" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Type</span>
              <select aria-label="Type" className="te-fieldvalue" value={form.type} onChange={(e) => set('type', e.target.value)}>
                {Object.entries(ACCOUNT_TYPE_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Currency</span>
              <input aria-label="Currency" className="te-fieldvalue" type="text" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
            </div>
            {form.type === 'broker_funds' && (
              <div className="te-fieldcell te-span2">
                <label className="te-fieldlabel" htmlFor="dividends-into">
                  Dividends paid into
                </label>
                <select id="dividends-into" className="te-fieldvalue" value={form.dividends_into} onChange={(e) => set('dividends_into', e.target.value)}>
                  <option value="">This fund</option>
                  {accounts
                    .filter((a) => a.id !== account?.id && a.currency === form.currency && !isArchived(a))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                  Where this broker&apos;s dividends land. Indian companies pay the bank account linked to the demat account.
                </div>
              </div>
            )}
            {isCard && (
              <>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Credit limit</span>
                  <input aria-label="Credit limit" className="te-fieldvalue" type="number" step="0.01" value={form.credit_limit} onChange={(e) => set('credit_limit', e.target.value)} />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Statement day</span>
                  <input aria-label="Statement day" className="te-fieldvalue" type="number" min="1" max="31" value={form.statement_day} onChange={(e) => set('statement_day', e.target.value)} />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Due day</span>
                  <input aria-label="Due day" className="te-fieldvalue" type="number" min="1" max="31" value={form.due_day} onChange={(e) => set('due_day', e.target.value)} />
                </div>
              </>
            )}
            {isFd && (
              <>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Principal</span>
                  <input aria-label="Principal" className="te-fieldvalue" type="number" step="0.01" value={form.principal} onChange={(e) => set('principal', e.target.value)} placeholder="e.g. 100000" />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Interest rate (annual %)</span>
                  <input aria-label="Interest rate (annual %)" className="te-fieldvalue" type="number" step="0.01" value={form.interest_rate_pct} onChange={(e) => set('interest_rate_pct', e.target.value)} placeholder="e.g. 4.5" />
                </div>
                <div className="te-fieldcell te-span2">
                  <span className="te-fieldlabel">Compounding</span>
                  <select aria-label="Compounding" className="te-fieldvalue" value={form.compounding} onChange={(e) => set('compounding', e.target.value)}>
                    {Object.entries(COMPOUNDING_LABELS).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Opened</span>
                  <input aria-label="Opened" className="te-fieldvalue" type="date" value={form.opened_date} onChange={(e) => set('opened_date', e.target.value)} />
                </div>
                <div className="te-fieldcell">
                  <span className="te-fieldlabel">Maturity date</span>
                  <input aria-label="Maturity date" className="te-fieldvalue" type="date" value={form.maturity_date} onChange={(e) => set('maturity_date', e.target.value)} />
                </div>
              </>
            )}
          </div>

          <div>
            <span className="te-fieldlabel">Owner</span>
            <OwnerPicker value={form.owner} members={members} onChange={(id) => set('owner', id)} />
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
                    <DiscardPrompt onDiscard={onClose} onKeepEditing={keepEditing} />
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
