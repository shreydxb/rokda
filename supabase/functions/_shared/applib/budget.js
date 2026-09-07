// Synced copy of src/lib/budget.js (trimmed to what the Telegram assistant's
// tools need) -- see scope.js in this same directory for why.
import { scopedValue } from './scope.js';
import { isPosted, parseDay } from './day.js';
import { isSpendRow, spendDelta } from './transactionKind.js';

// Rows that count as this month's actuals: in the month, visible to the scope,
// and already posted — a record dated later this month is planned, not spent
// (QA-06). A refund counts here too (SHR-252): it must net against spend,
// which means being present in the same rollup as the expense it offsets,
// not silently excluded because its stored amount is positive.
function monthSpendRows(transactions, year, month, scopeMemberId, now) {
  return transactions.filter((t) => {
    const d = parseDay(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) return false;
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) return false;
    if (!isPosted(t, now)) return false;
    return isSpendRow(t, scopedValue(t.amount, t, scopeMemberId));
  });
}

// Actual spend by category for one calendar month, scope-applied.
export function monthActualsByCategory(transactions, year, month, scopeMemberId, now = new Date()) {
  const map = new Map();
  for (const t of monthSpendRows(transactions, year, month, scopeMemberId, now)) {
    if (!t.category_id) continue;
    map.set(t.category_id, (map.get(t.category_id) ?? 0) + spendDelta(t, scopedValue(t.amount, t, scopeMemberId)));
  }
  return map;
}
