import { scopedValue } from '../lib/scope';
import { chartBuckets, periodBounds } from '../lib/period';
import { scopedHoldingValue, visibleHoldings } from '../lib/holdings';

const LIABILITY_TYPES = new Set(['credit_card', 'loan']);
const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);

function visibleToScope(row, scopeMemberId) {
  if (scopeMemberId === null) return true;
  return row.is_shared || row.owner_member_id === scopeMemberId;
}

export function visibleAccounts(accounts, scopeMemberId) {
  return accounts.filter((a) => visibleToScope(a, scopeMemberId));
}

export function netWorthSummary(accounts, scopeMemberId, holdings = []) {
  let assets = 0;
  let liabilities = 0;
  for (const a of visibleAccounts(accounts, scopeMemberId)) {
    const v = scopedValue(a.balance, a, scopeMemberId);
    if (LIABILITY_TYPES.has(a.type)) liabilities += v;
    else assets += v;
  }
  for (const h of visibleHoldings(holdings, scopeMemberId)) {
    assets += scopedHoldingValue(h, scopeMemberId);
  }
  return { assets, liabilities, netWorth: assets - liabilities };
}

export function liquidAssets(accounts, scopeMemberId) {
  return visibleAccounts(accounts, scopeMemberId)
    .filter((a) => LIQUID_TYPES.has(a.type))
    .reduce((sum, a) => sum + scopedValue(a.balance, a, scopeMemberId), 0);
}

function txInRange(transactions, start, end, scopeMemberId) {
  return transactions.filter((t) => {
    if (!visibleToScope(t, scopeMemberId)) return false;
    const d = new Date(t.occurred_at);
    return d >= start && d < end;
  });
}

export function periodSummary(transactions, kind, scopeMemberId, now = new Date()) {
  const { start, end } = periodBounds(kind, now);
  const rows = txInRange(transactions, start, new Date(end.getTime() + 24 * 60 * 60 * 1000), scopeMemberId);
  let income = 0;
  let spend = 0;
  for (const t of rows) {
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (v >= 0) income += v;
    else spend += -v;
  }
  const saved = income - spend;
  const rate = income > 0 ? saved / income : null;
  return { start, end, income, spend, saved, rate, count: rows.length };
}

export function buildChartColumns(transactions, kind, scopeMemberId, now = new Date()) {
  return chartBuckets(kind, now).map((bucket) => {
    const rows = txInRange(transactions, bucket.start, bucket.end, scopeMemberId);
    let income = 0;
    let spend = 0;
    for (const t of rows) {
      const v = scopedValue(t.amount, t, scopeMemberId);
      if (v >= 0) income += v;
      else spend += -v;
    }
    const saved = income - spend;
    const rate = income > 0 ? saved / income : 0;
    return { ...bucket, income, spend, saved, rate, hasData: rows.length > 0 };
  });
}

export function spendComposition(periodTx, scopeMemberId, { topN = 5 } = {}) {
  const byCategory = new Map();
  for (const t of periodTx) {
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (v >= 0) continue;
    const name = t.categories?.name ?? 'Uncategorised';
    byCategory.set(name, (byCategory.get(name) ?? 0) + -v);
  }
  const sorted = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, v]) => sum + v, 0);
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  const restTotal = rest.reduce((sum, [, v]) => sum + v, 0);
  const rows = top.map(([name, value]) => ({ name, value, share: total > 0 ? value / total : 0 }));
  if (rest.length > 0) {
    rows.push({ name: 'Everything else', value: restTotal, share: total > 0 ? restTotal / total : 0, count: rest.length });
  }
  return { rows, total };
}

// Runway needs at least two *completed* calendar months of spend history —
// the current, still-open month is excluded so a half-empty month doesn't
// skew the average.
export function runwaySummary(transactions, accounts, scopeMemberId, now = new Date()) {
  const monthly = new Map();
  for (const t of transactions) {
    if (!visibleToScope(t, scopeMemberId)) continue;
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (v >= 0) continue;
    const d = new Date(t.occurred_at);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    monthly.set(key, (monthly.get(key) ?? 0) + -v);
  }
  const series = [...monthly.values()].slice(-6);
  if (series.length < 2) return { available: false, monthsOfHistory: series.length };
  const avgMonthlySpend = series.reduce((a, b) => a + b, 0) / series.length;
  const liquid = liquidAssets(accounts, scopeMemberId);
  const months = avgMonthlySpend > 0 ? liquid / avgMonthlySpend : null;
  return { available: months !== null, months, avgMonthlySpend, monthsOfHistory: series.length };
}

export function dataQuality(accounts, transactions, now = new Date()) {
  const lastTxDate = transactions.length
    ? new Date(Math.max(...transactions.map((t) => new Date(t.occurred_at).getTime())))
    : null;
  const daysSinceLastTx = lastTxDate ? Math.floor((now - lastTxDate) / 86400000) : null;

  const lastAccountUpdate = accounts.length
    ? new Date(Math.max(...accounts.map((a) => new Date(a.updated_at ?? a.created_at).getTime())))
    : null;

  const categorised = transactions.filter((t) => t.category_id).length;
  const categorisedPct = transactions.length ? categorised / transactions.length : null;

  const openReview = transactions.filter((t) => t.needs_review).length;

  return { lastTxDate, daysSinceLastTx, lastAccountUpdate, categorisedPct, openReview, totalTx: transactions.length };
}
