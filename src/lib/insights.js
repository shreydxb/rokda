import { scopedValue } from './scope';
import { monthActualsByCategory } from './budget';

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
      const td = new Date(t.occurred_at);
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
