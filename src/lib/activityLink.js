import { parseDay } from './day';
import { monthFromParam, monthParam } from './useMonthParam';

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
const VIEWS = new Set(['calendar', 'merchants']);
const SORTS = new Set(['newest', 'oldest', 'largest', 'smallest']);
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
    estimated: params.get('est') === '1',
    dateBasis: BASES.has(dates) ? dates : 'posted',
    from: from && DATE.test(from) ? from : null,
    to: to && DATE.test(to) ? to : null,
    view: VIEWS.has(params.get('view')) ? params.get('view') : 'list',
    accountId: params.get('acct') || 'all',
    kind: KINDS.has(params.get('kind')) ? params.get('kind') : 'all',
    sort: SORTS.has(params.get('sort')) ? params.get('sort') : 'newest',
  };
}

const PARAM_OF = { categoryId: 'cat', search: 'q', needsReview: 'review', estimated: 'est', dateBasis: 'dates', from: 'from', to: 'to', view: 'view', accountId: 'acct', kind: 'kind', sort: 'sort' };
const DEFAULTS = { categoryId: 'all', search: '', needsReview: false, estimated: false, dateBasis: 'posted', from: null, to: null, view: 'list', accountId: 'all', kind: 'all', sort: 'newest' };

// Every narrowing filter back to its default, keeping the tab, the view and
// the sort.
export function withoutFilters(params) {
  let next = new URLSearchParams(params);
  for (const key of ['categoryId', 'search', 'needsReview', 'estimated', 'dateBasis', 'from', 'to', 'accountId', 'kind']) next = withActivityFilter(next, key, null);
  return next;
}

// Which dates Activity shows (the revamp, phase 4; design/prototype): a month
// by default, the one in the address (`month`, shared with Budget) or this
// one; every date on `range=all`; and a link's own range as it is. A range
// that is one whole month is that month, so a link from Budget or Overview
// lands with the stepper on it. `month` is the first of the month the stepper
// shows: a custom range shows the month it starts in.
export function activityPeriod(params, now = new Date()) {
  const filters = readActivityFilters(params);
  const current = new Date(now.getFullYear(), now.getMonth(), 1);
  const named = monthFromParam(params.get('month')) ?? current;
  if (filters.from || filters.to) {
    const start = parseDay(filters.from ?? filters.to);
    const month = new Date(start.getFullYear(), start.getMonth(), 1);
    const whole = monthRange(month.getFullYear(), month.getMonth() + 1);
    if (whole.from === filters.from && whole.to === filters.to) return { mode: 'month', month, ...whole };
    return { mode: 'custom', month, from: filters.from, to: filters.to };
  }
  if (params.get('range') === 'all') return { mode: 'all', month: named, from: null, to: null };
  return { mode: 'month', month: named, ...monthRange(named.getFullYear(), named.getMonth() + 1) };
}

// The month Money's tabs share, as `month` would write it: the one in the
// address, or a link's range when that is one whole month (the fresh review
// of 4a: Budget opened from a link into Activity showed this month). Null for
// this month, which the address leaves out, and for any other range.
export function sharedMonth(params, now = new Date()) {
  const filters = readActivityFilters(params);
  let month = null;
  if (filters.from || filters.to) {
    const period = activityPeriod(params, now);
    if (period.mode === 'month') month = monthParam(period.month);
  } else if (monthFromParam(params.get('month'))) month = params.get('month');
  return month && month !== monthParam(now) ? month : null;
}

// The address showing one month: any range and All dates go, and this month
// is left out (lib/useMonthParam.js).
export function withActivityMonth(params, month, now = new Date()) {
  const next = new URLSearchParams(params);
  for (const name of ['from', 'to', 'range', 'month']) next.delete(name);
  if (monthParam(month) !== monthParam(now)) next.set('month', monthParam(month));
  return next;
}

// The address showing every date. The month stays, for the stepper to step
// from.
export function withAllDates(params) {
  const next = new URLSearchParams(params);
  next.delete('from');
  next.delete('to');
  next.set('range', 'all');
  return next;
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

// The address of one account's drawer on Wealth (screens/wealth/
// AccountDrawer.jsx): a card opens on its cycle; `view` opens 'statements' or
// 'details'. `who` as for activityHref.
export function accountHref(accountId, { view, who } = {}) {
  const params = new URLSearchParams({ account: accountId });
  if (view) params.set('view', view);
  if (who) params.set('who', who);
  return `/wealth?${params}`;
}

// The address of one tab of a screen (lib/useTab.js reads it), with any
// other parameters it takes.
export function tabHref(path, tab, extra = {}) {
  if (!tab) return path;
  const params = new URLSearchParams({ tab, ...extra });
  return `${path}?${params}`;
}

// The category filter's value for records with no category (a transfer has
// none to give, and a split record's are in its lines, so neither is one).
export const UNCATEGORISED = 'none';

// The address of Activity showing just these records.
// `who` chooses the person the records are counted for (lib/ScopeContext.jsx):
// a household-wide view's links pass 'both'. `allDates` shows every date
// rather than this month (a card's records, from its view on Net worth).
export function activityHref({ categoryId, search, from, to, dateBasis, needsReview, estimated, kind, accountId, allDates = false, who } = {}) {
  let params = new URLSearchParams({ tab: 'activity' });
  if (who) params.set('who', who);
  params = withActivityFilter(params, 'estimated', estimated);
  params = withActivityFilter(params, 'kind', kind);
  params = withActivityFilter(params, 'categoryId', categoryId);
  params = withActivityFilter(params, 'needsReview', needsReview);
  params = withActivityFilter(params, 'search', search);
  params = withActivityFilter(params, 'from', from);
  params = withActivityFilter(params, 'to', to);
  params = withActivityFilter(params, 'dateBasis', dateBasis);
  params = withActivityFilter(params, 'accountId', accountId);
  if (allDates) params = withAllDates(params);
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
