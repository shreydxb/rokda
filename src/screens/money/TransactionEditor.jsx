import { useMemo, useRef, useState } from 'react';
import { needsSubcategory } from '../../lib/fileableCategories';
import { useCloseGuard } from '../../lib/useCloseGuard';
import DiscardPrompt from '../DiscardPrompt';
import { useDrawerFocus } from '../../lib/useDrawerFocus';
import { supabase } from '../../lib/supabaseClient';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import { signedAmount } from '../../lib/intake';
import { findDuplicate } from '../../lib/duplicates';
import { orderPair, transferCandidates } from '../../lib/transfers';
import { splitProblem } from '../../lib/splits';
import { refundCandidates, refundLinkOf, refundsOf } from '../../lib/refunds';
import { rememberMerchantCheck, ruleLabel } from '../../lib/rules';
import { relatedRecords } from '../../lib/editHistory';
import { ENTRY_TYPES } from '../../lib/entryTypes';
import { amountFigures, buildEdits, initialForm, signedNative, transactionPayload } from '../../lib/transactionForm';
import { saveTransaction } from './saveTransaction';
import RememberMerchant from './RememberMerchant';
import EditHistory from './EditHistory';
import TransferPairs from './TransferPairs';
import TransactionAmount from './TransactionAmount';
import DuplicateNotice from './DuplicateNotice';
import RefundLinks from './RefundLinks';
import TransactionCategory from './TransactionCategory';
import './TransactionEditor.css';
import OwnerPicker from '../OwnerPicker';

// Closing a record whose merchant rule failed says so again in Activity.
const SAVED_WITHOUT_RULE = { text: 'Transaction saved; merchant rule wasn’t saved. Add it in Settings → Categories & rules.' };

// One empty list for every missing one: a fresh [] each render would undo
// the memos below that depend on them.
const NONE = [];

