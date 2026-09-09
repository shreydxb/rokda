import { scopedValue } from './scope';
import { monthActualsByCategory } from './budget';
import { isPosted, parseDay } from './day';
import { isSpendRow, spendDelta } from './transactionKind';

// Average of a category's actual spend over the `monthsBack` calendar
// months strictly before (year, month) that have at least one transaction
// in the household at all (so a brand-new household with 1 month of
// history doesn't get diluted by phantom zero months).
export function trailingAverageByCategory(transactions, year, month, monthsBack, scopeMemberId) {
  const totals = new Map();
  let monthsWithData = 0;
  for (let i = 1; i <= monthsBack; i++) {
    const d = new Date(year, month - 1 - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const hasAny = transactions.some((t) => {
      const td = parseDay(t.occurred_at);
      return td.getFullYear() === y && td.getMonth() + 1 === m;
    });
    if (!hasAny) continue;
    monthsWithData++;
    const catTotals = monthActualsByCategory(transactions, y, m, scopeMemberId);
    for (const [catId, amt] of catTotals) {
      totals.set(catId, (totals.get(catId) ?? 0) + amt);
    }
  }
  const averages = new Map();
  if (monthsWithData > 0) {
    for (const [catId, sum] of totals) averages.set(catId, sum / monthsWithData);
  }
  return { averages, monthsWithData };
}

function categoryRowsThisMonth(transactions, categoryId, year, month, scopeMemberId, now) {
  return transactions.filter((t) => {
    if (t.category_id !== categoryId) return false;
    const d = parseDay(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) return false;
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) return false;
    if (!isPosted(t, now)) return false;
    return isSpendRow(t, scopedValue(t.amount, t, scopeMemberId));
  });
}

// Categories whose spend moved meaningfully vs their own trailing average
// this month -- "meaningfully" means both at least minPct off average AND
// at least minAbsolute of real money, so a category with a tiny average
// (a few AED) doesn't get flagged purely because a single normal purchase
// looks like a huge percentage move. Evidence is the transaction(s) that
// did the most to produce the move, largest first, capped to a couple.
export function notableMoves(
  transactions,
  year,
  month,
  scopeMemberId,
  catById,
  now = new Date(),
  { monthsBack = 6, minAbsolute = 50, minPct = 0.2, limit = 4, evidenceCount = 2 } = {}
) {
  const thisMonth = monthActualsByCategory(transactions, year, month, scopeMemberId, now);
  const { averages, monthsWithData } = trailingAverageByCategory(transactions, year, month, monthsBack, scopeMemberId);
  if (monthsWithData === 0) return [];

  const moves = [];
  for (const [categoryId, actual] of thisMonth) {
    const avg = averages.get(categoryId);
    if (!avg || avg <= 0) continue;
    const delta = actual - avg;
    const pct = delta / avg;
    if (Math.abs(delta) < minAbsolute || Math.abs(pct) < minPct) continue;
    moves.push({ categoryId, categoryName: catById.get(categoryId)?.name ?? 'Uncategorised', actual, avg, delta, pct });
  }
  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return moves.slice(0, limit).map((m) => {
    const rows = categoryRowsThisMonth(transactions, m.categoryId, year, month, scopeMemberId, now)
      .map((t) => ({ merchant: t.merchant?.trim() || 'Unknown', amount: spendDelta(t, scopedValue(t.amount, t, scopeMemberId)), occurred_at: t.occurred_at }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, evidenceCount);
    return { ...m, evidence: rows };
  });
}

export function topMerchants(transactions, scopeMemberId, { limit = 8 } = {}) {
  const byMerchant = new Map();
  for (const t of transactions) {
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) continue;
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (v >= 0) continue;
    const name = t.merchant?.trim() || 'Unknown';
    const row = byMerchant.get(name) ?? { total: 0, count: 0 };
    row.total += -v;
    row.count += 1;
    byMerchant.set(name, row);
  }
  return [...byMerchant.entries()]
    .map(([name, row]) => ({ name, ...row }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}
