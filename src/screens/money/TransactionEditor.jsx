import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import { formatMoney, formatSigned } from '../../lib/money';
import { signedAmount } from '../../lib/intake';
import { confirmedPairRow, findDuplicate } from '../../lib/duplicates';
import { CURRENCIES, currencyAvailable } from '../../lib/currency';
import { estimateAed } from '../../lib/fxHistory';
import { householdToday, parseDay } from '../../lib/day';
import { orderPair, transferCandidates } from '../../lib/transfers';
import { splitProblem, unallocated } from '../../lib/splits';
import { refundCandidates, refundLinkOf, refundsOf } from '../../lib/refunds';
import './TransactionEditor.css';

const FIELD_LABELS = { kind: 'Type', category: 'Category', amount: 'Amount', native_amount: 'Amount paid', account: 'Account', merchant: 'Merchant', scope: 'Scope', refund_for: 'Refund for' };
const KIND_LABELS = { expense: 'Expense', income: 'Income', refund: 'Refund' };

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
      // A payment in another currency opens in that currency, with the AED
      // debited beside it, or blank while the AED is still an estimate
      // (docs/decisions.md, "A payment in rupees keeps both amounts").
      ...(foreignOf(tx)
        ? { entry_currency: tx.currency, amount: String(Math.abs(Number(tx.native_amount))), aed_debited: tx.aed_estimated ? '' : String(Math.abs(Number(tx.amount))) }
        : { entry_currency: 'AED', aed_debited: '' }),
    };
  }
  return {
    type: 'expense',
    amount: '',
    merchant: '',
    occurred_at: householdToday(),
    account_id: accounts[0]?.id ?? '',
    category_id: '',
    owner: 'shared',
    note: '',
    needs_review: false,
    entry_currency: 'AED',
    aed_debited: '',
  };
}

