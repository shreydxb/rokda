import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/money';
import { firstMatchingRule } from '../../lib/rules';
import { accountOptionLabel, selectableAccounts } from '../../lib/accounts';
import { INTAKE_KINDS, approvalArgs, validateApproval } from '../../lib/intake';
import { findDuplicate } from '../../lib/duplicates';
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

export default function Inbox({ members = [], accounts, categories, data, loading }) {
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
  const oldest = pending[pending.length - 1];

  async function approveConfident() {
    setBulkSaving(true);
    setError('');
    for (const item of confident) {
      const form = {
        accountId: item.parsed_account_id,
        amount: item.parsed_amount,
        date: item.parsed_date,
        kind: 'expense',
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
            ? `${pending.length} waiting · ${confident.length} read cleanly${oldest ? ` · oldest ${ago(oldest.created_at)}` : ''}`
            : 'All filed'}
        </div>
        {pending.length > 0 && (
          <button type="button" className="om-btn" disabled={confident.length === 0 || bulkSaving} onClick={approveConfident}>
            {bulkSaving ? 'Approving…' : confident.length ? `Approve ${confident.length} confident` : 'Nothing to bulk-approve'}
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
                          {senderName(i, members) ?? i.source} · {ago(i.created_at)}
                        </span>
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
function IntakeReview({ item, sender, accounts, members, categories, categoryRules, allTransactions, duplicatePending, saving, setSaving, error, setError, onDone }) {
  const [mode, setMode] = useState('review'); // 'review' | 'edit'

  const catById = new Map(categories.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const suggestedAccount = item.parsed_account_id ? accountById.get(item.parsed_account_id) : null;
  const suggestedCategory = item.parsed_category_id ? catById.get(item.parsed_category_id) : null;
  const lowConfidence = item.confidence !== null && Number(item.confidence) < READ_CLEANLY_THRESHOLD;

  const fields = [
    { label: 'Merchant', value: item.parsed_merchant ?? 'Not read', hint: item.parsed_merchant ? '' : 'Nothing readable', ok: !!item.parsed_merchant },
    { label: 'Amount', value: item.parsed_amount !== null ? `AED ${formatMoney(item.parsed_amount)}` : 'Not read', hint: '', ok: item.parsed_amount !== null },
    { label: 'Date', value: item.parsed_date ?? 'Not read', hint: '', ok: !!item.parsed_date },
    { label: 'Category', value: suggestedCategory?.name ?? 'Uncategorised', hint: item.parsed_category_id ? '' : 'No rule matched', ok: !!item.parsed_category_id },
    { label: 'Account', value: suggestedAccount?.name ?? 'Not matched', hint: item.parsed_account_id ? '' : 'Ambiguous or unmatched', ok: !!item.parsed_account_id },
    { label: 'Currency', value: item.parsed_currency ?? 'AED', hint: item.parsed_currency && item.parsed_currency !== 'AED' ? 'Not AED -- needs a manual AED amount' : '', ok: !item.parsed_currency || item.parsed_currency === 'AED' },
  ];

  async function approveDirect() {
    const form = {
      accountId: item.parsed_account_id,
      amount: item.parsed_amount,
      date: item.parsed_date,
      kind: 'expense',
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
            {sender ? `From ${sender}` : 'Unassigned'} · {ago(item.created_at)} · via Telegram
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

function IntakeEditForm({ item, sender, accounts, members, categories, categoryRules, allTransactions, duplicatePending, saving, setSaving, error, setError, onBack, onDone }) {
  // A detected non-AED currency means the parsed amount is in that currency,
  // not AED -- prefilling it as though it were an AED figure would be
  // actively misleading, so it's left blank for the reviewer to enter the
  // real AED-equivalent themselves (a card's actual FX markup isn't
  // something this app can know, so it never guesses a conversion).
  const foreignCurrency = item.parsed_currency && item.parsed_currency !== 'AED' ? item.parsed_currency : null;
  const [amount, setAmount] = useState(!foreignCurrency && item.parsed_amount !== null ? String(item.parsed_amount) : '');
  const [merchant, setMerchant] = useState(item.parsed_merchant ?? '');
  const [date, setDate] = useState(item.parsed_date ?? new Date().toISOString().slice(0, 10));
  // Intake can only be approved onto an open account (QA-01).
  const selectable = selectableAccounts(accounts);
  const suggestedAccountId = item.parsed_account_id && selectable.some((a) => a.id === item.parsed_account_id) ? item.parsed_account_id : null;
  const [accountId, setAccountId] = useState(suggestedAccountId ?? selectable[0]?.id ?? '');
  const suggestedRule = item.parsed_category_id ? null : firstMatchingRule(item.parsed_merchant, categoryRules);
  const [categoryId, setCategoryId] = useState(item.parsed_category_id ?? suggestedRule?.category_id ?? '');
  // Every item used to be forced to a shared AED expense. The reviewer says
  // which it is (QA-11).
  const [kind, setKind] = useState('expense');
  // Fixed, not user-editable: there is no native-currency conversion yet, and
  // every dashboard total already treats amount as AED. Letting this field
  // be typed into let "USD" get entered while the number stayed an
  // unconverted AED figure — approved, but silently wrong everywhere it was
  // later read (SHR-252).
  const currency = 'AED';
  const [owner, setOwner] = useState('shared');
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);

  const duplicateTransaction = duplicateDismissed
    ? null
    : findDuplicate({ merchant, amount, account_id: accountId, occurred_at: date }, allTransactions, null);

  const form = {
    accountId,
    amount,
    date,
    kind,
    categoryId,
    currency,
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
    const invalid = validateApproval(form);
    if (invalid) {
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
        <button type="button" className="ov-link" onClick={onBack}>
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
            <span className="te-hero-currency">AED</span>
            <input type="number" min="0" step="0.01" className="te-hero-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
        </div>
        {foreignCurrency && (
          <div className="ov-warn" role="alert" style={{ fontSize: 12.5 }}>
            Detected as {item.parsed_amount} {foreignCurrency} — this app only tracks AED. Enter the real AED-equivalent amount
            from your statement below; a card's exchange markup isn't something this can convert for you.
          </div>
        )}

        <div className="te-fieldgrid">
          <div className="te-fieldcell te-span2">
            <span className="te-fieldlabel">Merchant</span>
            <input className="te-fieldvalue" type="text" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
          </div>
          <div className="te-fieldcell">
            <span className="te-fieldlabel">Date</span>
            <input className="te-fieldvalue" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
        <div className="ov-muted" style={{ fontSize: 11.5, marginTop: -12 }}>
          AED only for now — there’s no native-currency conversion, so approval can’t mix units.
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
              .filter((c) => !c.archived || c.id === categoryId)
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
              <button type="button" className="om-btn" onClick={() => setDuplicateDismissed(true)}>
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
