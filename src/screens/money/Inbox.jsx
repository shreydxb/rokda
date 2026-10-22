import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { firstMatchingRule } from '../../lib/rules';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import { INTAKE_KINDS, INTAKE_SOURCE_LABELS, approvalArgs, validateApproval } from '../../lib/intake';
import { confirmedPairRow, findDuplicate } from '../../lib/duplicates';
import { householdToday, parseDay } from '../../lib/day';
import { estimateAed } from '../../lib/fxHistory';
import './TransactionEditor.css';

function senderName(item, members) {
  if (!item.member_id) return null;
  return members.find((m) => m.id === item.member_id)?.display_name ?? null;
}

// Two pending intake rows for the same merchant/amount, within a few days of
// each other -- e.g. sent the same expense to the bot twice by accident.
// Intake has no account yet at this stage, so this only compares
// merchant/amount/date, unlike the post-approval duplicate check.
const PENDING_DUPLICATE_WINDOW_DAYS = 3;
function findDuplicatePending(item, otherPending) {
  const merchant = (item.parsed_merchant ?? '').trim().toLowerCase();
  const amount = item.parsed_amount !== null ? Number(item.parsed_amount) : null;
  if (!merchant || !amount || !item.parsed_date) return null;
  const occurred = new Date(item.parsed_date).getTime();
  return (
    otherPending.find((o) => {
      if (o.id === item.id) return false;
      if ((o.parsed_merchant ?? '').trim().toLowerCase() !== merchant) return false;
      if (o.parsed_amount === null || Math.abs(Number(o.parsed_amount) - amount) > 0.01) return false;
      if (!o.parsed_date) return false;
      const diffDays = Math.abs(new Date(o.parsed_date).getTime() - occurred) / 86400000;
      return diffDays <= PENDING_DUPLICATE_WINDOW_DAYS;
    }) ?? null
  );
}

// Same bar the Telegram fast-confirm path uses server-side (see
// isReadyForFastConfirm in the telegram-webhook function): every field
// approve_intake needs is already resolved, with no guesswork, and the
// parser was confident about it. Only a row meeting this bar is safe to
// wave through in bulk with nobody looking at it first.
function isConfident(item) {
  return (
    !!item.parsed_merchant &&
    item.parsed_amount !== null &&
    Number(item.parsed_amount) > 0 &&
    !!item.parsed_date &&
    !item.date_guessed &&
    !!item.parsed_category_id &&
    !!item.parsed_account_id &&
    (item.parsed_currency == null || item.parsed_currency === 'AED') &&
    Number(item.confidence ?? 0) >= 0.85
  );
}

function sourceIcon(item) {
  if (item.photo_path) return '📷';
  return '💬';
}

const READ_CLEANLY_THRESHOLD = 0.85;

