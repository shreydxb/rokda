import { scopedValue } from './scope';

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

// Actual spend/income by category for one calendar month, scope-applied.
export function monthActualsByCategory(transactions, year, month, scopeMemberId) {
  const map = new Map();
  for (const t of transactions) {
    const d = new Date(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) continue;
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (v >= 0) continue;
    const catId = t.category_id;
    if (!catId) continue;
    map.set(catId, (map.get(catId) ?? 0) + -v);
  }
  return map;
}

export function monthIncome(transactions, year, month, scopeMemberId) {
  let total = 0;
  for (const t of transactions) {
    const d = new Date(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) continue;
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (v > 0) total += v;
  }
  return total;
}
