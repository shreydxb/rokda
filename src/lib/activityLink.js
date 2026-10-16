import { parseDay } from './day';

// Where a summary sends you to see its records, and what Activity reads back
// out of the address. The filters live in the URL rather than in screen state
// so that a drill-in keeps its month, category or merchant, and so Back,
// reload and a bookmarked view all land on the same list (product review, 15
// October: Insights opened all-time records for a monthly figure, and every
// Overview link opened Money's first tab). The person and the display currency
// are not here: they are the sidebar's, and already apply everywhere.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASES = new Set(['posted', 'scheduled', 'all']);
const KINDS = new Set(['expense', 'income', 'refund', 'transfer']);
const SORTS = new Set(['newest', 'oldest', 'largest']);
const pad = (n) => String(n).padStart(2, '0');

export function isoDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A month (1-12) as an inclusive date range.
export function monthRange(year, month) {
  return { from: `${year}-${pad(month)}-01`, to: isoDay(new Date(year, month, 0)) };
}

// Activity's filters from the address, each falling back to its default when
// absent or malformed, so a hand-edited URL can't put the list in a state its
// controls can't show.
export function readActivityFilters(params) {
  const from = params.get('from');
  const to = params.get('to');
  const dates = params.get('dates');
  return {
    categoryId: params.get('cat') || 'all',
    search: params.get('q') ?? '',
    needsReview: params.get('review') === '1',
    dateBasis: BASES.has(dates) ? dates : 'posted',
    from: from && DATE.test(from) ? from : null,
    to: to && DATE.test(to) ? to : null,
    view: params.get('view') === 'calendar' ? 'calendar' : 'list',
    accountId: params.get('acct') || 'all',
    kind: KINDS.has(params.get('kind')) ? params.get('kind') : 'all',
    sort: SORTS.has(params.get('sort')) ? params.get('sort') : 'newest',
  };
}

const PARAM_OF = { categoryId: 'cat', search: 'q', needsReview: 'review', dateBasis: 'dates', from: 'from', to: 'to', view: 'view', accountId: 'acct', kind: 'kind', sort: 'sort' };
const DEFAULTS = { categoryId: 'all', search: '', needsReview: false, dateBasis: 'posted', from: null, to: null, view: 'list', accountId: 'all', kind: 'all', sort: 'newest' };

// How many of the filters that narrow the list are set (not the view or the
// sort, which only arrange it), for "Filters (2)" and "Clear filters".
export function activeFilterCount(filters) {
  const narrowing = ['categoryId', 'search', 'needsReview', 'dateBasis', 'accountId', 'kind'];
  return narrowing.filter((key) => filters[key] !== DEFAULTS[key]).length + (filters.from || filters.to ? 1 : 0);
}

// Every narrowing filter back to its default, keeping the tab, the view and
// the sort.
export function withoutFilters(params) {
  let next = new URLSearchParams(params);
  for (const key of ['categoryId', 'search', 'needsReview', 'dateBasis', 'from', 'to', 'accountId', 'kind']) next = withActivityFilter(next, key, null);
  return next;
}

// The date select's choices, worked out from today. Each is an inclusive
// range; "All dates" has neither end.
export function datePresets(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const last = new Date(y, m - 2, 1);
  const ninety = new Date(y, now.getMonth(), now.getDate() - 89);
  return [
    { id: 'all', label: 'All dates', from: null, to: null },
    { id: 'this-month', label: 'This month', ...monthRange(y, m) },
    { id: 'last-month', label: 'Last month', ...monthRange(last.getFullYear(), last.getMonth() + 1) },
    { id: '90-days', label: 'Last 90 days', from: isoDay(ninety), to: isoDay(now) },
    { id: 'this-year', label: 'This year', from: `${y}-01-01`, to: `${y}-12-31` },
  ];
}

// Which preset the current range is, if any.
export function presetFor(from, to, now = new Date()) {
  return datePresets(now).find((p) => p.from === (from ?? null) && p.to === (to ?? null))?.id ?? null;
}

// New search params with one filter changed. A filter at its default is left
// out of the address rather than written as e.g. `cat=all`.
export function withActivityFilter(params, key, value) {
  const next = new URLSearchParams(params);
  const name = PARAM_OF[key];
  if (value === DEFAULTS[key] || value === null || value === undefined || value === '') next.delete(name);
  else next.set(name, value === true ? '1' : String(value));
  return next;
}

// The address of one tab of a screen (lib/useTab.js reads it).
export function tabHref(path, tab) {
  return tab ? `${path}?tab=${encodeURIComponent(tab)}` : path;
}

// The category filter's value for records with no category (a transfer has
// none to give, and a split record's are in its lines, so neither is one).
export const UNCATEGORISED = 'none';

// The address of Activity showing just these records.
export function activityHref({ categoryId, search, from, to, dateBasis, needsReview } = {}) {
  let params = new URLSearchParams({ tab: 'activity' });
  params = withActivityFilter(params, 'categoryId', categoryId);
  params = withActivityFilter(params, 'needsReview', needsReview);
  params = withActivityFilter(params, 'search', search);
  params = withActivityFilter(params, 'from', from);
  params = withActivityFilter(params, 'to', to);
  params = withActivityFilter(params, 'dateBasis', dateBasis);
  return `/money?${params}`;
}

// Whether a record's day falls inside an inclusive range; either end may be
// open.
export function inDateRange(row, from, to) {
  const day = parseDay(row.occurred_at);
  if (from && day < parseDay(from)) return false;
  if (to && day > parseDay(to)) return false;
  return true;
}

// A chart bucket (start inclusive, end exclusive) as an inclusive range,
// stopping at today for the bucket still running.
export function bucketRange({ start, end }, now = new Date()) {
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: isoDay(start), to: isoDay(last < today ? last : today) };
}

// "September 2026" for a whole month, otherwise the two ends.
export function dateRangeLabel(from, to) {
  const fmt = (d, withYear) => parseDay(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  if (from && to) {
    const start = parseDay(from);
    const whole = monthRange(start.getFullYear(), start.getMonth() + 1);
    if (whole.from === from && whole.to === to) return start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const sameYear = start.getFullYear() === parseDay(to).getFullYear();
    return `${fmt(from, !sameYear)} – ${fmt(to, true)}`;
  }
  if (from) return `From ${fmt(from, true)}`;
  if (to) return `Up to ${fmt(to, true)}`;
  return null;
}

// A category and everything filed under it, so a group (Transport) shows its
// subcategories' records too, as Budget rolls them up.
export function categoryAndChildren(categoryId, categories) {
  const ids = new Set([categoryId]);
  for (const c of categories) if (c.parent_id === categoryId) ids.add(c.id);
  return ids;
}