// Which rate an estimate used, in words: "1 AED = 23.5 INR, the rate on
// 2 Sept 2026", the dollar peg, or today's rate when history has nothing for
// the date.
function estimateNote(estimate, currency) {
  if (estimate.source === 'peg') return 'the dollar peg (1 USD = 3.6725 AED)';
  const rate = `1 AED = ${estimate.rate.toLocaleString('en-IN', { maximumFractionDigits: 4 })} ${currency}`;
  if (estimate.source === 'current') return `today's rate, ${rate}, as none is on record for that date`;
  return `${rate}, the rate on ${parseDay(estimate.rateDay).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// Whether a saved record was made in another currency.
const foreignOf = (tx) => !!tx && tx.native_amount != null && !!tx.currency && tx.currency !== 'AED';
const signedNative = (n, type) => (n == null ? null : type === 'expense' ? -Math.abs(n) : Math.abs(n));

// Diffs the form against the record as it was loaded, one entry per
// changed field the acceptance criteria calls out. Only meaningful for an
// edit — there's nothing to diff against on a create. `savedAmount` is the
// signed amount the save writes, so the history compares like with like: a
// refund is stored positive, and diffing it as a negative recorded "+75 →
// −75" on a save that changed nothing (QA, 15 Oct).
function buildEdits(tx, form, savedAmount, { accounts, categories, members, splitChanging = false, savedNative = { currency: 'AED', amount: null } }) {
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? 'Unknown account';
  const categoryName = (id) => (id ? (categories.find((c) => c.id === id)?.name ?? 'Unknown category') : 'Uncategorised');
  const scopeLabel = (isShared, ownerId) => (isShared ? 'Shared' : (members.find((m) => m.id === ownerId)?.display_name ?? 'Unknown member'));

  const changes = [];

  // A refund turned into income keeps its sign and amount, so only its type
  // says it changed.
  const oldKind = tx.kind ?? (Number(tx.amount) >= 0 ? 'income' : 'expense');
  if (oldKind !== form.type) {
    changes.push({ field: 'kind', old_value: KIND_LABELS[oldKind] ?? oldKind, new_value: KIND_LABELS[form.type] ?? form.type });
  }

  // Splitting or unsplitting records its own category change (in the
  // database function that does it), so it isn't recorded twice here.
  const oldCategoryId = tx.category_id ?? null;
  const newCategoryId = form.category_id || null;
  if (!splitChanging && oldCategoryId !== newCategoryId) {
    changes.push({ field: 'category', old_value: categoryName(oldCategoryId), new_value: categoryName(newCategoryId) });
  }

  const oldAmount = Number(tx.amount);
  const newAmount = Number(savedAmount);
  if (Math.abs(oldAmount - newAmount) > 0.001) {
    changes.push({ field: 'amount', old_value: formatSigned(oldAmount), new_value: formatSigned(newAmount) });
  }

  // The amount in the currency it was paid in, when that is not AED.
  const paid = (currency, amount) => (amount == null ? 'AED only' : `${currency} ${formatSigned(amount, { decimals: 2 })}`);
  const oldPaid = paid(tx.currency, foreignOf(tx) ? Number(tx.native_amount) : null);
  const newPaid = paid(savedNative.currency, savedNative.amount);
  if (oldPaid !== newPaid) changes.push({ field: 'native_amount', old_value: oldPaid, new_value: newPaid });

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

export default function TransactionEditor({ tx, household, householdId, accounts, categories, members, allTransactions = [], links = [], fxHistory = [], initial, onClose, onSaved, onOpenOther, onSwitchToTransfer }) {
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
  // The record "Both are real" was said about, remembered as a confirmed pair
  // once this one is saved, so the monthly review doesn't ask again.
  const [keptAlongside, setKeptAlongside] = useState(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // The categories one record is split across (lib/splits.js): null when it
  // has one category, otherwise its lines as typed, amounts positive and AED.
  const [split, setSplit] = useState(() =>
    tx?.is_split ? (tx.transaction_splits ?? []).map((l) => ({ category_id: l.category_id, amount: String(Math.abs(Number(l.amount))) })) : null,
  );
  function setLines(lines) {
    setSplit(lines);
    setDirty(true);
  }
  // The purchase a refund returns (lib/refunds.js): chosen here, linked on
  // save by link_refund(), which also gives the refund the purchase's
  // category.
  const [refundFor, setRefundFor] = useState(null);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
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
    if (key === 'merchant' || key === 'amount' || key === 'occurred_at' || key === 'account_id') {
      setDuplicateDismissed(false);
      setKeptAlongside(null);
    }
  }

  function requestClose() {
    if (dirty && !confirmingClose) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  // In another currency, `amount` is what was paid in it, and the AED that
  // counts is the AED debited when it is known, otherwise an estimate at the
  // payment date's rate (lib/fxHistory.js), marked as one.
  const foreign = form.entry_currency !== 'AED';
  const typed = Number(form.amount) || 0;
  const debited = foreign && form.aed_debited.trim() !== '' ? Number(form.aed_debited) : null;
  const estimate = foreign ? estimateAed(typed, form.entry_currency, form.occurred_at, fxHistory, household?.inr_per_aed) : null;
  const aedEstimated = foreign && debited == null;
  const amountAed = !foreign ? typed : debited != null ? debited : (estimate?.aed ?? null);
  const amountError =
    form.amount.trim() === '' || Number(form.amount) <= 0
      ? 'Enter an amount greater than zero.'
      : debited != null && !(debited > 0)
        ? 'Enter the AED debited as an amount greater than zero, or leave it blank to estimate it.'
        : amountAed === null
          ? `No exchange rate for ${form.entry_currency} on that date. Enter the AED debited.`
          : '';
  const accountError = !form.account_id ? 'Choose an account.' : '';
  // A refund reverses an earlier expense, so it draws from the same category
  // list as an expense rather than having none at all.
  const categoryKind = form.type === 'refund' ? 'expense' : form.type;
  // Savings categories hold money set aside, not spent, so nothing new is
  // filed under them; a record already there keeps showing where it is.
  const kindCategories = categories.filter((c) => c.kind === categoryKind && ((!c.archived && !c.is_savings) || c.id === form.category_id));
  const mainCategories = kindCategories.filter((c) => !c.parent_id);
  const selectedCategory = kindCategories.find((c) => c.id === form.category_id);
  const selectedMainId = selectedCategory ? (selectedCategory.parent_id || selectedCategory.id) : '';
  const subcategories = kindCategories.filter((c) => c.parent_id === selectedMainId);

  const duplicate = useMemo(
    () => (tx ? null : duplicateDismissed ? null : findDuplicate(form, allTransactions, tx?.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.merchant, form.amount, form.occurred_at, form.account_id, allTransactions, duplicateDismissed, tx]
  );

  const refundLink = tx ? refundLinkOf(tx.id, links) : null;
  const linkedPurchase = refundLink ? (allTransactions.find((t) => t.id === refundLink.from_transaction_id) ?? null) : null;
  const purchaseRefunds = tx && form.type === 'expense' ? refundsOf(tx.id, links, allTransactions) : [];
  const refundSuggestions = useMemo(
    () =>
      form.type === 'refund' && !refundLink
        ? refundCandidates(
            { id: tx?.id, account_id: form.account_id, merchant: form.merchant, amount: amountAed ?? 0, occurred_at: form.occurred_at },
            allTransactions,
            links,
          ).slice(0, 3)
        : [],
    [form.type, form.account_id, form.merchant, form.occurred_at, amountAed, refundLink, tx?.id, allTransactions, links],
  );
  const accountName = (id) => accounts.find((a) => a.id === id)?.name ?? 'Another account';
  const shortDay = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  async function handleSave(e) {
    e.preventDefault();
    // A transfer is edited as a pair, in TransferEditor. This one's other side
    // or link didn't load, so it can't be edited here without breaking the
    // pair (the database would refuse it anyway).
    if (form.type === 'transfer') {
      setError("This is one side of a transfer whose other side couldn't be loaded. Refresh the page and open it again.");
      return;
    }
    const linesError = split ? splitProblem(split, amountAed) : '';
    if (amountError || accountError || linesError) {
      setError(amountError || accountError || linesError);
      return;
    }
    setSaving(true);
    setError('');

    // A linked refund stops being one only once it is unlinked from its
    // purchase; the database refuses the change otherwise.
    if (refundLink && form.type !== 'refund') {
      const { error: unlinkError } = await supabase.rpc('unlink_refund', { p_link_id: refundLink.id });
      if (unlinkError) {
        setSaving(false);
        setError(unlinkError.message);
        return;
      }
    }

    const lines = split ? split.map((l) => ({ category_id: l.category_id, amount: Number(l.amount) })) : null;
    // Was split and no longer is: one category again first, so the update
    // below can set it.
    if (tx?.is_split && !split) {
      const { error: unsplitError } = await supabase.rpc('unsplit_transaction', { p_transaction_id: tx.id, p_category_id: form.category_id || null });
      if (unsplitError) {
        setSaving(false);
        setError(unsplitError.message);
        return;
      }
    }

    const payload = {
      household_id: householdId,
      account_id: form.account_id,
      category_id: form.category_id || null,
      amount: signedAmount(amountAed, form.type),
      kind: form.type,
      currency: form.entry_currency,
      native_amount: foreign ? signedNative(typed, form.type) : null,
      aed_estimated: aedEstimated,
      merchant: form.merchant.trim() || null,
      note: form.note.trim() || null,
      occurred_at: form.occurred_at,
      is_shared: form.owner === 'shared',
      owner_member_id: form.owner === 'shared' ? null : form.owner,
      needs_review: form.needs_review,
    };

    // A split's amount and categories are set with its lines, in one call
    // after this one, so the database never sees a total its lines don't
    // add up to.
    if (split) {
      payload.category_id = null;
      if (tx) delete payload.amount;
    }

    const linking = form.type === 'refund' && !refundLink && refundFor;
    const query = tx
      ? supabase.from('transactions').update(payload).eq('id', tx.id).select('id')
      : split || linking || keptAlongside
        ? supabase.from('transactions').insert(payload).select('id').single()
        : supabase.from('transactions').insert(payload);

    const { data: inserted, error: saveError } = await query;
    if (saveError) {
      setSaving(false);
      setError(saveError.message);
      return;
    }
    // An update that changed no row was not a save: the record was deleted
    // elsewhere, or the change wasn't allowed. Nothing after it (the split,
    // the history) runs, and the editor stays open (QA re-review, 17 October).
    if (tx && (inserted?.length ?? 0) !== 1) {
      setSaving(false);
      setError("This record wasn't saved: it may have been deleted or changed elsewhere. Close it, refresh, and open it again.");
      return;
    }

    if (split) {
      const { error: splitError } = await supabase.rpc('split_transaction', {
        p_transaction_id: tx ? tx.id : inserted.id,
        p_lines: lines,
        p_amount: amountAed,
      });
      if (splitError) {
        setSaving(false);
        setError(tx ? splitError.message : `Saved, but not split: ${splitError.message}. Open it again to split it.`);
        return;
      }
    }

    if (linking) {
      const { error: linkError } = await supabase.rpc('link_refund', { p_purchase_id: refundFor, p_refund_id: tx ? tx.id : inserted.id });
      if (linkError) {
        setSaving(false);
        setError(tx ? linkError.message : `Saved, but not linked to the purchase: ${linkError.message}. Open it again to link it.`);
        return;
      }
    }

    if (!tx && keptAlongside) {
      const { error: pairError } = await supabase.from('transaction_links').insert(confirmedPairRow(householdId, { id: inserted.id }, keptAlongside));
      if (pairError) {
        setSaving(false);
        setError(`Saved, but "both are real" wasn't remembered: ${pairError.message}. The monthly review will ask about the pair again.`);
        return;
      }
    }

    if (tx) {
      const changes = buildEdits(tx, form, signedAmount(amountAed, form.type), {
        accounts,
        categories,
        members,
        splitChanging: !!split || !!tx.is_split,
        savedNative: { currency: form.entry_currency, amount: foreign ? signedNative(typed, form.type) : null },
      });
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

  // A record whose other side is already in the ledger (the card payment out
  // of the current account, and the same payment arriving on the card) can be
  // made one transfer, so neither counts as income or spending.
  const pairs = useMemo(() => (tx ? transferCandidates(tx, allTransactions ?? []) : []), [tx, allTransactions]);
  async function makeTransfer(other) {
    const { out, in: into } = orderPair(tx, other);
    setSaving(true);
    setError('');
    const { error: linkError } = await supabase.rpc('link_transfer', { p_out_transaction_id: out.id, p_in_transaction_id: into.id });
    setSaving(false);
    if (linkError) {
      setError(linkError.message);
      return;
    }
    await onSaved();
  }

  async function unlinkRefund() {
    if (!confirmingUnlink) {
      setConfirmingUnlink(true);
      return;
    }
    setSaving(true);
    setError('');
    const { error: unlinkError } = await supabase.rpc('unlink_refund', { p_link_id: refundLink.id });
    setSaving(false);
    if (unlinkError) {
      setError(unlinkError.message);
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
            <button type="button" className="om-seg" data-active={form.type === 'refund'} onClick={() => set('type', 'refund')}>
              Refund
            </button>
            {!tx && onSwitchToTransfer && (
              <button type="button" className="om-seg" onClick={onSwitchToTransfer}>
                Transfer
              </button>
            )}
          </div>

          {pairs.length > 0 && (
            <div className="te-duplicate" role="status">
              <div className="te-duplicate-title">This looks like one side of a transfer</div>
              <div className="te-duplicate-body">
                The same amount went the other way on another account within a few days. If this was money moved between your own accounts, make the two one
                transfer: it then counts as neither income nor spending.
              </div>
              <div className="mn-list" style={{ marginTop: 8 }}>
                {pairs.slice(0, 3).map((p) => (
                  <div key={p.id} className="mn-row" style={{ cursor: 'default', alignItems: 'center' }}>
                    <div className="mn-row-main">
                      <div>{accounts.find((a) => a.id === p.account_id)?.name ?? 'Another account'}</div>
                      <div className="ov-muted">
                        {p.merchant || 'No merchant'} · {parseDay(p.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {formatSigned(p.amount)}
                      </div>
                    </div>
                    <button type="button" className="om-btn" disabled={saving} onClick={() => makeTransfer(p)}>
                      Make these one transfer
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

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
            {foreign && (
              <div className="te-aed-debited">
                <label className="te-fieldcell">
                  <span className="te-fieldlabel">AED debited</span>
                  <input
                    className="te-fieldvalue"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    aria-label="AED debited"
                    value={form.aed_debited}
                    onChange={(e) => set('aed_debited', e.target.value)}
                    placeholder={estimate ? formatMoney(Math.abs(estimate.aed), { decimals: 2 }) : 'From the statement'}
                  />
                </label>
                <div className="ov-muted" style={{ fontSize: 11.5 }}>
                  {debited != null
                    ? 'The AED that left the account, as the statement shows it. This is what every total counts.'
                    : estimate
                      ? `Estimated at ${estimateNote(estimate, form.entry_currency)} until you enter the AED debited.`
                      : `No ${form.entry_currency} rate for that date. Enter the AED debited.`}
                </div>
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
                <button
                  type="button"
                  className="om-btn"
                  onClick={() => {
                    setKeptAlongside(duplicate);
                    setDuplicateDismissed(true);
                  }}
                >
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

          {form.type === 'refund' && (
            <div className="te-refund" role="group" aria-label="Refund for">
              <span className="te-fieldlabel">Refund for</span>
              {refundLink ? (
                <div className="mn-row te-refund-row">
                  <div className="mn-row-main">
                    <div>{linkedPurchase ? linkedPurchase.merchant || 'Purchase' : 'A purchase that isn’t loaded'}</div>
                    {linkedPurchase && (
                      <div className="ov-muted">
                        {shortDay(linkedPurchase.occurred_at)} · {accountName(linkedPurchase.account_id)} · {formatSigned(linkedPurchase.amount)}
                      </div>
                    )}
                  </div>
                  <button type="button" className="om-btn" disabled={saving} onClick={unlinkRefund}>
                    {confirmingUnlink ? 'Unlink it?' : 'Unlink'}
                  </button>
                </div>
              ) : refundSuggestions.length > 0 ? (
                <>
                  <div className="ov-muted te-refund-note">Choose the purchase this returns. Saving links them, and the refund takes the purchase’s category.</div>
                  <div className="mn-list">
                    {refundSuggestions.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="mn-row te-refund-row"
                        aria-pressed={refundFor === p.id}
                        data-active={refundFor === p.id}
                        onClick={() => {
                          setRefundFor(refundFor === p.id ? null : p.id);
                          setDirty(true);
                        }}
                      >
                        <div className="mn-row-main">
                          <div>{p.merchant || 'Purchase'}</div>
                          <div className="ov-muted">
                            {shortDay(p.occurred_at)} · {accountName(p.account_id)}
                          </div>
                        </div>
                        <div className="fig">{formatSigned(p.amount)}</div>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="ov-muted te-refund-note">No earlier purchase from this shop or on this account in the last four months to link it to.</div>
              )}
            </div>
          )}

          {purchaseRefunds.length > 0 && (
            <div className="te-refund" role="group" aria-label="Refunded">
              <span className="te-fieldlabel">Refunded</span>
              <div className="mn-list">
                {purchaseRefunds.map((r) => (
                  <div key={r.id} className="mn-row te-refund-row" style={{ cursor: 'default' }}>
                    <div className="mn-row-main">
                      <div>{r.merchant || 'Refund'}</div>
                      <div className="ov-muted">
                        {shortDay(r.occurred_at)} · {accountName(r.account_id)}
                      </div>
                    </div>
                    <div className="fig ov-pos">{formatSigned(r.amount)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {split ? (
            <div className="te-split" role="group" aria-label="Split across categories">
              <span className="te-fieldlabel">Split across categories · AED</span>
              {split.map((line, n) => (
                <div key={n} className="te-split-line">
                  <select
                    className="te-fieldvalue"
                    aria-label={`Category ${n + 1}`}
                    value={line.category_id}
                    onChange={(e) => setLines(split.map((l, k) => (k === n ? { ...l, category_id: e.target.value } : l)))}
                  >
                    <option value="">Choose…</option>
                    {mainCategories.flatMap((c) => [c, ...kindCategories.filter((sub) => sub.parent_id === c.id)]).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.parent_id ? `– ${c.name}` : c.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="te-fieldvalue te-split-amount"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    aria-label={`Amount ${n + 1}`}
                    value={line.amount}
                    onChange={(e) => setLines(split.map((l, k) => (k === n ? { ...l, amount: e.target.value } : l)))}
                  />
                  <button type="button" className="te-split-remove" aria-label={`Remove line ${n + 1}`} disabled={split.length <= 2} onClick={() => setLines(split.filter((_, k) => k !== n))}>
                    ×
                  </button>
                </div>
              ))}
              <div className="te-split-foot">
                <button type="button" className="te-split-link" onClick={() => setLines([...split, { category_id: '', amount: '' }])}>
                  + Add a line
                </button>
                {/* What is still to place, so the lines visibly add up to the total. */}
                <span className={unallocated(split, amountAed ?? 0) === 0 ? 'ov-pos' : 'ov-warn'}>
                  {unallocated(split, amountAed ?? 0) === 0
                    ? 'Adds up'
                    : unallocated(split, amountAed ?? 0) > 0
                      ? `${formatMoney(unallocated(split, amountAed ?? 0), { decimals: 2 })} left to allocate`
                      : `${formatMoney(unallocated(split, amountAed ?? 0), { decimals: 2 })} over the total`}
                </span>
              </div>
              <button type="button" className="te-split-link" onClick={() => setLines(null)}>
                One category instead
              </button>
            </div>
          ) : (
            <>
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

              {form.type !== 'transfer' && (
                <button
                  type="button"
                  className="te-split-link"
                  onClick={() =>
                    // Starts from the category already chosen, holding the
                    // whole amount, and an empty second line to move some to.
                    setLines([
                      { category_id: form.category_id || '', amount: form.amount },
                      { category_id: '', amount: '' },
                    ])
                  }
                >
                  Split across categories
                </button>
              )}
            </>
          )}

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
