import { useEffect, useId, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { fileableCategories } from '../../lib/fileableCategories';
import { formatMoney } from '../../lib/money';
import { firstMatchingRule, rememberMerchantCheck, ruleLabel } from '../../lib/rules';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import { INTAKE_KINDS, approvalArgs, validateApproval } from '../../lib/intake';
import { confirmedPairRow, findDuplicate } from '../../lib/duplicates';
import { householdToday, parseDay } from '../../lib/day';
import { estimateAed } from '../../lib/fxHistory';
import { Card, Chip } from '../../design-system/kit';
import OwnerPicker from '../OwnerPicker';
import RememberMerchant from './RememberMerchant';
import { addMerchantRule } from './merchantRule';
import { ago, readingChip } from './inboxText';

// The selected Inbox message, as the prototype lays it out (the revamp,
// phase 4c; review S-inbox-3 to 6): the message itself, and what was read
// from it as fields edited in place, then Approve or Reject. The separate
// "Edit first" step is gone: every field is in view, so nothing is approved
// that was not shown. The approval itself is unchanged: one call to
// approve_intake, then "both are real" and the merchant rule after it.
//
// household_id is taken from the intake row inside the RPC rather than passed
// in, so an approval cannot be redirected to another household.
export default function InboxDetail({ item, sender, accounts, members, categories, categoryRules, allTransactions, rates = { history: [], current: null }, duplicatePending, recorded = null, saving, setSaving, error, setError, onDone, actionsRef }) {
  // A detected non-AED currency means the parsed amount is in that currency.
  // It is kept as that, and the AED that counts is the AED debited, or until
  // that is known an estimate at the payment date's rate, marked as one
  // (docs/decisions.md, "A payment in rupees keeps both amounts"). A card's
  // exchange markup isn't knowable here, so an estimate is never passed off
  // as the debited figure.
  const foreignCurrency = item.parsed_currency && item.parsed_currency !== 'AED' ? item.parsed_currency : null;
  const [typedAmount, setAmount] = useState(item.parsed_amount !== null ? String(item.parsed_amount) : '');
  const [aedDebited, setAedDebited] = useState('');
  const [merchant, setMerchant] = useState(item.parsed_merchant ?? '');
  const [date, setDate] = useState(item.parsed_date ?? householdToday());
  // Intake can only be approved onto an open account (QA-01).
  const selectable = selectableAccounts(accounts);
  const suggestedAccountId = item.parsed_account_id && selectable.some((a) => a.id === item.parsed_account_id) ? item.parsed_account_id : null;
  // An account the message did not name is chosen, never guessed: with every
  // field in view, a first account filled in would be approved unnoticed
  // (the revamp, phase 4c). A household with one open account has nothing to
  // choose between.
  const [accountId, setAccountId] = useState(suggestedAccountId ?? (selectable.length === 1 ? selectable[0].id : ''));
  const suggestedRule = item.parsed_category_id ? null : firstMatchingRule(item.parsed_merchant, categoryRules);
  const [categoryId, setCategoryId] = useState(item.parsed_category_id ?? suggestedRule?.category_id ?? '');
  // Every item used to be forced to a shared AED expense. The reviewer says
  // which it is (QA-11) -- pre-filled from the parser's own classification
  // (SHR-282) when it made one, so a salary credit opens already set to
  // Income rather than always starting at Expense.
  const [kind, setKind] = useState(item.parsed_kind ?? 'expense');
  // Read from the message, not typed: letting it be edited let "USD" sit
  // against an AED figure (SHR-252). An AED entry has one amount; any other
  // has both.
  const currency = foreignCurrency ?? 'AED';
  const estimate = foreignCurrency && aedDebited.trim() === '' ? estimateAed(Number(typedAmount) || 0, foreignCurrency, date, rates.history, rates.current) : null;
  const amount = !foreignCurrency ? typedAmount : aedDebited.trim() !== '' ? aedDebited : estimate ? String(Math.abs(estimate.aed)) : '';
  const [owner, setOwner] = useState('shared');
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);
  // The record "Both are real" was said about, remembered as a confirmed pair
  // once this entry is approved, so the monthly review doesn't ask again.
  const [keptAlongside, setKeptAlongside] = useState(null);
  // A date the message did not give is the day it was sent to the bot. It
  // counts as the day it was paid once someone picks a date or ticks that the
  // one shown is right. This starts false even for a dated entry: the
  // database checks its own copy, and a copy this screen holds could be older
  // than a correction that has since made the date a guess.
  const [dateConfirmed, setDateConfirmed] = useState(false);
  // "Remember this merchant": a household rule added once the entry is
  // approved, so the next one from this merchant arrives already filed. Off
  // until ticked, and offered only for an expense with a category chosen
  // whose merchant no rule covers yet (docs/decisions.md, "A correction can
  // remember its merchant"). The pattern follows the merchant until edited.
  const [remember, setRemember] = useState(false);
  const [rulePattern, setRulePattern] = useState(null);
  const [ruleMatchType, setRuleMatchType] = useState('contains');
  // Approved, with a step after it that failed. The entry is in the ledger
  // by then, so Approve and Reject would act on nothing: only Done is left.
  const [approvedAlready, setApprovedAlready] = useState(false);
  const merchantName = merchant.trim();
  const canRemember = kind === 'expense' && merchantName !== '' && !!categoryId && !firstMatchingRule(merchantName, categoryRules);
  const remembering = canRemember && remember;
  const ruleProposal = { pattern: rulePattern ?? merchantName, match_type: ruleMatchType, category_id: categoryId };
  const ruleCheck = remembering ? rememberMerchantCheck(merchantName, ruleProposal, categoryRules) : null;
  const categoryNameOf = (id) => categories.find((c) => c.id === id)?.name ?? 'a category that no longer exists';

  const duplicateTransaction = duplicateDismissed
    ? null
    : findDuplicate({ merchant, amount, account_id: accountId, occurred_at: date }, allTransactions, null);

  const form = {
    accountId,
    amount,
    date,
    dateGuessed: !!item.date_guessed,
    dateConfirmed,
    kind,
    categoryId,
    currency,
    nativeAmount: foreignCurrency ? typedAmount : null,
    aedEstimated: !!foreignCurrency && aedDebited.trim() === '',
    merchant,
    isShared: owner === 'shared',
    ownerMemberId: owner === 'shared' ? null : owner,
  };

  // One call, one database transaction. The insert and the status update used
  // to be separate round trips: a failure or a retry between them wrote a
  // second transaction, and two reviewers could race. The RPC approves a
  // pending row exactly once and returns the existing result on retry (QA-11).
  async function approve(e) {
    e?.preventDefault();
    // Enter in a field of an entry already approved approves nothing again.
    if (approvedAlready) return;
    if (foreignCurrency && !amount) {
      setError(`No ${foreignCurrency} rate for that date: enter the AED debited.`);
      return;
    }
    // A rule that wouldn't match this merchant is caught before anything is
    // written, so the entry is never approved on the way to a rule that
    // can't be.
    const invalid = validateApproval(form) || (ruleCheck?.status === 'invalid' ? ruleCheck.reason : '');
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError('');
    const { data: approved, error: rpcError } = await supabase.rpc('approve_intake', approvalArgs(item, form));
    if (rpcError) {
      setSaving(false);
      setError(rpcError.message);
      return;
    }
    // Only if the record "Both are real" was said about is still the one this
    // entry matches: the fields may have changed since.
    const stillMatches = keptAlongside && findDuplicate({ merchant, amount, account_id: accountId, occurred_at: date }, allTransactions, null)?.id === keptAlongside.id;
    if (stillMatches && approved?.transaction_id) {
      const { error: pairError } = await supabase.from('transaction_links').insert(confirmedPairRow(item.household_id, { id: approved.transaction_id }, keptAlongside));
      if (pairError) {
        setSaving(false);
        setApprovedAlready(true);
        setError(`Approved, but "both are real" wasn't remembered: ${pairError.message}. Month end will ask about the pair again.`);
        return;
      }
    }
    // The rule comes only after the entry is approved. One already filing
    // this merchant there means none is needed; anything else that stops it
    // is said, with the entry kept approved.
    if (remembering) {
      const added = await addMerchantRule({ householdId: item.household_id, merchant: merchantName, proposal: ruleProposal });
      if (added.status === 'conflict' || added.status === 'failed') {
        setSaving(false);
        setApprovedAlready(true);
        setError(
          `Approved, but the merchant rule wasn’t added: ${added.status === 'conflict' ? `${ruleLabel(added.rule)} already files this merchant under ${categoryNameOf(added.rule.category_id)}` : added.reason}. Add or change it in Settings → Categories & rules.`,
        );
        return;
      }
    }
    setSaving(false);
    await onDone();
  }

  async function reject() {
    setSaving(true);
    // Conditional on still being pending, so rejecting cannot undo someone
    // else's approval.
    const { error: updError } = await supabase
      .from('intake')
      .update({ status: 'rejected' })
      .eq('id', item.id)
      .eq('status', 'pending');
    setSaving(false);
    if (updError) {
      setError(updError.message);
      return;
    }
    await onDone();
  }


  // The keys A and R act on this message (Inbox.jsx).
  useEffect(() => {
    if (!actionsRef) return undefined;
    actionsRef.current = { approve: () => (saving ? null : approve()), reject: () => (saving || approvedAlready ? null : reject()) };
    return () => {
      actionsRef.current = null;
    };
  });

  const reading = readingChip(item, { filled: !!merchant.trim() && typedAmount !== '' && !!accountId && !!categoryId, dateSettled: dateConfirmed });
  const ids = useId();
  const field = (label, control, note = null, warn = false) => (
    <div className="ib-row">
      <dt id={`${ids}-${label}`}>{label}</dt>
      <dd>
        {control}
        {note && <div className={warn ? 'ib-note ib-warn' : 'ib-note'}>{note}</div>}
      </dd>
    </div>
  );

  return (
    <Card className="ib-detail" flush>
      <div className="ib-detail-cols">
        <section className="ib-message" aria-label="Message">
          <div className="ib-col-title">{item.photo_path ? 'Receipt photo' : 'Message'}</div>
          <div className="ib-quote">
            {item.photo_path && <ReceiptPhoto photoPath={item.photo_path} />}
            {item.raw_text && <div className="ib-quote-text">{item.raw_text}</div>}
            {!item.photo_path && !item.raw_text && <div className="ib-note">No content captured.</div>}
          </div>
          <div className="ib-note">
            {sender ? `From ${sender}` : 'Unassigned'} · {ago(item.created_at)}
            {item.source === 'telegram' ? ' · Telegram' : item.source === 'manual' ? ' · added by hand' : ''}
          </div>
        </section>

        <form className="ib-read" aria-label="What was read" onSubmit={approve}>
          <div className="ib-read-head">
            <div className="ib-col-title">What was read</div>
            <Chip tone={reading.tone}>{reading.label}</Chip>
          </div>
          <dl className="ib-fields">
            {field('Merchant', <input className="ds-select ib-input" aria-label="Merchant" type="text" value={merchant} onChange={(e) => setMerchant(e.target.value)} />, item.parsed_merchant ? null : 'Nothing readable', !item.parsed_merchant)}
            {field(
              'Amount',
              <span className="ib-amount">
                <input className="ds-select ib-input" aria-label="Amount" type="number" min="0" step="0.01" value={typedAmount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
                <span className="ib-unit">{currency}</span>
              </span>,
              item.parsed_amount === null ? 'Not read.' : null,
              true,
            )}
            {foreignCurrency &&
              field(
                'AED debited',
                <input
                  className="ds-select ib-input"
                  type="number"
                  min="0"
                  step="0.01"
                  aria-label="AED debited"
                  value={aedDebited}
                  onChange={(e) => setAedDebited(e.target.value)}
                  placeholder={estimate ? formatMoney(Math.abs(estimate.aed), { decimals: 2 }) : 'From the statement'}
                />,
                aedDebited.trim() !== ''
                  ? `Recorded as ${foreignCurrency} ${typedAmount || 0}, with this AED as what every total counts.`
                  : estimate
                    ? `Leave it blank to record an estimate of AED ${formatMoney(Math.abs(estimate.aed), { decimals: 2 })}, marked as one until the AED debited is entered.`
                    : `No ${foreignCurrency} rate for that date: enter the AED debited.`,
                !estimate && aedDebited.trim() === '',
              )}
            {field(
              'Date',
              <>
                <input
                  className="ds-select ib-input"
                  type="date"
                  aria-label="Date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                    setDateConfirmed(true);
                  }}
                />
                {/* No role="alert" on the warning: the form's own error is
                    the one alert, and the date says where to look. */}
                {item.date_guessed && (
                  <label className="ib-check">
                    <input type="checkbox" checked={dateConfirmed} onChange={(e) => setDateConfirmed(e.target.checked)} />
                    <span>Paid on this day</span>
                  </label>
                )}
              </>,
              item.date_guessed && !dateConfirmed ? 'Not in the message: the day it was sent.' : !item.parsed_date && !dateConfirmed ? 'Not read: today is shown.' : null,
              true,
            )}
            {field(
              'Category',
              <select className="ds-select ib-input" aria-label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Uncategorised</option>
                {/* Subcategories, never the group they are in (lib/fileableCategories.js). */}
                {fileableCategories(categories, null, categoryId || null).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>,
              suggestedRule && categoryId === suggestedRule.category_id ? `Suggested by a rule matching "${suggestedRule.pattern}".` : !categoryId ? 'No rule matched' : null,
              !categoryId,
            )}
            {field(
              'Account',
              <select className="ds-select ib-input" aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {!accountId && <option value="">Choose…</option>}
                {selectable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountOptionLabel(a, { accounts: selectable, members })}
                  </option>
                ))}
              </select>,
              suggestedAccountId && accountId === suggestedAccountId ? 'Suggested from a card-ending match.' : !accountId ? 'Not matched: choose the account.' : null,
              !accountId,
            )}
            {field(
              'Type',
              <div className="ds-seg" role="group" aria-labelledby={`${ids}-Type`}>
                {INTAKE_KINDS.map((k) => (
                  <button key={k.id} type="button" title={k.hint} aria-pressed={kind === k.id} data-on={kind === k.id || undefined} onClick={() => setKind(k.id)}>
                    {k.label}
                  </button>
                ))}
              </div>,
            )}
            {field('Whose', <OwnerPicker value={owner} members={members} onChange={setOwner} labelledBy={`${ids}-Whose`} />)}
          </dl>

          {canRemember && (
            <div className="ib-extra">
              <label className="te-remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>
                  <span className="te-togglelabel">Remember this merchant</span>
                  <span className="te-togglenote">Add a household rule so future entries from “{merchantName}” go to {categoryNameOf(categoryId)}</span>
                </span>
              </label>
              {remember && (
                <RememberMerchant
                  merchant={merchantName}
                  categoryName={categoryNameOf(categoryId)}
                  categories={categories}
                  pattern={ruleProposal.pattern}
                  matchType={ruleMatchType}
                  check={ruleCheck}
                  disabled={saving}
                  onPattern={setRulePattern}
                  onMatchType={setRuleMatchType}
                />
              )}
            </div>
          )}

          {recorded && (
            <div className="te-duplicate" role="status">
              <div className="te-duplicate-title">
                {`Looks already recorded: ${recorded.merchant ?? 'a record'}, AED ${formatMoney(Math.abs(Number(recorded.amount)), { decimals: 2 })} on ${parseDay(recorded.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
              </div>
              <div className="te-duplicate-body">The same amount on the same card, recorded in the two weeks before this message. Reject it, unless it was a second charge.</div>
            </div>
          )}
          {duplicatePending && (
            <div className="te-duplicate" role="status">
              <div className="te-duplicate-title">You may have sent this one twice</div>
              <div className="te-duplicate-body">
                Another pending entry for {duplicatePending.parsed_merchant}, {formatMoney(duplicatePending.parsed_amount)}, dated within a few days of this one, is also
                waiting for review. If both are real, approve both as usual; otherwise reject one.
              </div>
            </div>
          )}
          {duplicateTransaction && (
            <div className="te-duplicate" role="status">
              <div className="te-duplicate-title">A record like this already exists</div>
              <div className="te-duplicate-body">
                {duplicateTransaction.merchant}, {formatMoney(duplicateTransaction.amount)},{' '}
                {new Date(duplicateTransaction.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — already posted, within a few days of this
                one. Approving is allowed if the household really spent twice.
              </div>
              <div className="ib-dup-actions">
                <button
                  type="button"
                  className="ds-btn ds-btn-sm"
                  onClick={() => {
                    setKeptAlongside(duplicateTransaction);
                    setDuplicateDismissed(true);
                  }}
                >
                  Both are real
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="ib-error" role="alert">
              {error}
            </p>
          )}

          <div className="ib-actions">
            {approvedAlready ? (
              <button type="button" className="ds-btn ds-btn-primary" onClick={onDone}>
                Done
              </button>
            ) : (
              <>
                <button type="submit" className="ds-btn ds-btn-primary" disabled={saving}>
                  {saving ? 'Saving…' : remembering && ruleCheck?.status === 'new' ? 'Approve and add rule' : 'Approve'}
                </button>
                <button type="button" className="ds-btn" onClick={reject} disabled={saving}>
                  Reject
                </button>
              </>
            )}
          </div>
          <div className="ib-keys" aria-hidden="true">
            <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>↑</kbd> <kbd>↓</kbd> move
          </div>
        </form>
      </div>
    </Card>
  );
}

function ReceiptPhoto({ photoPath }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    supabase.storage
      .from('telegram-receipts')
      .createSignedUrl(photoPath, 300)
      .then(({ data }) => {
        if (!cancelled) setUrl(data?.signedUrl ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [photoPath]);

  if (!url) return <div className="ib-note">Loading photo…</div>;
  return <img src={url} alt="Receipt" className="ib-photo" />;
}