export default function TransactionEditor({ tx, household, householdId, accounts, categories, members, allTransactions = NONE, links = NONE, categoryRules = NONE, fxHistory = NONE, initial, onClose, onSaved, onOpenOther, onSwitchToTransfer }) {
  const drawerRef = useDrawerFocus();
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // The id of a new record already saved, when a step after the save failed,
  // and which of those steps have been done (saveTransaction.js).
  const saveMemory = useRef({ savedNewId: null, stepsDone: new Set() });
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
  // "Remember this merchant": a household rule added once the correction is
  // saved (docs/decisions.md, "A correction can remember its merchant"). Off
  // until ticked. The pattern follows the merchant field until it is edited.
  const [remember, setRemember] = useState(false);
  const [rulePattern, setRulePattern] = useState(null);
  const [ruleMatchType, setRuleMatchType] = useState('contains');
  // The rules as read back just before adding one, which are newer than the
  // page's copy; and, once the record is saved but its rule is not, why not.
  // From then on only the rule is retried: the record and its history are
  // never written twice.
  const [freshRules, setFreshRules] = useState(null);
  const [savedWithoutRule, setSavedWithoutRule] = useState(null);
  const guard = useCloseGuard({ dirty, onClose, onEscape: () => requestClose() });
  const { confirmingClose, keepEditing } = guard;

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    if (key === 'merchant' || key === 'amount' || key === 'occurred_at' || key === 'account_id') {
      setDuplicateDismissed(false);
      setKeptAlongside(null);
    }
  }

  function requestClose() {
    // Saved already, so there is nothing to discard; closing shows it.
    if (savedWithoutRule) {
      onSaved({ notice: SAVED_WITHOUT_RULE });
      return;
    }
    guard.requestClose();
  }

  // What the amount counts as in AED (lib/transactionForm.js).
  const figures = amountFigures(form, fxHistory, household?.inr_per_aed);
  const { foreign, typed, amountAed, amountError } = figures;
  const accountError = !form.account_id ? 'Choose an account.' : '';
  // A group with subcategories is not where a record newly goes
  // (lib/fileableCategories.js); one already filed there may stay.
  const groupChosen = !split && form.category_id !== (tx?.category_id ?? null) && needsSubcategory(categories, form.category_id);
  const categoryError = groupChosen ? `Choose a subcategory of ${categories.find((c) => c.id === form.category_id)?.name}.` : '';

  // findDuplicate reads only these four fields of a new record.
  const { merchant, amount, occurred_at: occurredAt, account_id: accountId } = form;
  const duplicate = useMemo(
    () => (tx || duplicateDismissed ? null : findDuplicate({ merchant, amount, occurred_at: occurredAt, account_id: accountId }, allTransactions)),
    [merchant, amount, occurredAt, accountId, allTransactions, duplicateDismissed, tx],
  );

  const refundLink = tx ? refundLinkOf(tx.id, links) : null;
  const linkedPurchase = refundLink ? (allTransactions.find((t) => t.id === refundLink.from_transaction_id) ?? null) : null;
  // A linked refund is filed where its purchase's money was spent, and the
  // database keeps it there (refund_integrity): its categories follow the
  // purchase's, so the editor neither offers nor sends them.
  const followsPurchase = !!refundLink && form.type === 'refund';
  const purchaseRefunds = tx && form.type === 'expense' ? refundsOf(tx.id, links, allTransactions) : [];
  // The history shows this record's edits with those of the records linked to
  // it: a refund's purchase, a purchase's refunds (SHR-323).
  const historyRecords = useMemo(() => relatedRecords(tx, links, allTransactions), [tx, links, allTransactions]);
  // Purchases a refund might return, offered only until it is linked. Each
  // input is a plain value, so the memo holds: the link itself is an object
  // the editor passes on, which the React compiler cannot see is left alone.
  const linked = !!refundLink;
  const txId = tx?.id;
  const refundSuggestions = useMemo(
    () =>
      form.type === 'refund' && !linked
        ? refundCandidates({ id: txId, account_id: accountId, merchant, amount: amountAed ?? 0, occurred_at: occurredAt }, allTransactions, links).slice(0, 3)
        : [],
    [form.type, accountId, merchant, occurredAt, amountAed, linked, txId, allTransactions, links],
  );
  // Remembering a merchant is offered when an ordinary expense already in the
  // ledger is moved to another category. Splits, transfers and refunds keep
  // their own rules for where their money is filed, so it isn't offered for
  // them, nor for a record with no merchant to match.
  const merchantName = form.merchant.trim();
  const oldKind = tx ? (tx.kind ?? (Number(tx.amount) >= 0 ? 'income' : 'expense')) : null;
  const canRemember = !!tx && oldKind === 'expense' && form.type === 'expense' && !tx.is_split && !split && merchantName !== '' && !!form.category_id && form.category_id !== (tx.category_id ?? '');
  const remembering = canRemember && remember;
  const ruleProposal = { pattern: rulePattern ?? merchantName, match_type: ruleMatchType, category_id: form.category_id };
  const ruleCheck = remembering || savedWithoutRule ? rememberMerchantCheck(merchantName, ruleProposal, freshRules ?? categoryRules) : null;
  const categoryNameOf = (id) => categories.find((c) => c.id === id)?.name ?? 'a category that no longer exists';

  async function handleSave(e) {
    e.preventDefault();
    if (savedWithoutRule) {
      await addRule();
      return;
    }
    // A transfer is edited as a pair, in TransferEditor. This one's other side
    // or link didn't load, so it can't be edited here without breaking the
    // pair (the database would refuse it anyway).
    if (form.type === 'transfer') {
      setError("This is one side of a transfer whose other side couldn't be loaded. Refresh the page and open it again.");
      return;
    }
    // A linked refund's lines are the database's to share out again when its
    // amount changes (refund_allocation_exact), so the lines it loaded with
    // are not held to the new amount here.
    const linesError = split && !followsPurchase ? splitProblem(split, amountAed) : '';
    // A rule that wouldn't match this merchant is caught before anything is
    // written, so the record is never saved on the way to a rule that can't be.
    const ruleError = ruleCheck?.status === 'invalid' ? ruleCheck.reason : '';
    if (amountError || accountError || categoryError || linesError || ruleError) {
      setError(amountError || accountError || categoryError || linesError || ruleError);
      return;
    }
    setSaving(true);
    setError('');

    const splitting = !!split && !followsPurchase;
    const savedNative = { currency: form.entry_currency, amount: foreign ? signedNative(typed, form.type) : null };
    const result = await saveTransaction(
      {
        tx,
        householdId,
        payload: transactionPayload(form, figures, { householdId, splitting, editing: !!tx, followsPurchase }),
        lines: splitting ? split.map((l) => ({ category_id: l.category_id, amount: Number(l.amount) })) : null,
        amountAed,
        unlinkId: refundLink && form.type !== 'refund' ? refundLink.id : null,
        unsplit: !!tx?.is_split && !split && !followsPurchase,
        linkTo: form.type === 'refund' && !refundLink ? refundFor : null,
        keptAlongside,
        edits: tx
          ? buildEdits(tx, form, signedAmount(amountAed, form.type), { accounts, categories, members, splitChanging: !!split || !!tx.is_split || followsPurchase, savedNative })
          : [],
      },
      saveMemory.current,
    );
    if (result.error) {
      setSaving(false);
      setError(result.error);
      return;
    }
    if (result.historyError) {
      // The transaction itself is already saved — only the audit trail
      // failed to record — so surface it without implying the save
      // didn't happen, and let the user close manually rather than
      // silently losing the entry.
      setSaving(false);
      if (remembering && ruleCheck.status === 'new') {
        setSavedWithoutRule(`It wasn’t tried, because the edit history couldn’t be recorded: ${result.historyError}.`);
        return;
      }
      setError(`Transaction saved, but its edit history couldn't be recorded: ${result.historyError}`);
      return;
    }

    // The rule comes only after the record is saved. A rule already covering
    // this merchant means none is added (lib/rules.js).
    if (remembering && ruleCheck.status === 'conflict') {
      setSaving(false);
      await onSaved({ notice: { text: `Saved without a merchant rule: ${ruleLabel(ruleCheck.rule)} still files it under ${categoryNameOf(ruleCheck.rule.category_id)}.`, ruleId: ruleCheck.rule.id } });
      return;
    }
    if (remembering && ruleCheck.status === 'duplicate') {
      setSaving(false);
      await onSaved({ notice: { text: `Saved. ${ruleLabel(ruleCheck.rule)} already files “${merchantName}” under ${categoryNameOf(ruleCheck.rule.category_id)}.`, ruleId: ruleCheck.rule.id } });
      return;
    }
    if (remembering) {
      await addRule();
      return;
    }

    setSaving(false);
    await onSaved();
  }

  // Adds the merchant rule for a record that is already saved: on the first
  // save, and on each retry, which writes nothing else. The household's rules
  // are read again first, so a rule added meanwhile (by the other person, or
  // by an attempt whose answer was lost) isn't added twice.
  async function addRule() {
    setSaving(true);
    setError('');
    const fail = (reason) => {
      setSaving(false);
      setSavedWithoutRule(reason);
    };
    const { data: rules, error: readError } = await supabase.from('category_rules').select('*').eq('household_id', householdId).order('created_at').order('id');
    if (readError) return fail(`The household’s rules couldn’t be read: ${readError.message}.`);
    setFreshRules(rules ?? []);
    const check = rememberMerchantCheck(merchantName, ruleProposal, rules ?? []);
    if (check.status === 'duplicate') {
      setSaving(false);
      await onSaved({ notice: { text: `Saved. ${ruleLabel(check.rule)} already files “${merchantName}” under ${categoryNameOf(check.rule.category_id)}.`, ruleId: check.rule.id } });
      return;
    }
    if (check.status === 'conflict') return fail(`${ruleLabel(check.rule)} already files this merchant under ${categoryNameOf(check.rule.category_id)}.`);
    if (check.status !== 'new') return fail(check.reason);
    const { data: created, error: insertError } = await supabase
      .from('category_rules')
      .insert({ household_id: householdId, pattern: check.rule.pattern, match_type: check.rule.match_type, category_id: check.rule.category_id })
      .select('id')
      .single();
    if (insertError) return fail(`The rule couldn’t be added: ${insertError.message}.`);
    setSaving(false);
    const verb = check.rule.match_type === 'starts_with' ? 'starts with' : 'contains';
    await onSaved({ notice: { text: `Saved, and remembered: future entries whose merchant ${verb} “${check.rule.pattern}” go to ${categoryNameOf(check.rule.category_id)}.`, ruleId: created?.id ?? null } });
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
      <div className="te-drawer" ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tx ? 'Edit transaction' : 'Add transaction'}>
        <div className="te-head">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span className="ov-kicker">{tx ? 'Edit transaction' : 'New entry'}</span>
              {dirty && !savedWithoutRule && <span className="te-dirty-chip">Unsaved</span>}
            </div>
            <div className="te-title">{tx ? tx.merchant || 'Transaction' : 'Add a transaction'}</div>
          </div>
          <button type="button" className="te-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>

        {savedWithoutRule ? (
          <form className="te-form" onSubmit={handleSave}>
            <div className="te-duplicate" role="alert">
              <div className="te-duplicate-title">Transaction saved; merchant rule wasn’t saved.</div>
              <div className="te-duplicate-body">
                {savedWithoutRule} The correction to {categoryNameOf(form.category_id)} is kept. Try the rule again, or close and add it later in Settings → Categories & rules.
              </div>
            </div>
            <RememberMerchant
              merchant={merchantName}
              categoryName={categoryNameOf(form.category_id)}
              categories={categories}
              pattern={ruleProposal.pattern}
              matchType={ruleMatchType}
              check={ruleCheck}
              disabled={saving}
              onPattern={setRulePattern}
              onMatchType={setRuleMatchType}
            />
            <div className="te-sticky-actions">
              <div className="te-actions" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
                <div className="te-actions-right">
                  <button type="button" className="om-btn" onClick={() => onSaved({ notice: SAVED_WITHOUT_RULE })} disabled={saving}>
                    Close
                  </button>
                  <button type="submit" className="om-btn ov-btn-primary" disabled={saving || ruleCheck?.status !== 'new'}>
                    {saving ? 'Saving…' : 'Try the rule again'}
                  </button>
                </div>
              </div>
            </div>
          </form>
        ) : (
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
          {ENTRY_TYPES[form.type] && (
            <p className="ov-muted te-type-note">
              {ENTRY_TYPES[form.type].meaning} {ENTRY_TYPES[form.type].result}
              {!tx && onSwitchToTransfer && form.type !== 'transfer' && ' Moved money between your own accounts? Choose Transfer.'}
            </p>
          )}

          <TransferPairs pairs={pairs} accounts={accounts} saving={saving} onMake={makeTransfer} />

          <TransactionAmount form={form} set={set} household={household} figures={figures} />

          <DuplicateNotice
            duplicate={duplicate}
            onBothReal={() => {
              setKeptAlongside(duplicate);
              setDuplicateDismissed(true);
            }}
            onOpenOther={onOpenOther}
          />

          <div className="te-fieldgrid">
            <div className="te-fieldcell te-span2">
              <span className="te-fieldlabel">Merchant</span>
              <input aria-label="Merchant" className="te-fieldvalue" type="text" value={form.merchant} onChange={(e) => set('merchant', e.target.value)} placeholder="Type a merchant name" />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Date</span>
              <input aria-label="Date" className="te-fieldvalue" type="date" value={form.occurred_at} onChange={(e) => set('occurred_at', e.target.value)} />
            </div>
            <div className="te-fieldcell">
              <span className="te-fieldlabel">Account</span>
              <select aria-label="Account" className="te-fieldvalue" value={form.account_id} onChange={(e) => set('account_id', e.target.value)} aria-invalid={!!accountError}>
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

          <RefundLinks
            isRefund={form.type === 'refund'}
            refundLink={refundLink}
            linkedPurchase={linkedPurchase}
            refundSuggestions={refundSuggestions}
            refundFor={refundFor}
            onChoose={(id) => {
              setRefundFor(refundFor === id ? null : id);
              setDirty(true);
            }}
            confirmingUnlink={confirmingUnlink}
            onUnlink={unlinkRefund}
            purchaseRefunds={purchaseRefunds}
            accounts={accounts}
            saving={saving}
          />

          <TransactionCategory tx={tx} form={form} set={set} categories={categories} followsPurchase={followsPurchase} split={split} setLines={setLines} amountAed={amountAed}>
            {canRemember && (
              <>
                <label className="te-remember">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  <span>
                    <span className="te-togglelabel">Remember this merchant</span>
                    <span className="te-togglenote">Add a household rule so future entries from “{merchantName}” go to {categoryNameOf(form.category_id)}</span>
                  </span>
                </label>
                {remember && (
                  <RememberMerchant
                    merchant={merchantName}
                    categoryName={categoryNameOf(form.category_id)}
                    categories={categories}
                    pattern={ruleProposal.pattern}
                    matchType={ruleMatchType}
                    check={ruleCheck}
                    onPattern={setRulePattern}
                    onMatchType={setRuleMatchType}
                  />
                )}
              </>
            )}
          </TransactionCategory>

          <div>
            <span className="te-fieldlabel">Whose spend</span>
            <OwnerPicker value={form.owner} members={members} onChange={(id) => set('owner', id)} />
          </div>

          <div className="te-fieldcell">
            <span className="te-fieldlabel">Note</span>
            <textarea aria-label="Note" className="te-fieldvalue" rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} />
          </div>

          <button type="button" className="te-togglerow" onClick={() => set('needs_review', !form.needs_review)}>
            <div>
              <div className="te-togglelabel">Needs review</div>
              <div className="te-togglenote">Flags it for the other person to check</div>
            </div>
            <span className={`te-togglestate ${form.needs_review ? 'te-togglestate-warn' : ''}`}>{form.needs_review ? 'Flagged' : 'Clear'}</span>
          </button>

          {tx && <EditHistory records={historyRecords} members={members} />}

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
                    <DiscardPrompt onDiscard={onClose} onKeepEditing={keepEditing} />
                  </>
                ) : (
                  <>
                    <button type="button" className="om-btn" onClick={requestClose}>
                      Cancel
                    </button>
                    <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
                      {saving ? 'Saving…' : !tx ? 'Add transaction' : remembering && ruleCheck?.status === 'new' ? 'Save and add rule' : 'Save changes'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
