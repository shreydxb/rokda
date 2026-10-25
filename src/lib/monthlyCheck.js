import { monthIncome, monthSpendBreakdown } from './budget';
import { liquidTotalAed, unvaluedLiquidAccounts } from './cashCover';

// Plan's monthly check (Planning audit, 2.11), made of checks the app already
// makes rather than a fourth: Review's saving against the budget's savings
// target, and the liquid cash Overview and the Telegram bot's cash-cover
// check count, as months of spending.

// A month's saving against its savings target in the budget: income less all
// spending, as Review checks it when the month is reviewed. Null when the
// budget sets no target for that month.
export function savingCheck({ year, month }, { transactions = [], budgets = [], categories = [] }, now = new Date()) {
  const savingsIds = new Set(categories.filter((c) => c.is_savings).map((c) => c.id));
  const target = budgets
    .filter((b) => Number(b.year) === year && Number(b.month) === month && savingsIds.has(b.category_id))
    .reduce((s, b) => s + Number(b.amount), 0);
  if (!(target > 0)) return null;
  const saved = monthIncome(transactions, year, month, null, now) - monthSpendBreakdown(transactions, [], year, month, null, now).total;
  return { target, saved, short: Math.max(0, target - saved) };
}

// The cash reserve: the open current, savings and cash accounts, as months of
// the plan's spending (`monthlySpend`, on its chosen basis), against the money
// the household keeps rather than spends (`keptCost`, its kept goals, like an
// emergency fund) as the target. Months are null without spending to divide
// by, and the target null without a kept goal. A liquid account with no AED
// value counts as nothing, and `unvalued` says how many there are.
export function cashReserve({ accounts = [], monthlySpend = null, keptCost = 0 }) {
  const liquid = liquidTotalAed(accounts);
  const perMonth = monthlySpend > 0 ? monthlySpend : null;
  return {
    liquid,
    unvalued: unvaluedLiquidAccounts(accounts).length,
    months: perMonth ? liquid / perMonth : null,
    target: keptCost > 0 ? keptCost : null,
    targetMonths: perMonth && keptCost > 0 ? keptCost / perMonth : null,
  };
}