export default function Inbox({ household = null, members = [], accounts, categories, data, loading }) {
  const { intake, categoryRules, transactions, reload } = data;
  const [selectedId, setSelectedId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  // Sorted oldest last, so the newest arrival leads and the queue reads the
  // same direction top-to-bottom as everywhere else in the app.
  const pending = [...intake.filter((i) => i.status === 'pending')].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  const selected = pending.find((i) => i.id === selectedId) ?? pending[0] ?? null;
  const confident = pending.filter(isConfident);
  // Dated the day they were sent to the bot; each waits for its real date.
  const undated = pending.filter((i) => i.date_guessed);
  const oldest = pending[pending.length - 1];

  async function approveConfident() {
    setBulkSaving(true);
    setError('');
    for (const item of confident) {
      // No dateConfirmed: nobody looked at these. isConfident leaves out a
      // guessed date, and approve_intake would refuse one anyway.
      const form = {
        accountId: item.parsed_account_id,
        amount: item.parsed_amount,
        date: item.parsed_date,
        // Trusts the parser's own classification (SHR-282) -- a confidently-
        // parsed salary credit bulk-approved here must not silently become a
        // negative expense just because this was never asked interactively.
        kind: item.parsed_kind ?? 'expense',
        categoryId: item.parsed_category_id,
        currency: 'AED',
        merchant: item.parsed_merchant,
        isShared: true,
        ownerMemberId: null,
      };
      // One failure must never block the rest -- each item approves
      // independently, same as the Telegram fast-confirm path.
      const { error: rpcError } = await supabase.rpc('approve_intake', approvalArgs(item, form));
      if (rpcError) setError(`${item.parsed_merchant}: ${rpcError.message}`);
    }
    setBulkSaving(false);
    setSelectedId(null);
    await reload();
  }

  return (
    <div>
      <div className="ib-summary">
        <div className="ov-muted">
          {pending.length > 0
            ? `${pending.length} waiting · ${confident.length} read cleanly${undated.length ? ` · ${undated.length} with no date` : ''}${oldest ? ` · oldest ${ago(oldest.created_at)}` : ''}`
            : 'All filed'}
        </div>
        {/* Offered only when something read cleanly; otherwise the count
            beside it already says none can be approved in bulk. */}
        {confident.length > 0 && (
          <button type="button" className="om-btn mn-add" disabled={bulkSaving} onClick={approveConfident}>
            {bulkSaving ? 'Approving…' : `Approve ${confident.length} confident`}
          </button>
        )}
      </div>

      {pending.length === 0 ? (
        <div className="ov-empty" style={{ marginTop: 0 }}>
          <div className="ov-empty-kicker">Inbox zero</div>
          <div className="ov-empty-body">Nothing waiting on review. Approved items appear in Activity straight away.</div>
        </div>
      ) : (
        <div className="ov-split ib-split">
          <div>
            <div className="ib-queue-head">Waiting · {pending.length}</div>
            <div className="ib-queue">
              {pending.map((i) => {
                const low = i.confidence !== null && Number(i.confidence) < 0.5;
                return (
                  <button
                    key={i.id}
                    type="button"
                    className="ib-queue-row"
                    data-active={selected?.id === i.id}
                    onClick={() => setSelectedId(i.id)}
                  >
                    <span className="ib-queue-icon">{sourceIcon(i)}</span>
                    <div className="ib-queue-body">
                      <div className="ib-queue-top">
                        <span>{i.parsed_merchant || 'Unrecognised merchant'}</span>
                        <span className={`fig ${low ? 'ov-warn' : ''}`}>{i.parsed_amount !== null ? formatMoney(i.parsed_amount) : '—'}</span>
                      </div>
                      <div className="ib-queue-bottom">
                        <span className={`ib-dot ib-dot-${dotTone(i.confidence)}`} />
                        <span className="ov-muted">
                          {senderName(i, members) ?? INTAKE_SOURCE_LABELS[i.source] ?? 'Unknown sender'} · {ago(i.created_at)}
                        </span>
                        {i.date_guessed && (
                          <span className="ov-chip-warn" style={{ marginLeft: 'auto' }} title="Not in the message: dated the day it was sent">
                            No date
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="ov-muted ib-queue-note">
              Sorted newest first. Anything under 50% confidence is flagged before it reaches your books.
            </div>
          </div>

          {selected && (
            <IntakeReview
              key={selected.id}
              item={selected}
              sender={senderName(selected, members)}
              accounts={accounts}
              members={members}
              categories={categories}
              categoryRules={categoryRules}
              allTransactions={transactions ?? []}
              rates={{ history: data.fxRateHistory ?? [], current: household?.inr_per_aed ?? null }}
              duplicatePending={findDuplicatePending(selected, pending)}
              saving={saving}
              setSaving={setSaving}
              error={error}
              setError={setError}
              onDone={async () => {
                setSelectedId(null);
                await reload();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function dotTone(confidence) {
  if (confidence === null) return 'warn';
  const c = Number(confidence);
  if (c >= READ_CLEANLY_THRESHOLD) return 'pos';
  if (c >= 0.5) return 'warn';
  return 'neg';
}

function ago(isoDate) {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
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

  if (!url) return <div className="ov-muted" style={{ fontSize: 11.5 }}>Loading photo…</div>;
  return <img src={url} alt="Receipt" style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 4, display: 'block' }} />;
}

// A read-only summary of what was extracted -- confidence dot per field,
// matching design/Our Money - Command Center v3.dc.html's "What we read"
// panel -- with an explicit "Edit first" switch into the real editable form
// underneath it, rather than always showing a form. Approve, when nothing
// needs fixing, uses these parsed values directly.
function FieldRow({ label, value, hint, ok, onClick }) {
  return (
    <button type="button" className="ib-field" onClick={onClick}>
      <span className="ib-field-label">{label}</span>
      <span className="ib-field-value">
        <span className={ok ? '' : 'ov-warn'}>{value}</span>
        {hint && <span className="ov-muted ib-field-hint">{hint}</span>}
      </span>
      <span className={`ib-dot ib-dot-${ok ? 'pos' : 'warn'}`} />
    </button>
  );
}

// household_id is taken from the intake row inside the RPC rather than passed
// in, so an approval cannot be redirected to another household.
function IntakeReview({ item, sender, accounts, members, categories, categoryRules, allTransactions, rates, duplicatePending, saving, setSaving, error, setError, onDone }) {
  const [mode, setMode] = useState('review'); // 'review' | 'edit'

  const catById = new Map(categories.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const suggestedAccount = item.parsed_account_id ? accountById.get(item.parsed_account_id) : null;
  const suggestedCategory = item.parsed_category_id ? catById.get(item.parsed_category_id) : null;
  const lowConfidence = (item.confidence !== null && Number(item.confidence) < READ_CLEANLY_THRESHOLD) || !!item.date_guessed;

  const fields = [
    { label: 'Merchant', value: item.parsed_merchant ?? 'Not read', hint: item.parsed_merchant ? '' : 'Nothing readable', ok: !!item.parsed_merchant },
    { label: 'Amount', value: item.parsed_amount !== null ? `AED ${formatMoney(item.parsed_amount)}` : 'Not read', hint: '', ok: item.parsed_amount !== null },
    // A bank SMS or receipt with no date on it is dated the day it was sent
    // to the bot, which is rarely the day it was paid.
    { label: 'Date', value: item.parsed_date ? parseDay(item.parsed_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not read', hint: item.date_guessed ? 'Not in the message; check it' : '', ok: !!item.parsed_date && !item.date_guessed },
    { label: 'Category', value: suggestedCategory?.name ?? 'Uncategorised', hint: item.parsed_category_id ? '' : 'No rule matched', ok: !!item.parsed_category_id },
    { label: 'Account', value: suggestedAccount?.name ?? 'Not matched', hint: item.parsed_account_id ? '' : 'Ambiguous or unmatched', ok: !!item.parsed_account_id },
    { label: 'Currency', value: item.parsed_currency ?? 'AED', hint: item.parsed_currency && item.parsed_currency !== 'AED' ? 'Edit first to record it with the AED debited' : '', ok: !item.parsed_currency || item.parsed_currency === 'AED' },
  ];

  async function approveDirect() {
    const form = {
      accountId: item.parsed_account_id,
      amount: item.parsed_amount,
      date: item.parsed_date,
      // Approving as read would record a guessed date as fact, so it fails
      // validation and opens the editor, where the date is set or confirmed.
      dateGuessed: !!item.date_guessed,
      // Trusts the parser's own classification (SHR-282), same reasoning as
      // approveConfident above.
      kind: item.parsed_kind ?? 'expense',
      categoryId: item.parsed_category_id,
      currency: 'AED',
      merchant: item.parsed_merchant,
      isShared: true,
      ownerMemberId: null,
    };
    const invalid = validateApproval(form);
    if (invalid) {
      setMode('edit');
      setError(invalid);
      return;
    }
    setSaving(true);
    setError('');
    const { error: rpcError } = await supabase.rpc('approve_intake', approvalArgs(item, form));
    setSaving(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    await onDone();
  }

  async function reject() {
    setSaving(true);
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

  if (mode === 'edit') {
    return (
      <IntakeEditForm
        item={item}
        sender={sender}
        accounts={accounts}
        members={members}
        categories={categories}
        categoryRules={categoryRules}
        allTransactions={allTransactions}
        rates={rates}
        duplicatePending={duplicatePending}
        saving={saving}
        setSaving={setSaving}
        error={error}
        setError={setError}
        onBack={() => {
          setError('');
          setMode('review');
        }}
        onDone={onDone}
      />
    );
  }

  return (
    <div className="ib-review">
      <div className="ib-review-cols">
        <div>
          <div className="ov-kicker" style={{ marginBottom: 10 }}>
            {item.photo_path ? 'Receipt photo' : 'Message'}
          </div>
          <div className="ib-source-box">
            {item.photo_path && <ReceiptPhoto photoPath={item.photo_path} />}
            {item.raw_text && <div className="ib-source-text">{item.raw_text}</div>}
            {!item.photo_path && !item.raw_text && <div className="ov-muted">No content captured.</div>}
          </div>
          <div className="ov-muted" style={{ marginTop: 10, fontSize: 11.5 }}>
            {sender ? `From ${sender}` : 'Unassigned'} · {ago(item.created_at)}
            {item.source === 'telegram' ? ' · via Telegram' : item.source === 'manual' ? ' · added by hand' : ''}
          </div>
        </div>

        <div>
          <div className="ib-review-head">
            <div className="ov-kicker">What we read</div>
            <div className={lowConfidence ? 'ov-warn' : 'ov-pos'} style={{ fontSize: 11.5 }}>
              {lowConfidence ? 'Check the flagged rows' : 'Read cleanly'}
            </div>
          </div>
          <div className="ib-fields">
            {fields.map((f) => (
              <FieldRow key={f.label} {...f} onClick={() => setMode('edit')} />
            ))}
          </div>

          {duplicatePending && (
            <div className="te-duplicate" role="status" style={{ marginTop: 16 }}>
              <div className="te-duplicate-title">You may have sent this one twice</div>
              <div className="te-duplicate-body">
                Another pending entry for {duplicatePending.parsed_merchant}, {formatMoney(duplicatePending.parsed_amount)}, dated
                within a few days of this one, is also waiting for review.
              </div>
            </div>
          )}

          {error && (
            <p className="ov-warn" role="alert" style={{ fontSize: 12.5, marginTop: 12 }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
            <button type="button" className="om-btn ov-btn-primary" disabled={saving} onClick={approveDirect}>
              {saving ? 'Saving…' : 'Approve'}
            </button>
            <button type="button" className="om-btn" onClick={() => setMode('edit')}>
              Edit first
            </button>
            <button type="button" className="om-btn" disabled={saving} onClick={reject}>
              Not a spend
            </button>
          </div>
          <div className="ov-muted" style={{ marginTop: 10, fontSize: 11.5 }}>
            Approved items appear in Activity straight away.
          </div>
        </div>
      </div>
    </div>
  );
}

function IntakeEditForm({ item, sender, accounts, members, categories, categoryRules, allTransactions, rates = { history: [], current: null }, duplicatePending, saving, setSaving, error, setError, onBack, onDone }) {
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
  const [accountId, setAccountId] = useState(suggestedAccountId ?? selectable[0]?.id ?? '');
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
    e.preventDefault();
    if (foreignCurrency && !amount) {
      setError(`No ${foreignCurrency} rate for that date: enter the AED debited.`);
      return;
    }
    const invalid = validateApproval(form);
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
        setError(`Approved, but "both are real" wasn't remembered: ${pairError.message}. The monthly review will ask about the pair again.`);
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

  return (
    <div>
      <div className="ib-review-head" style={{ marginBottom: 8 }}>
        <div className="ov-kicker">Edit before approving</div>
        <button type="button" className="ov-link te-rowaction" onClick={onBack}>
          ← Back to summary
        </button>
      </div>
      {sender && <div className="ov-muted" style={{ marginBottom: 8 }}>From {sender}</div>}
      {item.photo_path && <ReceiptPhoto photoPath={item.photo_path} />}
      {item.raw_text && (
        <div className="ov-muted" style={{ margin: '10px 0 16px', lineHeight: 1.6, fontSize: 12.5 }}>
          "{item.raw_text}"
        </div>
      )}
      <form onSubmit={approve} style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 420 }}>
        <div>
          <div className="te-hero-label">Amount</div>
          <div className="te-hero-row">
            <span className="te-hero-currency">{currency}</span>
            <input type="number" min="0" step="0.01" className="te-hero-input" aria-label="Amount" value={typedAmount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
        </div>
        {foreignCurrency && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="te-fieldcell">
              <span className="te-fieldlabel">AED debited</span>
              <input
                className="te-fieldvalue"
                type="number"
                min="0"
                step="0.01"
                aria-label="AED debited"
                value={aedDebited}
                onChange={(e) => setAedDebited(e.target.value)}
                placeholder={estimate ? formatMoney(Math.abs(estimate.aed), { decimals: 2 }) : 'From the statement'}
              />
            </label>
            <div className={estimate || aedDebited.trim() !== '' ? 'ov-muted' : 'ov-warn'} style={{ fontSize: 11.5 }}>
              {aedDebited.trim() !== ''
                ? `Recorded as ${foreignCurrency} ${typedAmount || 0}, with this AED as what every total counts.`
                : estimate
                  ? `Leave it blank to record an estimate of AED ${formatMoney(Math.abs(estimate.aed), { decimals: 2 })}, marked as one until the AED debited is entered.`
                  : `No ${foreignCurrency} rate for that date: enter the AED debited.`}
            </div>
          </div>
        )}

        <div className="te-fieldgrid">
          <div className="te-fieldcell te-span2">
            <span className="te-fieldlabel">Merchant</span>
            <input className="te-fieldvalue" type="text" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
          </div>
          <div className="te-fieldcell">
            <span className="te-fieldlabel">Date</span>
            <input
              className="te-fieldvalue"
              type="date"
              aria-label="Date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setDateConfirmed(true);
              }}
            />
            {/* No role="alert" on the warning: the form's own error is the
                one alert, and the date cell says where to look. */}
            {item.date_guessed && (
              <>
                {!dateConfirmed && (
                  <div className="ov-warn" style={{ fontSize: 11, marginTop: 4 }}>
                    Not in the message: the day it was sent.
                  </div>
                )}
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5 }}>
                  <input type="checkbox" checked={dateConfirmed} onChange={(e) => setDateConfirmed(e.target.checked)} />
                  <span>Paid on this day</span>
                </label>
              </>
            )}
          </div>
          <div className="te-fieldcell">
            <span className="te-fieldlabel">Account</span>
            <select className="te-fieldvalue" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {selectable.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountOptionLabel(a, { accounts: selectable, members })}
                </option>
              ))}
            </select>
            {suggestedAccountId && accountId === suggestedAccountId && (
              <div className="ov-muted" style={{ fontSize: 11, marginTop: 4 }}>
                Suggested from a card-ending match.
              </div>
            )}
          </div>
          <div className="te-fieldcell">
            <span className="te-fieldlabel">Currency</span>
            <input className="te-fieldvalue" type="text" value={currency} disabled />
          </div>
        </div>

        <div>
          <span className="te-fieldlabel">What this is</span>
          <div className="om-scope-list" style={{ marginTop: 10 }}>
            {INTAKE_KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                className="om-scope"
                data-active={kind === k.id}
                title={k.hint}
                onClick={() => setKind(k.id)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="te-fieldlabel">Whose</span>
          <div className="om-scope-list" style={{ marginTop: 10 }}>
            <button type="button" className="om-scope" data-active={owner === 'shared'} onClick={() => setOwner('shared')}>
              Shared
            </button>
            {members.map((m) => (
              <button key={m.id} type="button" className="om-scope" data-active={owner === m.id} onClick={() => setOwner(m.id)}>
                {m.display_name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="te-fieldlabel">Category</span>
          <div className="te-chips">
            <button type="button" className="om-seg" data-active={categoryId === ''} onClick={() => setCategoryId('')}>
              Uncategorised
            </button>
            {categories
              .filter((c) => (!c.archived && !c.is_savings) || c.id === categoryId)
              .map((c) => (
                <button key={c.id} type="button" className="om-seg" data-active={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
                  {c.name}
                </button>
              ))}
          </div>
        </div>
        {suggestedRule && categoryId === suggestedRule.category_id && (
          <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -12 }}>
            Suggested by a rule matching "{suggestedRule.pattern}".
          </div>
        )}

        {duplicatePending && (
          <div className="te-duplicate" role="status">
            <div className="te-duplicate-title">You may have sent this one twice</div>
            <div className="te-duplicate-body">
              Another pending entry for {duplicatePending.parsed_merchant}, {formatMoney(duplicatePending.parsed_amount)}, dated within
              a few days of this one, is also waiting for review. If both are real, approve both as usual; otherwise reject one.
            </div>
          </div>
        )}
        {duplicateTransaction && (
          <div className="te-duplicate" role="status">
            <div className="te-duplicate-title">A record like this already exists</div>
            <div className="te-duplicate-body">
              {duplicateTransaction.merchant}, {formatMoney(duplicateTransaction.amount)},{' '}
              {new Date(duplicateTransaction.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — already
              posted, within a few days of this one. Approving is allowed if the household really spent twice.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
              <button
                type="button"
                className="om-btn"
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
          <p className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="om-btn" onClick={reject} disabled={saving}>
            Reject
          </button>
          <button type="submit" className="om-btn ov-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Approve'}
          </button>
        </div>
      </form>
    </div>
  );
}
