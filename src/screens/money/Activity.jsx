import { useMemo, useState } from 'react';
import { useNow } from '../../lib/useNow';
import { Link, useSearchParams } from 'react-router-dom';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { isPosted, parseDay } from '../../lib/day';
import { activitySummary, isUncategorised, matchesDateBasis, sortRows } from '../../lib/activity';
import {
  activityPeriod,
  categoryAndChildren,
  inDateRange,
  monthRange,
  readActivityFilters,
  UNCATEGORISED,
  withActivityFilter,
  withActivityMonth,
  withAllDates,
  withoutFilters,
} from '../../lib/activityLink';
import { possibleDuplicateIds } from '../../lib/duplicates';
import { amountInCategory, inCategory } from '../../lib/splits';
import { EmptyState, MonthStepper, Segmented } from '../../design-system/kit';
import RecordEditor from './RecordEditor';
import ActivityCalendar from './ActivityCalendar';
import ActivityFilters from './ActivityFilters';
import ActivityTable from './ActivityTable';
import ActivityMerchants from './ActivityMerchants';
import { Tools } from '../PageTools';
import { setCategory } from './setCategory';
import './Activity.css';

// Money -> Activity, built like the prototype (the revamp, phase 4;
// design/prototype/js/screens-money.js): the month, the view and
// + Transaction in the page header, the filters in one row, and the records
// as a table under their count and totals.

// The list shows this many rows at a time; the totals always cover every
// matching record, not just the rows on screen.
const PAGE = 200;
const VIEWS = [
  { id: 'list', label: 'List' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'merchants', label: 'Merchants' },
];
const monthShort = (d) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }).replace('Sept', 'Sep');
const monthLong = (d) => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

