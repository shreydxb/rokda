import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatBalance, formatSigned, formatMoney } from '../../lib/money';
import { isPosted, parseDay } from '../../lib/day';
import { DATE_BASES, activitySummary, isUncategorised, matchesDateBasis, rowDateLabel, shareOf, sortRows } from '../../lib/activity';
import {
  activeFilterCount,
  categoryAndChildren,
  datePresets,
  dateRangeLabel,
  inDateRange,
  monthRange,
  presetFor,
  readActivityFilters,
  UNCATEGORISED,
  withActivityFilter,
  withoutFilters,
} from '../../lib/activityLink';
import TransactionEditor from './TransactionEditor';
import TransferEditor from './TransferEditor';
import { transferCounterpart, transferDirectionLabel, transferLinkOf } from '../../lib/transfers';
import { amountInCategory, categoryParts, inCategory } from '../../lib/splits';
import ActivityCalendar from './ActivityCalendar';

// A transaction reads as low-confidence once it's below the same bar the
// Telegram bot uses to decide a record needs a human look (see
// isReadyForFastConfirm in intake.js) -- 0.85. Below 0.6 it's flagged as
// "needs attention" instead, matching how unsure an unreviewed intake row
// would have to be before this app itself wouldn't auto-suggest it.

// The list shows this many rows at a time; the totals always cover every
// matching record, not just the rows on screen.
const PAGE = 200;
const KIND_OPTIONS = [
  { id: 'all', label: 'All types' },
  { id: 'expense', label: 'Expenses' },
  { id: 'income', label: 'Income' },
  { id: 'refund', label: 'Refunds' },
  { id: 'transfer', label: 'Transfers' },
];
const SORT_OPTIONS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'largest', label: 'Largest first' },
];
function confidenceFlag(t) {
  if (t.confidence == null) return null;
  if (t.confidence < 0.6) return { label: 'needs attention', tone: 'neg' };
  if (t.confidence < 0.85) return { label: 'low confidence', tone: 'warn' };
  return null;
}

