import { monthKey } from './day';
import { monthIncome, monthSpendBreakdown } from './budget';
import { netWorthSummary } from '../screens/overviewMath';

// What a month's close puts into history (SHR-301). The review's "what to do
// next" actions lived here too, and left with it when Month end took its
// place (the revamp, phase 4d): their goal set-asides are on Overview's To
// do, their cash and saving lines on Planning -> Plan and Budget's savings
// target.

// What closing the month puts into history, shown before it is closed: the
// month's income, spending and saving, and the net worth a close records now
// against the last month closed. A close records today's balances, so the
// figure is today's. Once the month is closed, the net worth is the one it
// recorded (`closed`).
export function historyPreview({ year, month }, data = {}, now = new Date()) {
  const { transactions = [], accounts = [], holdings = [], netWorthSnapshots = [] } = data;
  const income = monthIncome(transactions, year, month, null, now);
  const spend = monthSpendBreakdown(transactions, [], year, month, null, now).total;
  const saved = income - spend;
  const thisKey = monthKey(new Date(year, month - 1, 1));
  const value = (s) => Number(s.assets) - Number(s.liabilities);
  const recorded = netWorthSnapshots.find((s) => monthKey(String(s.snapshot_date)) === thisKey);
  const previous = [...netWorthSnapshots]
    .filter((s) => monthKey(String(s.snapshot_date)) < thisKey)
    .sort((a, b) => String(b.snapshot_date).localeCompare(String(a.snapshot_date)))[0];
  const summary = recorded ? null : netWorthSummary(accounts, null, holdings);
  const netWorth = recorded ? value(recorded) : summary.netWorth;
  return {
    income,
    spend,
    saved,
    rate: income > 0 ? saved / income : null,
    closed: Boolean(recorded),
    netWorth,
    incomplete: summary ? summary.unvalued + summary.unpricedHoldings : 0,
    previous: previous ? { date: previous.snapshot_date, value: value(previous) } : null,
    change: previous ? netWorth - value(previous) : null,
  };
}