export default function Activity({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { transactions, accounts, categories, reload } = data;
  const links = useMemo(() => data.transactionLinks ?? [], [data.transactionLinks]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const now = useNow(data?.loadedAt);

  // Every filter is read from and written to the address, so a link can open
  // Activity already narrowed (a month and a category from Budget), and the
  // list survives Back and reload. Changing a filter replaces the history
  // entry rather than adding one per keystroke.
  const [params, setParams] = useSearchParams();
  const filters = readActivityFilters(params);
  const { categoryId: categoryFilter, search, needsReview: needsReviewOnly, estimated: estimatedOnly, dateBasis, view, accountId, kind, sort } = filters;
  // Which dates: this month by default, the month in the address (shared
  // with Budget), every date, or a range of a link's or one's own.
  const period = useMemo(() => activityPeriod(params, now), [params, now]);
  const { from, to } = period;
  const update = (change) => setParams((prev) => change(prev), { replace: true });
  const setFilter = (key, value) => update((prev) => withActivityFilter(prev, key, value));
  // "Custom…" shows two date fields, even while they still hold a whole month.
  const [customDates, setCustomDates] = useState(false);
  const toMonth = (month) => {
    setCustomDates(false);
    update((prev) => withActivityMonth(prev, month, now));
  };
  const chooseDates = (id) => {
    if (id === 'month') toMonth(period.month);
    else if (id === 'all') {
      setCustomDates(false);
      update(withAllDates);
    } else if (id === 'custom') {
      setCustomDates(true);
      const whole = monthRange(period.month.getFullYear(), period.month.getMonth() + 1);
      update((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('range');
        next.delete('month');
        next.set('from', from ?? whole.from);
        next.set('to', to ?? whole.to);
        return next;
      });
    }
  };
  const setRange = (end, value) =>
    update((prev) => {
      const next = withActivityFilter(prev, end, value);
      next.delete('range');
      return next;
    });
  const clearAll = () => {
    setCustomDates(false);
    update((prev) => {
      const next = withoutFilters(prev);
      next.delete('range');
      return next;
    });
  };
  const clearOne = (key) => {
    if (key === 'range') toMonth(period.month);
    else setFilter(key, null);
  };

  // null closed; 'new' or { newType } for a new record; 'new-transfer'; or a
  // transaction row, which opens the transfer editor if it is one side of one.
  const [editing, setEditing] = useState(null);
  // What the last save added besides the record, such as a merchant rule,
  // shown above the list until dismissed. The filters stay as they were.
  const [notice, setNotice] = useState(null);
  const [shown, setShown] = useState({ key: '', count: PAGE });

  // A group includes its subcategories, as Budget rolls them up.
  const uncategorisedOnly = categoryFilter === UNCATEGORISED;
  const categoryIds = useMemo(
    () => (categoryFilter === 'all' || categoryFilter === UNCATEGORISED ? null : categoryAndChildren(categoryFilter, categories)),
    [categoryFilter, categories],
  );
  // Narrowed to a category, a split record counts only its line in it
  // (lib/splits.js); the row still shows, and opens with, the whole record.
  const amountOf = useMemo(() => (categoryIds ? (t) => amountInCategory(t, categoryIds) : undefined), [categoryIds]);
  // Refund links both ways (lib/refunds.js): each refund's purchase, and how
  // much of each purchase has come back.
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

  const inScope = useMemo(
    () => transactions.filter((t) => scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId),
    [transactions, scopeMemberId],
  );
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inScope.filter((t) => {
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
  }, [inScope, categoryIds, uncategorisedOnly, needsReviewOnly, estimatedOnly, accountId, kind, search, from, to]);
  // Offered once there is something to narrow to, or a link set it.
  const anyEstimated = estimatedOnly || transactions.some((t) => t.aed_estimated);
  const rows = useMemo(() => sortRows(matching.filter((t) => matchesDateBasis(t, dateBasis, now)), sort), [matching, dateBasis, now, sort]);
  // Records the other filters match that Posted leaves out, so a record just
  // entered with next week's date doesn't simply vanish.
  const scheduledHidden = dateBasis === 'posted' ? matching.length - rows.length : 0;
  // The pairs Month end asks about, marked where they are listed too.
  const duplicateIds = useMemo(() => possibleDuplicateIds(transactions, links), [transactions, links]);
  // A new set of filters starts again from the first page.
  const pageKey = params.toString();
  const visibleCount = shown.key === pageKey ? shown.count : PAGE;
  const totals = useMemo(() => activitySummary(rows, scopeMemberId, amountOf), [rows, scopeMemberId, amountOf]);

  // A month with no records at all, whatever the filters, says so and offers
  // the latest month that has some (design/prototype emptyMonth).
  const monthEmpty = period.mode === 'month' && !inScope.some((t) => inDateRange(t, from, to));
  const latest = useMemo(() => {
    const posted = inScope.filter((t) => isPosted(t, now)).map((t) => t.occurred_at).sort();
    const day = posted.length ? parseDay(posted[posted.length - 1]) : now;
    return new Date(day.getFullYear(), day.getMonth(), 1);
  }, [inScope, now]);
  const earliest = useMemo(() => {
    const days = inScope.map((t) => t.occurred_at).sort();
    return days.length ? parseDay(days[0]) : null;
  }, [inScope]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const step = (by) => toMonth(new Date(period.month.getFullYear(), period.month.getMonth() + by, 1));
  const tools = (
    <Tools>
      <MonthStepper label={monthShort(period.month)} onPrev={() => step(-1)} onNext={() => step(1)} />
      <Segmented label="View" options={VIEWS} value={view} onChange={(v) => setFilter('view', v)} />
      <button type="button" className="ds-btn ds-btn-primary" onClick={() => setEditing('new')}>
        + Transaction
      </button>
    </Tools>
  );

  let body;
  if (transactions.length === 0) {
    body = <EmptyState title="Nothing recorded yet" body="Add a record by hand to get started." action={{ label: '+ Transaction', onClick: () => setEditing('new') }} />;
  } else if (monthEmpty) {
    body = (
      <div className="ds-empty">
        <div className="ds-empty-title">{`No transactions in ${monthLong(period.month)}`}</div>
        {earliest && <div className="ds-empty-body">{`Records start in ${monthShort(earliest)}.`}</div>}
        <div className="mn-empty-actions">
          <button type="button" className="ds-btn ds-btn-primary" onClick={() => setEditing('new')}>
            + Transaction
          </button>
          <button type="button" className="ds-link ds-link-accent" onClick={() => toMonth(latest)}>
            {`Back to ${monthShort(latest)}`}
          </button>
        </div>
      </div>
    );
  } else {
    // The list and a calendar day's records are the same table.
    const table = {
      visibleCount,
      onShowMore: () => setShown({ key: pageKey, count: visibleCount + PAGE }),
      totals,
      scheduledHidden,
      onShowScheduled: () => setFilter('dateBasis', 'all'),
      sort,
      onSort: (next) => setFilter('sort', next),
      scopeMemberId,
      members,
      categories,
      accountById,
      links,
      transactions,
      refundLinks,
      amountOf,
      categoryFilterName: categories.find((c) => c.id === categoryFilter)?.name ?? 'this category',
      duplicateIds,
      now,
      onOpen: setEditing,
      onCategorise: async (t, category) => {
        const result = await setCategory(t, category);
        if (!result.error) await reload();
        return result;
      },
      onClearFilters: clearAll,
    };
    if (view === 'calendar') {
      body = (
        <ActivityCalendar
          rows={rows}
          scopeMemberId={scopeMemberId}
          month={period.month}
          amountOf={amountOf}
          renderDay={(day, items) => (
            <ActivityTable
              {...table}
              title={`${day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace('Sept', 'Sep')} · ${items.length} transaction${items.length === 1 ? '' : 's'}`}
              showTotals={false}
              rows={sortRows(items, sort)}
            />
          )}
        />
      );
    } else if (view === 'merchants') {
      body = (
        <ActivityMerchants
          transactions={transactions}
          scopeMemberId={scopeMemberId}
          month={period.month}
          monthLabel={monthShort(period.month)}
          now={now}
          // Its records for the month, with none of the filters Merchants
          // doesn't offer left on to hide them (the fresh review of 4a).
          onSelect={(name) =>
            update((prev) => {
              const next = withActivityFilter(withActivityFilter(withoutFilters(prev), 'search', name), 'view', null);
              next.delete('range');
              return next;
            })
          }
        />
      );
    } else {
      body = <ActivityTable {...table} rows={rows} />;
    }
  }

  return (
    <div className="mn-activity">
      {tools}
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
      {/* Merchants is the month's spending as a whole, so the filters, which
          it doesn't use, are not offered there. */}
      {transactions.length > 0 && view !== 'merchants' && (
        <ActivityFilters
          filters={filters}
          period={period}
          customDates={customDates}
          monthLabel={monthShort(period.month)}
          categories={categories}
          accounts={accounts}
          anyEstimated={anyEstimated}
          setFilter={setFilter}
          chooseDates={chooseDates}
          setRange={setRange}
          clearOne={clearOne}
          clearAll={clearAll}
        />
      )}
      {body}

      {editing && (
        <RecordEditor
          editing={editing}
          setEditing={setEditing}
          household={household}
          accounts={accounts}
          categories={categories}
          members={members}
          transactions={transactions}
          links={links}
          categoryRules={data.categoryRules ?? []}
          fxHistory={data.fxRateHistory}
          onSaved={async ({ notice: next = null } = {}) => {
            setNotice(next);
            await reload();
          }}
        />
      )}
    </div>
  );
}
