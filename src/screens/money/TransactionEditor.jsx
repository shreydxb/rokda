import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import { formatMoney, formatSigned } from '../../lib/money';
import { signedAmount } from '../../lib/intake';
import { findDuplicate } from '../../lib/duplicates';
import { CURRENCIES, currencyAvailable, convertToAed, rateNote } from '../../lib/currency';
import './TransactionEditor.css';

const FIELD_LABELS = { category: 'Category', amount: 'Amount', account: 'Account', merchant: 'Merchant', scope: 'Scope' };

function initialForm(tx, accounts) {
  if (tx) {
    return {
      // A refund is stored positive, like income, but is neither — its own
      // persisted `kind` is what says which it is (SHR-252). Falling back to
      // sign only covers a row from before `kind` existed.
      type: tx.kind ?? (Number(tx.amount) >= 0 ? 'income' : 'expense'),
      amount: String(Math.abs(Number(tx.amount))),
      merchant: tx.merchant ?? '',
      occurred_at: tx.occurred_at,
      account_id: tx.account_id ?? '',
      category_id: tx.category_id ?? '',
      owner: tx.is_shared ? 'shared' : (tx.owner_member_id ?? ''),
      note: tx.note ?? '',
      needs_review: !!tx.needs_review,
      // The amount field always holds the AED figure a record was saved
      // with, so editing an existing record re-shows it in AED even if it
      // was originally entered in another currency -- only a brand-new
      // entry gets to pick a currency and have it converted on save.
      entry_currency: 'AED',
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
    entry_currency: 'AED',
  };
}

// Diffs the form against the record as it was loaded, one entry per
// changed field the acceptance criteria calls out. Only meaningful for an
// edit — there's nothing to diff against on a create.
function buildEdits(tx, form, { accounts, categories, members }) {
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? 'Unknown account';
  const categoryName = (id) => (id ? (categories.find((c) => c.id === id)?.name ?? 'Unknown category') : 'Uncategorised');
  const scopeLabel = (isShared, ownerId) => (isShared ? 'Shared' : (members.find((m) => m.id === ownerId)?.display_name ?? 'Unknown member'));

  const changes = [];

  const oldCategoryId = tx.category_id ?? null;
  const newCategoryId = form.category_id || null;
  if (oldCategoryId !== newCategoryId) {
    changes.push({ field: 'category', old_value: categoryName(oldCategoryId), new_value: categoryName(newCategoryId) });
  }

  const oldAmount = Number(tx.amount);
  const newAmount = form.type === 'income' ? Math.abs(Number(form.amount)) : -Math.abs(Number(form.amount));
  if (Math.abs(oldAmount - newAmount) > 0.001) {
    changes.push({ field: 'amount', old_value: formatSigned(oldAmount), new_value: formatSigned(newAmount) });
  }

  if (tx.account_id !== form.account_id) {
    changes.push({ field: 'account', old_value: accountName(tx.account_id), new_value: accountName(form.account_id) });
  }

  const oldMerchant = (tx.merchant ?? '').trim();
  const newMerchant = form.merchant.trim();
  if (oldMerchant !== newMerchant) {
    changes.push({ field: 'merchant', old_value: oldMerchant || '(none)', new_value: newMerchant || '(none)' });
  }

  const oldShared = tx.is_shared;
  const oldOwner = tx.owner_member_id ?? null;
  const newShared = form.owner === 'shared';
  const newOwner = newShared ? null : form.owner;
  if (oldShared !== newShared || oldOwner !== newOwner) {
    changes.push({ field: 'scope', old_value: scopeLabel(oldShared, oldOwner), new_value: scopeLabel(newShared, newOwner) });
  }

  return changes;
}

export default function TransactionEditor({ tx, household, householdId, accounts, categories, members, allTransactions, initial, onClose, onSaved, onOpenOther }) {
  // Closed accounts aren't offered for new entries, but an existing record that
  // already points at one keeps it so saving doesn't move it (QA-01).
  const selectable = selectableAccounts(accounts, tx?.account_id ?? null);
  // `initial` only ever pre-fills a genuinely NEW entry (e.g. Recurring's
  // "Mark paid", which opens this same editor pre-filled from the bill
  // rather than posting a transaction on its own guess of the account) --
  // it's spread after initialForm's create-mode defaults, never touching
  // the tx-vs-null branch everything else (insert/update, dialog title,
  // delete button) still decides on.
  const [form, setForm] = useState(() => ({
    ...initialForm(tx, selectableAccounts(accounts, tx?.account_id ?? null)),
    ...(!tx && initial ? initial : {}),
  }));
  const [dirty, setDirty] = useState(false);
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(!!tx);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, confirmingClose]);

  useEffect(() => {
    if (!tx) return;
    let cancelled = false;
    supabase
      .from('transaction_edits')
      .select('*')
      .eq('transaction_id', tx.id)
      .order('edited_at', { ascending: false })
      .then(({ data }) => {
        if (!cancelled) {
          setHistory(data ?? []);
          setHistoryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tx]);

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

  const amountAed = convertToAed(Number(form.amount) || 0, form.entry_currency, household);
  const amountError =
    form.amount.trim() === '' || Number(form.amount) <= 0
      ? 'Enter an amount greater than zero.'
      : amountAed === null
        ? `No exchange rate for ${form.entry_currency} yet — set one in Settings first.`
        : '';
  const accountError = !form.account_id ? 'Choose an account.' : '';
  // A refund reverses an earlier expense, so it draws from the same category
  // list as an expense rather than having none at all.
  const categoryKind = form.type === 'refund' ? 'expense' : form.type;
  const kindCategories = categories.filter((c) => c.kind === categoryKind && (!c.archived || c.id === form.category_id));
  const mainCategories = kindCategories.filter((c) => !c.parent_id);
  const selectedCategory = kindCategories.find((c) => c.id === form.category_id);
  const selectedMainId = selectedCategory ? (selectedCategory.parent_id || selectedCategory.id) : '';
  const subcategories = kindCategories.filter((c) => c.parent_id === selectedMainId);

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

    const payload = {
      household_id: householdId,
      account_id: form.account_id,
      category_id: form.category_id || null,
      amount: signedAmount(amountAed, form.type),
      kind: form.type,
      currency: form.entry_currency,
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
    if (saveError) {
      setSaving(false);
      setError(saveError.message);
      return;
    }

    if (tx) {
      const changes = buildEdits(tx, form, { accounts, categories, members });
      if (changes.length > 0) {
        const { error: historyError } = await supabase.from('transaction_edits').insert(
          changes.map((c) => ({ transaction_id: tx.id, field: c.field, old_value: c.old_value, new_value: c.new_value }))
        );
        if (historyError) {
          // The transaction itself is already saved — only the audit trail
          // failed to record — so surface it without implying the save
          // didn't happen, and let the user close manually rather than
          // silently losing the entry.
          setSaving(false);
          setError(`Transaction saved, but its edit history couldn't be recorded: ${historyError.message}`);
          return;
        }
      }
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
            <button type="button" className="om-seg" data-active={form.type === 'refund'} onClick={() => set('type', 'refund')}>
              Refund
            </button>
          </div>

          <div>
            <div className="te-hero-label">Amount</div>
            <div className="te-hero-row">
              <select
                className="te-hero-currency te-hero-currency-select"
                value={form.entry_currency}
                onChange={(e) => set('entry_currency', e.target.value)}
              >
                {CURRENCIES.filter((code) => currencyAvailable(code, household)).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
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
            {form.entry_currency !== 'AED' && amountAed !== null && (
              <div className="ov-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                ≈ {formatMoney(amountAed)} AED · {rateNote(form.entry_currency, household)}
              </div>
            )}
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

          <div className="te-fieldgrid">
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Category</span>
              <select
                className="te-fieldvalue"
                value={selectedMainId}
                onChange={(e) => set('category_id', e.target.value)}
              >
                <option value="">Uncategorised</option>
                {mainCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            {subcategories.length > 0 && (
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Subcategory</span>
                <select
                  className="te-fieldvalue"
                  value={selectedCategory?.parent_id ? form.category_id : ''}
                  onChange={(e) => set('category_id', e.target.value || selectedMainId)}
                >
                  <option value="">General</option>
                  {subcategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
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

          {tx && (
            <div>
              <span className="te-fieldlabel">History</span>
              <div style={{ marginTop: 8 }}>
                {historyLoading ? (
                  <div className="ov-muted" style={{ fontSize: 12 }}>
                    Loading…
                  </div>
                ) : history.length === 0 ? (
                  <div className="ov-muted" style={{ fontSize: 12 }}>
                    No edits yet.
                  </div>
                ) : (
                  <div className="mn-list">
                    {history.map((h) => (
                      <div key={h.id} className="mn-row" style={{ cursor: 'default' }}>
                        <div className="ov-muted" style={{ fontSize: 12 }}>
                          {FIELD_LABELS[h.field] ?? h.field}: {h.old_value ?? '—'} → {h.new_value ?? '—'} ·{' '}
                          {members.find((m) => m.id === h.edited_by)?.display_name ?? 'Unknown member'} ·{' '}
                          {new Date(h.edited_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

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
