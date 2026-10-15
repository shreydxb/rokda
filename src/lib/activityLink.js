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
  };
}

const PARAM_OF = { categoryId: 'cat', search: 'q', needsReview: 'review', dateBasis: 'dates', from: 'from', to: 'to', view: 'view' };
const DEFAULTS = { categoryId: 'all', search: '', needsReview: false, dateBasis: 'posted', from: null, to: null, view: 'list' };

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

// The address of Activity showing just these records.
export function activityHref({ categoryId, search, from, to, dateBasis } = {}) {
  let params = new URLSearchParams({ tab: 'activity' });
  params = withActivityFilter(params, 'categoryId', categoryId);
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
