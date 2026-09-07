// One shared meaning for "what does this amount do to income and spend"
// (SHR-252 762a6c4 recheck). overviewMath, budget and forecast each had their
// own copy of the income/spend split, so refund handling landed in one and
// silently missed the others: Overview agreed that expense 100 + refund 100
// nets to spend 0/income 0, while Budget and Forecast still read the refund
// as 100 of income. Every consumer of a transaction's amount routes through
// this so there is exactly one place that decides what a refund does.

// A refund is stored positive, like income, but means the opposite: money
// coming back on an earlier expense. It must net against spend rather than
// inflate income.
export function isSpendRow(t, v) {
  return v < 0 || t?.kind === 'refund';
}

export function isIncomeRow(t, v) {
  return v >= 0 && t?.kind !== 'refund';
}

// The signed delta a row contributes to a running spend total: positive for
// an expense's magnitude, negative for a refund (since v is itself positive
// there), zero for income.
export function spendDelta(t, v) {
  if (t?.kind === 'refund') return -v;
  return v < 0 ? -v : 0;
}

export function incomeSpendOf(t, v) {
  if (isIncomeRow(t, v)) return { income: v, spend: 0 };
  return { income: 0, spend: spendDelta(t, v) };
}

export function applyToIncomeSpend(t, v, totals) {
  const delta = incomeSpendOf(t, v);
  totals.income += delta.income;
  totals.spend += delta.spend;
}