export default function Activity({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { transactions, accounts, categories, reload } = data;
  const links = useMemo(() => data.transactionLinks ?? [], [data.transactionLinks]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // Every filter is read from and written to the address, so a link can open
  // Activity already narrowed (a month and a category from Insights), and the
  // list survives Back and reload. Changing a filter replaces the history
  // entry rather than adding one per keystroke.
  const [params, setParams] = useSearchParams();
  // Posted by default, like every other total in the app: a record dated next
  // week is a plan, and counting it here made this line disagree with Overview
  // and Budget for the same month.
  const filters = readActivityFilters(params);
  const { categoryId: categoryFilter, search, needsReview: needsReviewOnly, estimated: estimatedOnly, dateBasis, from, to, view, accountId, kind, sort } = filters;
  const setFilter = (key, value) => setParams((prev) => withActivityFilter(prev, key, value), { replace: true });
  const setDates = (range) => setParams((prev) => withActivityFilter(withActivityFilter(prev, 'from', range.from), 'to', range.to), { replace: true });
  const filterCount = activeFilterCount(filters);
  // null closed; 'new' or { newType } for a new record; 'new-transfer'; or a
  // transaction row, which opens the transfer editor if it is one side of one.
  const [editing, setEditing] = useState(null);
  // What the last save added besides the record, such as a merchant rule,
  // shown above the list until dismissed. The filters stay as they were.
  const [notice, setNotice] = useState(null);
  // On a phone the second row of filters folds away behind "Filters (n)". It
  // starts open when a link arrives with one of them set, so the category it
  // narrowed to is in sight.
  const [moreOpen, setMoreOpen] = useState(
    () => categoryFilter !== 'all' || accountId !== 'all' || kind !== 'all' || needsReviewOnly || estimatedOnly || dateBasis !== 'posted',
  );
  const [shown, setShown] = useState({ key: '', count: PAGE });

  const now = useMemo(() => new Date(), []);
  // The date select: its presets, plus the current range by name when a link
  // set one that isn't a preset ("September 2026"), plus Custom, which shows
  // two date fields.
  const presets = useMemo(() => datePresets(now), [now]);
  const [customDates, setCustomDates] = useState(false);
  const preset = customDates ? 'custom' : (presetFor(from, to, now) ?? 'linked');
  const chooseDates = (id) => {
    if (id === 'custom') {
      setCustomDates(true);
      if (!from && !to) setDates(monthRange(now.getFullYear(), now.getMonth() + 1));
      return;
    }
    setCustomDates(false);
    if (id !== 'linked') setDates(presets.find((p) => p.id === id));
  };

  // A group includes its subcategories, as Budget rolls them up.
  const uncategorisedOnly = categoryFilter === UNCATEGORISED;
  const categoryIds = useMemo(
    () => (categoryFilter === 'all' || categoryFilter === UNCATEGORISED ? null : categoryAndChildren(categoryFilter, categories)),
    [categoryFilter, categories],
  );
  // Narrowed to a category, a split record counts only its line in it
  // (lib/splits.js); the row still shows, and opens with, the whole record.
  const amountOf = useMemo(() => (categoryIds ? (t) => amountInCategory(t, categoryIds) : undefined), [categoryIds]);
  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  // Refund links both ways (lib/refunds.js): each refund's purchase, and how
  // much of each purchase has come back, for the rows' "refund for" and
  // "refunded" labels.
  const refundLinks = useMemo(() => {
    const byId = new Map(transactions.map((t) => [t.id, t]));
    const purchaseOf = new Map();
    const back = new Map();
    for (const l of links) {
      if (l.kind !== 'refund') continue;
      purchaseOf.set(l.to_transaction_id, byId.get(l.from_transaction_id) ?? null);
      back.set(l.from_transaction_id, (back.get(l.from_transaction_id) ?? 0) + Number(byId.get(l.to_transaction_id)?.amount ?? 0));
    }
    return { purchaseOf, back };
  }, [links, transactions]);

  const matching = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (scopeMemberId !== null && !(t.is_shared || t.owner_member_id === scopeMemberId)) return false;
      if (needsReviewOnly && !t.needs_review) return false;
      if (estimatedOnly && !t.aed_estimated) return false;
      if (categoryIds && !inCategory(t, categoryIds)) return false;
      if (uncategorisedOnly && !isUncategorised(t)) return false;
      if (accountId !== 'all' && t.account_id !== accountId) return false;
      if (kind !== 'all' && (t.kind ?? (Number(t.amount) < 0 ? 'expense' : 'income')) !== kind) return false;
      if ((from || to) && !inDateRange(t, from, to)) return false;
      if (q) {
        const hay = `${t.merchant ?? ''} ${t.note ?? ''} ${t.amount}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [transactions, categoryIds, uncategorisedOnly, scopeMemberId, needsReviewOnly, estimatedOnly, accountId, kind, search, from, to]);
  // Offered once there is something to narrow to, or a link set it.
  const anyEstimated = estimatedOnly || transactions.some((t) => t.aed_estimated);
  const rows = useMemo(() => sortRows(matching.filter((t) => matchesDateBasis(t, dateBasis, now)), sort), [matching, dateBasis, now, sort]);
  // Records the other filters match that Posted leaves out, so a record just
  // entered with next week's date doesn't simply vanish.
  const scheduledHidden = dateBasis === 'posted' ? matching.length - rows.length : 0;
  // A new set of filters starts again from the first page.
  const pageKey = params.toString();
  const visibleCount = shown.key === pageKey ? shown.count : PAGE;

  const totals = useMemo(() => activitySummary(rows, scopeMemberId, amountOf), [rows, scopeMemberId, amountOf]);
  // Under Me or the partner's name, figures are that person's share: their own
  // records in full and half of each shared one. Rows still show the whole
  // amount, so the share is shown beside it wherever the two differ.
  const shareLabel = scopeMemberId === null ? null : scopeMemberId === me?.id ? 'Your share' : `${members.find((m) => m.id === scopeMemberId)?.display_name ?? 'Partner'}'s share`;

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      {notice && (
        <div className="mn-notice" role="status">
          <span>
            {notice.text}
            {notice.ruleId && (
              <>
                {' '}
                <Link to={`/settings?tab=categories&rule=${encodeURIComponent(notice.ruleId)}`}>See the rule in Settings</Link>
              </>
            )}
          </span>
          <button type="button" className="mn-notice-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
      <div className="mn-filters">
        <input
          className="mn-search"
          aria-label="Search"
          placeholder="Search merchant, note or amount"
          value={search}
          onChange={(e) => setFilter('search', e.target.value)}
        />
        <select className="om-seg" aria-label="Dates" value={preset} onChange={(e) => chooseDates(e.target.value)}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {preset === 'linked' && <option value="linked">{dateRangeLabel(from, to)}</option>}
          <option value="custom">Custom dates…</option>
        </select>
        {preset === 'custom' && (
          <span className="mn-custom-dates">
            <input type="date" className="om-seg" aria-label="From" value={from ?? ''} max={to ?? undefined} onChange={(e) => setFilter('from', e.target.value || null)} />
            <span className="ov-muted">to</span>
            <input type="date" className="om-seg" aria-label="To" value={to ?? ''} min={from ?? undefined} onChange={(e) => setFilter('to', e.target.value || null)} />
          </span>
        )}
        <button type="button" className="om-seg mn-more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
          Filters{filterCount > 0 ? ` (${filterCount})` : ''}
        </button>
        <div className="mn-viewtoggle">
          <button type="button" className="om-seg" data-active={view === 'list'} onClick={() => setFilter('view', 'list')}>
            List
          </button>
          <button type="button" className="om-seg" data-active={view === 'calendar'} onClick={() => setFilter('view', 'calendar')}>
            Calendar
          </button>
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Add transaction
        </button>
      </div>
      <div className="mn-filters mn-more" data-open={moreOpen}>
        <select className="om-seg" aria-label="Category" value={categoryFilter} onChange={(e) => setFilter('categoryId', e.target.value)}>
          <option value="all">All categories</option>
          <option value={UNCATEGORISED}>Uncategorised</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.parent_id ? `– ${c.name}` : c.name}
            </option>
          ))}
        </select>
        <select className="om-seg" aria-label="Account" value={accountId} onChange={(e) => setFilter('accountId', e.target.value)}>
          <option value="all">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.archived_at ? ' (closed)' : ''}
            </option>
          ))}
        </select>
        <select className="om-seg" aria-label="Type" value={kind} onChange={(e) => setFilter('kind', e.target.value)}>
          {KIND_OPTIONS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <div className="mn-datebasis" role="group" aria-label="Which dates">
          {DATE_BASES.map((b) => (
            <button key={b.id} type="button" className="om-seg" data-active={dateBasis === b.id} onClick={() => setFilter('dateBasis', b.id)}>
              {b.label}
            </button>
          ))}
        </div>
        <button type="button" className="om-seg" data-active={needsReviewOnly} onClick={() => setFilter('needsReview', !needsReviewOnly)}>
          Needs review
        </button>
        {anyEstimated && (
          <button type="button" className="om-seg" data-active={estimatedOnly} onClick={() => setFilter('estimated', !estimatedOnly)}>
            AED estimated
          </button>
        )}
        <select className="om-seg" aria-label="Sort" value={sort} onChange={(e) => setFilter('sort', e.target.value)}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {filterCount > 0 && (
          <button
            type="button"
            className="mn-count-link"
            onClick={() => {
              setCustomDates(false);
              setParams((prev) => withoutFilters(prev), { replace: true });
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      <div className="mn-count">
        {rows.length} {dateBasis === 'all' ? '' : `${dateBasis} `}record{rows.length === 1 ? '' : 's'}
        {rangeText(from, to)}
        {rows.length > 0 && (
          <>
            {' · '}
            Net spend AED {formatBalance(totals.spend)}
            {totals.refunds !== 0 && ` (purchases ${formatMoney(totals.purchases)} less refunds ${formatMoney(totals.refunds)})`}
            {' · '}Income AED {formatMoney(totals.income)}
            {totals.transfers > 0 && ` · ${totals.transfers} transfer${totals.transfers === 1 ? '' : 's'} between accounts, in neither`}
            {shareLabel && ` · ${shareLabel}: shared records count half`}
          </>
        )}
        {scheduledHidden > 0 && (
          <>
            {' · '}
            <button type="button" className="mn-count-link" onClick={() => setFilter('dateBasis', 'all')}>
              {scheduledHidden} scheduled not counted
            </button>
          </>
        )}
      </div>

      {view === 'calendar' ? (
        <ActivityCalendar rows={rows} members={members} scopeMemberId={scopeMemberId} shareLabel={shareLabel} onOpen={setEditing} startMonth={from} amountOf={amountOf} />
      ) : rows.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No records</div>
          <div className="ov-empty-body">
            {transactions.length === 0
              ? 'Nothing recorded yet. Add a record by hand to get started.'
              : 'Nothing matches your filters.'}
          </div>
          <div className="ov-empty-actions">
            <button type="button" className="om-btn ov-btn-primary" onClick={() => setEditing('new')}>
              Add a transaction
            </button>
          </div>
        </div>
      ) : (
        <div className="mn-list">
          <div className="om-tx om-tx-head">
            <div className="om-hide-sm">Date</div>
            <div>Merchant</div>
            <div className="om-hide-sm">Category</div>
            <div className="om-hide-sm">Owner</div>
            <div className="om-hide-sm">Account</div>
            <div className="om-tx-amt">Amount</div>
            <div className="om-hide-sm" />
          </div>
          {rows.slice(0, visibleCount).map((t) => {
            const transfer = t.kind === 'transfer';
            // A transfer has no category or merchant to give; its row says
            // which way the money went instead.
            const parts = t.is_split ? categoryParts(t) : null;
            const categoryName = transfer
              ? 'Transfer'
              : parts
                ? parts.map((p) => catName.get(p.categoryId) ?? 'Unknown').join(' + ')
                : (t.categories?.name ?? 'Uncategorised');
            // The line of a split record in the category Activity is narrowed to.
            const inFiltered = parts && amountOf ? amountOf(t) : null;
            const label = transfer ? transferDirectionLabel(t, transferCounterpart(t, links, transactions), accountById) : null;
            const owner = ownerLabel(t, members);
            const account = accountById.get(t.account_id)?.name ?? '—';
            const flag = confidenceFlag(t);
            const share = shareOf(t, scopeMemberId);
            const scheduled = !isPosted(t, now);
            const date = rowDateLabel(t.occurred_at, now);
            return (
              <button key={t.id} type="button" className="om-tx om-tx-row" onClick={() => setEditing(t)}>
                <div className="om-hide-sm om-tx-date">{date}</div>
                <div className="om-tx-merchant">
                  {transfer ? label : t.merchant || 'Transaction'}
                  {t.needs_review && <span className="om-tx-flag ov-warn"> · needs review</span>}
                  {!t.needs_review && flag && <span className={`om-tx-flag ${flag.tone === 'neg' ? 'ov-neg' : 'ov-warn'}`}> · {flag.label}</span>}
                  {scheduled && <span className="om-tx-flag ov-muted"> · scheduled</span>}
                  {t.kind === 'refund' && <span className="om-tx-flag ov-muted"> · {refundLabel(refundLinks.purchaseOf.get(t.id), refundLinks.purchaseOf.has(t.id))}</span>}
                  {refundLinks.back.has(t.id) && (
                    <span className="om-tx-flag ov-muted"> · {refundLinks.back.get(t.id) + 0.005 >= -Number(t.amount) ? 'refunded' : 'part refunded'}</span>
                  )}
                  {/* On a phone the date leads this line, so the merchant gets
                      the row's width instead of a column beside the date. */}
                  <div className="om-tx-meta">
                    {date} · {categoryName} · {account} · {owner}
                  </div>
                </div>
                <div className={`om-hide-sm om-tx-cat ${categoryName === 'Uncategorised' ? 'ov-warn' : transfer ? 'ov-muted' : ''}`}>{categoryName}</div>
                <div className="om-hide-sm om-tx-owner">{owner}</div>
                <div className="om-hide-sm om-tx-account">{account}</div>
                <div className={`fig om-tx-amt ${transfer ? 'ov-muted' : Number(t.amount) > 0 ? 'ov-pos' : ''}`}>
                  {formatSigned(t.amount)}
                  {/* What was paid, when it was another currency, and whether
                      the AED is still an estimate. */}
                  {t.native_amount != null && t.currency && t.currency !== 'AED' && (
                    <span className={`om-tx-share${t.aed_estimated ? ' ov-warn' : ''}`}>
                      {t.currency} {formatSigned(t.native_amount)}
                      {t.aed_estimated ? ' · AED estimated' : ''}
                    </span>
                  )}
                  {inFiltered !== null && (
                    <span className="om-tx-share">
                      {catName.get(categoryFilter) ?? 'this category'} {formatSigned(inFiltered)}
                    </span>
                  )}
                  {shareLabel && share !== Number(t.amount) && (
                    <span className="om-tx-share">
                      {shareLabel.toLowerCase()} {formatSigned(share)}
                    </span>
                  )}
                </div>
                <div className="om-hide-sm om-tx-chev">›</div>
              </button>
            );
          })}
          {rows.length > visibleCount && (
            <button type="button" className="om-btn mn-show-more" onClick={() => setShown({ key: pageKey, count: visibleCount + PAGE })}>
              Show {Math.min(PAGE, rows.length - visibleCount)} more · {rows.length - visibleCount} not shown
            </button>
          )}
        </div>
      )}

      {editing && (() => {
        const close = () => setEditing(null);
        const saved = async ({ notice: next = null } = {}) => {
          setEditing(null);
          setNotice(next);
          await reload();
        };
        const link = editing !== 'new' && editing !== 'new-transfer' && !editing.newType ? transferLinkOf(editing.id, links) : null;
        if (editing === 'new-transfer' || link) {
          const transfer = link
            ? { link, out: transactions.find((t) => t.id === link.from_transaction_id), in: transactions.find((t) => t.id === link.to_transaction_id) }
            : null;
          return (
            <TransferEditor
              transfer={transfer?.out && transfer?.in ? transfer : null}
              householdId={household?.id}
              accounts={accounts}
              members={members}
              onClose={close}
              onSaved={saved}
              onSwitchType={(type) => setEditing({ newType: type })}
            />
          );
        }
        const isNew = editing === 'new' || !!editing.newType;
        return (
          <TransactionEditor
            key={isNew ? `new-${editing.newType ?? 'expense'}` : editing.id}
            tx={isNew ? null : editing}
            initial={editing.newType ? { type: editing.newType } : undefined}
            household={household}
            householdId={household?.id}
            accounts={accounts}
            categories={categories}
            members={members}
            allTransactions={transactions}
            links={links}
            categoryRules={data.categoryRules ?? []}
            fxHistory={data.fxRateHistory}
            onOpenOther={(other) => setEditing(other)}
            onSwitchToTransfer={() => setEditing('new-transfer')}
            onClose={close}
            onSaved={saved}
          />
        );
      })()}
    </div>
  );
}

// "refund for Shop, 20 Sept" once linked to its purchase, otherwise "refund".
function refundLabel(purchase, linked) {
  if (!linked) return 'refund';
  if (!purchase) return 'refund for a purchase';
  return `refund for ${purchase.merchant || 'a purchase'}, ${parseDay(purchase.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

function ownerLabel(t, members) {
  if (t.is_shared) return 'Shared';
  return members.find((m) => m.id === t.owner_member_id)?.display_name ?? 'Unassigned';
}

// " · 1 Sep – 30 Sep 2026", when the list is narrowed to dates.
function rangeText(from, to) {
  const label = dateRangeLabel(from, to);
  return label ? ` · ${label}` : '';
}
