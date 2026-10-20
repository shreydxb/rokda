import { monthKey, parseDay } from './day';
import { tabHref } from './activityLink';
import { upcomingItems } from './recurring';
import { scopedGoalRows } from './goals';
import { monthIncome, monthSpendBreakdown } from './budget';
import { budgetSummary } from './monthlyReview';
import { liquidAssets, netWorthSummary } from '../screens/overviewMath';

// After the checks: what a month says to do next, and what its close will put
// into history (SHR-301; docs/decisions.md, "The monthly review ends in what
// to do next").
//
// The checks in lib/monthlyReview.js make the month's records right. These
// turn the month into a few actions, most pressing first, each worked out
// from what is recorded and gone once it no longer applies:
//   1. bills due in the next 30 days that the money to hand won't cover;
//   2. goals behind the pace their date needs;
//   3. spending that went over its budget;
//   4. saving that fell short of its target.
// They cover the whole household, as the review does.

const fmt = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Math.abs(n)));
const dayLabel = (d) => parseDay(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function monthActions({ year, month }, data = {}, planning = {}, now = new Date()) {
  const { transactions = [], accounts = [], recurring = [], budgets = [], categories = [], holdings = [] } = data;
  const actions = [];

  // 1. The next 30 days: bills due, less pay expected, against current and
  // savings accounts. Only a shortfall is an action.
  const upcoming = upcomingItems(recurring, 30, now);
  const bills = upcoming.filter((r) => Number(r.amount) < 0);
  const billsTotal = bills.reduce((s, r) => s - Number(r.amount), 0);
  const payTotal = upcoming.filter((r) => Number(r.amount) > 0).reduce((s, r) => s + Number(r.amount), 0);
  const liquid = liquidAssets(accounts, null);
  const shortBy = billsTotal - payTotal - liquid;
  if (bills.length > 0 && shortBy > 0) {
    actions.push({
      id: 'liquidity',
      title: 'Cover the bills due in the next 30 days',
      detail: `AED ${fmt(billsTotal)} of bills fall due by ${dayLabel(bills[bills.length - 1].dueDate)}${payTotal > 0 ? `, with AED ${fmt(payTotal)} of pay expected` : ''}, and current and savings accounts hold AED ${fmt(liquid)}. That is AED ${fmt(shortBy)} short.`,
      href: tabHref('/money', 'recurring'),
      cta: 'See the bills',
    });
  }

  // 2. Goals behind the pace their date needs, the largest gap first.
  const inflationPct = planning.assumptions?.inflation_pct != null ? Number(planning.assumptions.inflation_pct) : undefined;
  const goalRows = scopedGoalRows({
    goals: planning.goals ?? [],
    contributions: planning.goalContributions ?? [],
    allocations: planning.goalAllocations ?? [],
    accounts,
    holdings,
    scopeMemberId: null,
    now,
    inflationPct,
  });
  goalRows
    .filter((r) => r.progress.status === 'behind' && r.need?.shortfall > 0)
    .sort((a, b) => b.need.shortfall - a.need.shortfall)
    .forEach((r) => {
      actions.push({
        id: `goal-${r.goal.id}`,
        title: `Fund ${r.goal.name}`,
        detail: `AED ${fmt(r.need.shortfall)} a month more than it is getting, AED ${fmt(r.need.perMonth)} a month in all, to reach it by ${r.need.byLabel}.`,
        href: tabHref('/planning', 'goals'),
        cta: 'Open Goals',
      });
    });

  // 3. Spending over its budget in the month: change the plan or the spending.
  const summary = budgetSummary({ year, month }, { transactions, budgets, categories }, now);
  if (summary.over.length > 0) {
    const named = summary.over.slice(0, 3).map((g) => `${g.name} by AED ${fmt(g.spent - g.budget)}`);
    actions.push({
      id: 'budget',
      title: 'Adjust the spending plan',
      detail: `Over budget: ${named.join(', ')}${summary.over.length > 3 ? `, and ${summary.over.length - 3} more` : ''}. Raise the budget where it was too low, or plan to spend less.`,
      href: tabHref('/money', 'budget'),
      cta: 'Open Budget',
    });
  }

  // 4. Saving against the month's savings target: income less all spending.
  const savingsIds = new Set(categories.filter((c) => c.is_savings).map((c) => c.id));
  const target = budgets.filter((b) => b.year === year && b.month === month && savingsIds.has(b.category_id)).reduce((s, b) => s + Number(b.amount), 0);
  if (target > 0) {
    const saved = monthIncome(transactions, year, month, null, now) - monthSpendBreakdown(transactions, [], year, month, null, now).total;
    if (saved < target) {
      actions.push({
        id: 'saving',
        title: 'Catch up on saving',
        detail: `Saved AED ${saved < 0 ? `−${fmt(saved)}` : fmt(saved)} against a target of AED ${fmt(target)}: AED ${fmt(target - saved)} short.`,
        href: tabHref('/money', 'budget'),
        cta: 'Open Budget',
      });
    }
  }

  return actions;
}

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
