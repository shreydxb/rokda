import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatBalance, formatSigned, formatMoney } from '../../lib/money';
import { isPosted } from '../../lib/day';
import { DATE_BASES, incomeAndSpend, matchesDateBasis, shareOf } from '../../lib/activity';
import { categoryAndChildren, dateRangeLabel, inDateRange, readActivityFilters, withActivityFilter } from '../../lib/activityLink';
import TransactionEditor from './TransactionEditor';
import ActivityCalendar from './ActivityCalendar';

// A transaction reads as low-confidence once it's below the same bar the
// Telegram bot uses to decide a record needs a human look (see
// isReadyForFastConfirm in intake.js) -- 0.85. Below 0.6 it's flagged as
// "needs attention" instead, matching how unsure an unreviewed intake row
// would have to be before this app itself wouldn't auto-suggest it.
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
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // Every filter is read from and written to the address, so a link can open
  // Activity already narrowed (a month and a category from Insights), and the
  // list survives Back and reload. Changing a filter replaces the history
  // entry rather than adding one per keystroke.
  const [params, setParams] = useSearchParams();
  // Posted by default, like every other total in the app: a record dated next
  // week is a plan, and counting it here made this line disagree with Overview
  // and Budget for the same month.
  const { categoryId: categoryFilter, search, needsReview: needsReviewOnly, dateBasis, from, to, view } = readActivityFilters(params);
  const setFilter = (key, value) => setParams((prev) => withActivityFilter(prev, key, value), { replace: true });
  const setCategoryFilter = (value) => setFilter('categoryId', value);
  const setSearch = (value) => setFilter('search', value);
  const setDateBasis = (value) => setFilter('dateBasis', value);
  const setView = (value) => setFilter('view', value);
  const clearDates = () => setParams((prev) => withActivityFilter(withActivityFilter(prev, 'from', null), 'to', null), { replace: true });
  const rangeLabel = dateRangeLabel(from, to);
  const [editing, setEditing] = useState(null); // null closed, 'new', or a transaction row

  const now = useMemo(() => new Date(), []);
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase();
    // A group includes its subcategories, as Budget rolls them up.
    const categoryIds = categoryFilter === 'all' ? null : categoryAndChildren(categoryFilter, categories);
    return transactions.filter((t) => {
      if (scopeMemberId !== null && !(t.is_shared || t.owner_member_id === scopeMemberId)) return false;
      if (needsReviewOnly && !t.needs_review) return false;
      if (categoryIds && !categoryIds.has(t.category_id)) return false;
      if ((from || to) && !inDateRange(t, from, to)) return false;
      if (q) {
        const hay = `${t.merchant ?? ''} ${t.note ?? ''} ${t.amount}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [transactions, categories, scopeMemberId, needsReviewOnly, categoryFilter, search, from, to]);
  const rows = useMemo(() => matching.filter((t) => matchesDateBasis(t, dateBasis, now)), [matching, dateBasis, now]);
  // Records the other filters match that Posted leaves out, so a record just
  // entered with next week's date doesn't simply vanish.
  const scheduledHidden = dateBasis === 'posted' ? matching.length - rows.length : 0;

  const totals = useMemo(() => incomeAndSpend(rows, scopeMemberId), [rows, scopeMemberId]);
  // Under Me or the partner's name, figures are that person's share: their own
  // records in full and half of each shared one. Rows still show the whole
  // amount, so the share is shown beside it wherever the two differ.
  const shareLabel = scopeMemberId === null ? null : scopeMemberId === me?.id ? 'Your share' : `${members.find((m) => m.id === scopeMemberId)?.display_name ?? 'Partner'}'s share`;

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <div className="mn-filters">
        <input
          className="mn-search"
          placeholder="Search merchant, note or amount"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {rangeLabel && (
          <button type="button" className="om-seg mn-chip" data-active="true" onClick={clearDates} aria-label={`${rangeLabel}: show all dates`}>
            {rangeLabel} ✕
          </button>
        )}
        <select className="om-seg" aria-label="Category" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="om-seg"
          data-active={needsReviewOnly}
          onClick={() => setFilter('needsReview', !needsReviewOnly)}
        >
          Needs review
        </button>
        <div className="mn-datebasis" role="group" aria-label="Which dates">
          {DATE_BASES.map((b) => (
            <button key={b.id} type="button" className="om-seg" data-active={dateBasis === b.id} onClick={() => setDateBasis(b.id)}>
              {b.label}
            </button>
          ))}
        </div>
        <div className="mn-viewtoggle">
          <button type="button" className="om-seg" data-active={view === 'list'} onClick={() => setView('list')}>
            List
          </button>
          <button type="button" className="om-seg" data-active={view === 'calendar'} onClick={() => setView('calendar')}>
            Calendar
          </button>
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Add transaction
        </button>
      </div>
      <div className="mn-count">
        {rows.length} {dateBasis === 'all' ? '' : `${dateBasis} `}record{rows.length === 1 ? '' : 's'}
        {rows.length > 0 && (
          <>
            {' · '}
            Spent AED {formatBalance(totals.spend)} net of refunds · Income AED {formatMoney(totals.income)}
            {shareLabel && ` · ${shareLabel}: shared records count half`}
          </>
        )}
        {scheduledHidden > 0 && (
          <>
            {' · '}
            <button type="button" className="mn-count-link" onClick={() => setDateBasis('all')}>
              {scheduledHidden} scheduled not counted
            </button>
          </>
        )}
      </div>

      {view === 'calendar' ? (
        <ActivityCalendar rows={rows} members={members} scopeMemberId={scopeMemberId} shareLabel={shareLabel} onOpen={setEditing} startMonth={from} />
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
            <div>Date</div>
            <div>Merchant</div>
            <div className="om-hide-sm">Category</div>
            <div className="om-hide-sm">Owner</div>
            <div className="om-hide-sm">Account</div>
            <div className="om-tx-amt">Amount</div>
            <div />
          </div>
          {rows.map((t) => {
            const categoryName = t.categories?.name ?? 'Uncategorised';
            const owner = ownerLabel(t, members);
            const account = accountById.get(t.account_id)?.name ?? '—';
            const flag = confidenceFlag(t);
            const share = shareOf(t, scopeMemberId);
            const scheduled = !isPosted(t, now);
            return (
              <button key={t.id} type="button" className="om-tx om-tx-row" onClick={() => setEditing(t)}>
                <div className="om-tx-date">
                  {new Date(t.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </div>
                <div className="om-tx-merchant">
                  {t.merchant || 'Transaction'}
                  {t.needs_review && <span className="om-tx-flag ov-warn"> · needs review</span>}
                  {!t.needs_review && flag && <span className={`om-tx-flag ${flag.tone === 'neg' ? 'ov-neg' : 'ov-warn'}`}> · {flag.label}</span>}
                  {scheduled && <span className="om-tx-flag ov-muted"> · scheduled</span>}
                  <div className="om-tx-meta">
                    {categoryName} · {account} · {owner}
                  </div>
                </div>
                <div className={`om-hide-sm om-tx-cat ${categoryName === 'Uncategorised' ? 'ov-warn' : ''}`}>{categoryName}</div>
                <div className="om-hide-sm om-tx-owner">{owner}</div>
                <div className="om-hide-sm om-tx-account">{account}</div>
                <div className={`fig om-tx-amt ${Number(t.amount) > 0 ? 'ov-pos' : ''}`}>
                  {formatSigned(t.amount)}
                  {shareLabel && share !== Number(t.amount) && (
                    <span className="om-tx-share">
                      {shareLabel.toLowerCase()} {formatSigned(share)}
                    </span>
                  )}
                </div>
                <div className="om-tx-chev">›</div>
              </button>
            );
          })}
        </div>
      )}

      {editing && (
        <TransactionEditor
          tx={editing === 'new' ? null : editing}
          household={household}
          householdId={household?.id}
          accounts={accounts}
          categories={categories}
          members={members}
          allTransactions={transactions}
          onOpenOther={(other) => setEditing(other)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ownerLabel(t, members) {
  if (t.is_shared) return 'Shared';
  return members.find((m) => m.id === t.owner_member_id)?.display_name ?? 'Unassigned';
}
