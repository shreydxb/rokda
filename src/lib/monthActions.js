import { monthKey, parseDay } from './day';
import { tabHref } from './activityLink';
import { upcomingItems } from './recurring';
import { goalStatuses } from './goals';
import { assumption } from './planningDefaults';
import { monthIncome, monthSpendBreakdown } from './budget';
import { budgetSummary } from './monthlyReview';
import { liquidAssets, netWorthSummary } from '../screens/overviewMath';
import { formatMoney } from './money';
import { savingCheck } from './monthlyCheck';

// After the checks: what a month says to do next, and what its close will put
// into history (SHR-301; docs/decisions.md, "The monthly review ends in what
// to do next").
//
// The checks in lib/monthlyReview.js make the month's records right. These
// turn the month into a few actions, most pressing first, each worked out
// from what is recorded and gone once it no longer applies:
//   1. bills due in the next 30 days that the money to hand won't cover;
//   2. goals due within 3 years, or kept money, still short of cash;
//   3. spending that went over its budget;
//   4. saving that fell short of its target.
// They cover the whole household, as the review does.
//
// The goal action is Goals' own rule (lib/goals.js, goalStatuses; Planning
// audit, 1.5). It used to measure a goal by what was logged to it in the last
// 90 days, so a goal fed through a linked account, or one with no date, read
// as behind while Goals called it covered.

// A whole amount, unsigned: the shared formatter, made once (lib/money.js).
const fmt = (n) => formatMoney(Math.round(Math.abs(n)));
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

  // 2. Goals paid from cash and still short of it: what to set aside, the
  // largest monthly figure first, a goal already due before them.
  goalStatuses({
    goals: planning.goals ?? [],
    contributions: planning.goalContributions ?? [],
    allocations: planning.goalAllocations ?? [],
    accounts,
    holdings,
    scopeMemberId: null,
    now,
    inflationPct: assumption(planning.assumptions, 'inflation_pct'),
  })
    .filter((r) => (r.kind === 'near' || r.kind === 'kept') && (r.state === 'due' || (r.state === 'saving' && r.perMonth > 0)))
    .sort((a, b) => (b.state === 'due') - (a.state === 'due') || (b.perMonth ?? 0) - (a.perMonth ?? 0))
    .forEach((r) => {
      actions.push({
        id: `goal-${r.goal.id}`,
        title: `Set aside for ${r.goal.name}`,
        detail:
          r.state === 'due'
            ? `AED ${fmt(r.remaining)} still needed in cash: its date, ${r.byLabel}, has arrived.`
            : r.plan?.enough
              ? `AED ${fmt(r.plan.amount)} a month, as you planned, reaches it by ${r.byLabel}: AED ${fmt(r.remaining)} still to set aside, with AED ${fmt(r.cash)} set aside now.`
              : `AED ${fmt(r.perMonth)} a month in cash to reach it by ${r.byLabel}${r.plan ? ` (you plan AED ${fmt(r.plan.amount)})` : ''}: AED ${fmt(r.remaining)} still to set aside, with AED ${fmt(r.cash)} set aside now.`,
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

  // 4. Saving against the month's savings target: income less all spending,
  // the check Plan shows too (lib/monthlyCheck.js).
  const saving = savingCheck({ year, month }, { transactions, budgets, categories }, now);
  if (saving && saving.short > 0) {
    actions.push({
      id: 'saving',
      title: 'Catch up on saving',
      detail: `Saved AED ${saving.saved < 0 ? `−${fmt(saving.saved)}` : fmt(saving.saved)} against a target of AED ${fmt(saving.target)}: AED ${fmt(saving.short)} short.`,
      href: tabHref('/money', 'budget'),
      cta: 'Open Budget',
    });
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
