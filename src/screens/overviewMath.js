import { scopedValue } from '../lib/scope';
import { accountValueAed, isAccountValued, isBalanceConfirmed, isArchived } from '../lib/accounts';
import { clampToToday, daysBetweenDays, endOfDayExclusive, isPosted, monthKey, parseDay, startOfDay } from '../lib/day';
import { chartBuckets, periodBounds } from '../lib/period';
import { scopedHoldingValue, visibleHoldings } from '../lib/holdings';
import { applyToIncomeSpend, isSpendRow } from '../lib/transactionKind';

const LIABILITY_TYPES = new Set(['credit_card', 'loan']);
const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);

function visibleToScope(row, scopeMemberId) {
  if (scopeMemberId === null) return true;
  return row.is_shared || row.owner_member_id === scopeMemberId;
}

// Closed accounts are excluded from every current-position figure: they are
// not part of what the household holds today. Their transactions are separate
// rows and stay in history untouched (QA-01).
export function visibleAccounts(accounts, scopeMemberId) {
  return accounts.filter((a) => !isArchived(a) && visibleToScope(a, scopeMemberId));
}

export function netWorthSummary(accounts, scopeMemberId, holdings = []) {
  let assets = 0;
  let liabilities = 0;
  // Accounts whose AED value is unknown -- a foreign balance nobody has
  // converted. They are counted, not silently dropped, so a caller can say the
  // total is incomplete instead of presenting it as the whole picture.
  let unvalued = 0;
  for (const a of visibleAccounts(accounts, scopeMemberId)) {
    const aed = accountValueAed(a);
    if (aed === null) {
      unvalued += 1;
      continue;
    }
    const v = scopedValue(aed, a, scopeMemberId);
    if (LIABILITY_TYPES.has(a.type)) liabilities += v;
    else assets += v;
  }
  for (const h of visibleHoldings(holdings, scopeMemberId)) {
    assets += scopedHoldingValue(h, scopeMemberId);
  }
  return { assets, liabilities, netWorth: assets - liabilities, unvalued };
}

// The one starting basis shared by Overview, Wealth and Forecast: open account
// balances plus holdings, household-wide. Returns null — never zero — when
// there is nothing valued to start from, so a forecast refuses to project from
// a number the app invented (QA-03).
export function startingNetWorth(accounts = [], holdings = []) {
  // "Nothing valued to start from" used to mean "no rows at all", so an
  // account that existed but whose balance nobody had confirmed returned 0 --
  // precisely the invented number the comment above forbids, and enough to
  // make a forecast look ready (QA pass 3, O4). An account counts only if its
  // AED value is known AND somebody (or the FD trigger) has vouched for it.
  const valuedAccounts = visibleAccounts(accounts, null).filter((a) => isAccountValued(a) && isBalanceConfirmed(a));
  const hasHoldings = visibleHoldings(holdings, null).length > 0;
  if (valuedAccounts.length === 0 && !hasHoldings) return null;
  return netWorthSummary(accounts, null, holdings).netWorth;
}

export function liquidAssets(accounts, scopeMemberId) {
  return visibleAccounts(accounts, scopeMemberId)
    .filter((a) => LIQUID_TYPES.has(a.type))
    .reduce((sum, a) => sum + scopedValue(accountValueAed(a) ?? 0, a, scopeMemberId), 0);
}

// Half-open [start, end) over local calendar days, so a boundary belongs to
// exactly one window (QA-06).
function txInRange(transactions, start, end, scopeMemberId) {
  return transactions.filter((t) => {
    if (!visibleToScope(t, scopeMemberId)) return false;
    const d = parseDay(t.occurred_at);
    return d >= start && d < end;
  });
}

export function periodSummary(transactions, kind, scopeMemberId, now = new Date()) {
  const { start, end } = periodBounds(kind, now);
  // Up to and including today. The old bound added 24 hours to the current
  // *timestamp*, so a record dated tomorrow counted as spend today (QA-06).
  const rows = txInRange(transactions, start, endOfDayExclusive(end), scopeMemberId);
  const totals = { income: 0, spend: 0 };
  for (const t of rows) {
    applyToIncomeSpend(t, scopedValue(t.amount, t, scopeMemberId), totals);
  }
  const { income, spend } = totals;
  const saved = income - spend;
  const rate = income > 0 ? saved / income : null;
  return { start, end, income, spend, saved, rate, count: rows.length };
}

export function buildChartColumns(transactions, kind, scopeMemberId, now = new Date()) {
  return chartBuckets(kind, now).map((bucket) => {
    // The still-running bucket stops at today; it must not reach into the
    // future and count planned records as actuals (QA-06).
    const rows = txInRange(transactions, bucket.start, clampToToday(bucket.end, now), scopeMemberId);
    const totals = { income: 0, spend: 0 };
    for (const t of rows) {
      applyToIncomeSpend(t, scopedValue(t.amount, t, scopeMemberId), totals);
    }
    const { income, spend } = totals;
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
  const currentMonth = monthKey(now);
  for (const t of transactions) {
    if (!visibleToScope(t, scopeMemberId)) continue;
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (!isSpendRow(t, v)) continue;
    const key = monthKey(parseDay(t.occurred_at));
    // The current month is partial, and anything after it is planned, not
    // spent. Both are excluded from a completed-month average.
    if (key >= currentMonth) continue;
    // A refund's v is positive, so -v is negative here and reduces that
    // month's spend rather than being ignored — the same netting
    // periodSummary applies (SHR-252).
    monthly.set(key, (monthly.get(key) ?? 0) + -v);
  }
  // Newest six *by month*, not by arrival order. Transactions come back
  // newest-first from the API, so taking the last six entries of insertion
  // order kept the six oldest months (QA-06).
  const series = [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, total]) => total).slice(-6);
  if (series.length < 2) return { available: false, monthsOfHistory: series.length };
  const avgMonthlySpend = series.reduce((a, b) => a + b, 0) / series.length;
  const liquid = liquidAssets(accounts, scopeMemberId);
  const months = avgMonthlySpend > 0 ? liquid / avgMonthlySpend : null;
  return { available: months !== null, months, avgMonthlySpend, monthsOfHistory: series.length };
}

export function dataQuality(accounts, transactions, now = new Date()) {
  // "Last recorded" means the newest *posted* record. Counting a future-dated
  // one produced the live Overview's "Transactions −1d ago" (QA-06).
  const posted = transactions.filter((t) => isPosted(t, now));
  const planned = transactions.length - posted.length;
  const lastTxDate = posted.length
    ? new Date(Math.max(...posted.map((t) => parseDay(t.occurred_at).getTime())))
    : null;
  const daysSinceLastTx = lastTxDate ? daysBetweenDays(lastTxDate, startOfDay(now)) : null;

  const lastAccountUpdate = accounts.length
    ? new Date(Math.max(...accounts.map((a) => new Date(a.updated_at ?? a.created_at).getTime())))
    : null;

  const categorised = transactions.filter((t) => t.category_id).length;
  const categorisedPct = transactions.length ? categorised / transactions.length : null;

  const openReview = transactions.filter((t) => t.needs_review).length;

  return { lastTxDate, daysSinceLastTx, lastAccountUpdate, categorisedPct, openReview, totalTx: transactions.length, plannedTx: planned };
}
