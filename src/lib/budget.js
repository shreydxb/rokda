import { scopedValue } from './scope';
import { isPosted, parseDay } from './day';

export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

export function monthPace(year, month, now = new Date()) {
  const total = daysInMonth(year, month);
  const monthStart = new Date(year, month - 1, 1);
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const isCurrentMonth = monthStart.getTime() === thisMonthStart.getTime();
  const isPast = monthStart < thisMonthStart;
  const elapsedDays = isCurrentMonth ? now.getDate() : isPast ? total : 0;
  return {
    elapsedDays,
    totalDays: total,
    elapsedFraction: elapsedDays / total,
    isCurrentMonth,
    isPast,
    isFuture: !isCurrentMonth && !isPast,
    // Early in the month, spend-to-date is dominated by whichever lump-sum
    // bill happened to post first (rent, say), so linear extrapolation
    // reads as a wild, misleading multiple of the budget rather than a
    // real pace signal — a 10%-elapsed month still produces a ~10x
    // multiplier off a single early payment. Withhold the projection until
    // at least a third of the month is behind it.
    canProject: isCurrentMonth && elapsedDays / total >= 1 / 3,
  };
}

export function projectedClose(actual, elapsedFraction) {
  if (elapsedFraction <= 0) return null;
  return actual / elapsedFraction;
}

// Rows that count as this month's actuals: in the month, visible to the scope,
// and already posted — a record dated later this month is planned, not spent
// (QA-06).
function monthSpendRows(transactions, year, month, scopeMemberId, now) {
  return transactions.filter((t) => {
    const d = parseDay(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) return false;
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) return false;
    if (!isPosted(t, now)) return false;
    return scopedValue(t.amount, t, scopeMemberId) < 0;
  });
}

// Actual spend by category for one calendar month, scope-applied. Uncategorised
// spend has no category to key on, so it is absent here by construction — see
// monthSpendBreakdown for the total that includes it.
export function monthActualsByCategory(transactions, year, month, scopeMemberId, now = new Date()) {
  const map = new Map();
  for (const t of monthSpendRows(transactions, year, month, scopeMemberId, now)) {
    if (!t.category_id) continue;
    map.set(t.category_id, (map.get(t.category_id) ?? 0) + -scopedValue(t.amount, t, scopeMemberId));
  }
  return map;
}

// All spending in the month, split by whether it was budgeted (QA-09).
//
// "Net saved" used to be income minus the *budgeted categories'* spend, so
// spending in an unbudgeted category, or with no category at all, simply
// vanished from the figure. A subtotal is not a total, and the two are now
// named separately.
export function monthSpendBreakdown(transactions, budgetedCategoryIds, year, month, scopeMemberId, now = new Date()) {
  const budgetedIds = new Set(budgetedCategoryIds ?? []);
  let budgeted = 0;
  let unbudgeted = 0;
  let uncategorised = 0;
  for (const t of monthSpendRows(transactions, year, month, scopeMemberId, now)) {
    const amount = -scopedValue(t.amount, t, scopeMemberId);
    if (!t.category_id) uncategorised += amount;
    else if (budgetedIds.has(t.category_id)) budgeted += amount;
    else unbudgeted += amount;
  }
  return { budgeted, unbudgeted, uncategorised, total: budgeted + unbudgeted + uncategorised };
}

// Income minus ALL spending in the month, not just budgeted spending.
export function monthNetSaved(transactions, budgetedCategoryIds, year, month, scopeMemberId, now = new Date()) {
  const income = monthIncome(transactions, year, month, scopeMemberId, now);
  const { total } = monthSpendBreakdown(transactions, budgetedCategoryIds, year, month, scopeMemberId, now);
  return income - total;
}

export function monthIncome(transactions, year, month, scopeMemberId, now = new Date()) {
  let total = 0;
  for (const t of transactions) {
    const d = parseDay(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) continue;
    if (!isPosted(t, now)) continue;
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (v > 0) total += v;
  }
  return total;
}
