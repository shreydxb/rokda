import { isPosted, monthKey } from './day';
import { monthRange } from './activityLink';
import { isUncategorised } from './activity';
import { balanceStatus } from './balance';
import { monthActualsByCategory, monthIncome, monthSpendBreakdown } from './budget';
import { historyPreview } from './monthActions';
import { trailingAverageByCategory } from './insights';
import { snapshotMonthKeys, lastClosedMonth } from './snapshots';
import { statementsToCheck } from './statements';
import { monthFromParam } from './useMonthParam';
import { USUAL_MONTHS } from './budgetTable';

// Money -> Month end as the prototype lays it out (the revamp, phase 4d;
// design/prototype meRunning, meSteps, meClosed): which page a month shows,
// the review's checks gathered into three steps, a closed month's figures on
// one page, and the running month's strip. The checks themselves stay in
// lib/monthlyReview.js, so what holds a month up is worked out in one place.
// Like the review, it covers the whole household, whichever person the
// sidebar shows: a month closes for the household.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const monthName = (year, month) => new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long' });
// Short month names as the rest of the app writes them ("Sep", not en-GB's "Sept").
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sameMonth = (a, year, month) => a.getFullYear() === year && a.getMonth() + 1 === month;

// The month the address names, or the running month, as on every other Money
// tab. A month still to come has nothing to show, so it opens the running one.
export function monthEndMonth(param, now = new Date()) {
  const running = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const date = monthFromParam(param);
  if (!date || date > new Date(now.getFullYear(), now.getMonth(), 1)) return running;
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

// 'running' for the month still going; 'closed' for one closed; 'close' for
// the month just ended, which is the only one a close can record (it records
// today's balances as that month's); 'earlier' for an older month never
// closed, which can still be tidied but not closed now.
export function monthEndPage({ year, month }, netWorthSnapshots = [], now = new Date()) {
  if (sameMonth(now, year, month)) return 'running';
  if (snapshotMonthKeys(netWorthSnapshots).has(monthKey(new Date(year, month - 1, 1)))) return 'closed';
  return sameMonth(lastClosedMonth(now), year, month) ? 'close' : 'earlier';
}

// What each check says when it holds its step up, in the order the step's
// status line reads them.
const TODO_WORDS = {
  categorise: (n) => `${n} uncategorised`,
  duplicates: (n) => plural(n, 'possible duplicate'),
  review: (n) => `${n} flagged`,
  estimates: (n) => plural(n, 'AED estimate'),
  statements: (n) => `${plural(n, 'statement')} to check`,
  balances: (n) => `${plural(n, 'balance')} not confirmed`,
};
const STATUS_ORDER = ['categorise', 'duplicates', 'review', 'estimates', 'statements', 'balances'];

const TIDY = ['review', 'categorise', 'duplicates', 'estimates', 'transfers', 'refunds'];
const CHECK = ['statements', 'balances'];

// The review's checks (lib/monthlyReview.js) as the prototype's three steps:
// tidy the records, check the statements and balances, then close. A step is
// done once none of its required checks is still to do; a note (a transfer
// to join, a refund to link) is worth a look but never holds it up. An
// earlier month that can't be closed now has only the first two. `current`
// is the first step not done, the one shown open; `open` the steps before the
// close still not done, for the note beside the close.
export function monthEndSteps(review) {
  const byId = new Map(review.checks.map((c) => [c.id, c]));
  const pick = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
  const statusOf = (checks) => {
    const todo = checks.filter((c) => c.required && c.status === 'todo');
    if (!todo.length) return 'All clear';
    return [...todo]
      .sort((a, b) => STATUS_ORDER.indexOf(a.id) - STATUS_ORDER.indexOf(b.id))
      .map((c) => TODO_WORDS[c.id](c.count))
      .join(' · ');
  };
  const doneOf = (checks) => checks.every((c) => !c.required || c.status !== 'todo');

  const tidyChecks = pick(TIDY);
  const checkChecks = pick(CHECK);
  const steps = [
    { n: 1, id: 'tidy', title: 'Tidy transactions', checks: tidyChecks, done: doneOf(tidyChecks), status: statusOf(tidyChecks), clear: tidyChecks.filter((c) => c.status === 'done').map((c) => c.title) },
    { n: 2, id: 'check', title: 'Check statements and balances', checks: checkChecks, done: doneOf(checkChecks), status: statusOf(checkChecks) },
  ];
  const close = byId.get('close');
  const closable = !!close && close.required && close.status === 'todo';
  if (closable) steps.push({ n: 3, id: 'close', title: 'Close', checks: [close], done: false, status: `Puts ${monthName(review.year, review.month)} into history` });

  const open = steps.filter((s) => s.n < 3 && !s.done).map((s) => s.n);
  return {
    steps,
    done: steps.filter((s) => s.done).length,
    total: steps.length,
    current: steps.find((s) => !s.done)?.n ?? null,
    open,
    closable,
  };
}

// A closed month on a page: its income, spending and saving, with the
// change on the month before (none in the first month with records), and the
// net worth its close recorded, with the change on the close before it,
// however many months back that was. The figures are historyPreview's, so
// they read as they did on the close.
export function closedMonthFigures({ year, month }, data = {}, now = new Date()) {
  const { transactions = [] } = data;
  const preview = historyPreview({ year, month }, data, now);
  const before = new Date(year, month - 2, 1);
  const [py, pm] = [before.getFullYear(), before.getMonth() + 1];
  const { from, to } = monthRange(py, pm);
  const hadRecords = transactions.some((t) => {
    const day = String(t.occurred_at).slice(0, 10);
    return day >= from && day <= to && isPosted(t, now);
  });
  return {
    income: preview.income,
    spend: preview.spend,
    saved: preview.saved,
    rate: preview.rate,
    previous: hadRecords
      ? { label: SHORT[pm - 1], income: monthIncome(transactions, py, pm, null, now), spend: monthSpendBreakdown(transactions, [], py, pm, null, now).total }
      : null,
    netWorth: preview.closed ? preview.netWorth : null,
    netWorthChange: preview.closed ? preview.change : null,
    previousClose: preview.previous ? SHORT[Number(String(preview.previous.date).slice(5, 7)) - 1] : null,
  };
}

// A closed month's Biggest changes: the categories whose spending was
// furthest from their usual month, above or below, a usual category not
// spent on at all among them. "Usual" is the six-month average Budget's Usual
// column and Overview read (lib/insights.js), by category as recorded, as
// Overview's Where this month went shows it. Until there is a usual month to
// compare with, the biggest categories instead (`moved` false).
export function biggestChanges(transactions, categories, { year, month }, now = new Date(), limit = 3) {
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));
  const spent = monthActualsByCategory(transactions, year, month, null, now);
  const { averages } = trailingAverageByCategory(transactions, year, month, USUAL_MONTHS, null);
  const ids = new Set([...spent.keys(), ...averages.keys()]);
  const rows = [...ids].map((id) => ({ categoryId: id, name: nameOf.get(id) ?? 'Category', spent: spent.get(id) ?? 0, usual: averages.has(id) ? averages.get(id) : null }));
  const compared = rows.filter((r) => r.usual != null && Math.abs(r.spent - r.usual) >= 0.005);
  if (compared.length) {
    return { moved: true, rows: compared.sort((a, b) => Math.abs(b.spent - b.usual) - Math.abs(a.spent - a.usual)).slice(0, limit) };
  }
  return { moved: false, rows: rows.filter((r) => r.spent > 0).sort((a, b) => b.spent - a.spent).slice(0, limit) };
}

// The running month's strip: records with no category so far (posted ones;
// a scheduled record isn't a fact yet), the card statements still to check
// and how many of those don't match, and the open balances nobody has
// confirmed or not for a while (lib/balance.js), as Overview counts them.
export function runningMonthStrip({ year, month }, { transactions = [], accounts = [], statements = [] }, now = new Date()) {
  const { from, to } = monthRange(year, month);
  const uncategorised = transactions.filter((t) => {
    const day = String(t.occurred_at).slice(0, 10);
    return day >= from && day <= to && isPosted(t, now) && isUncategorised(t);
  }).length;
  return {
    uncategorised,
    statements: statementsToCheck(statements),
    mismatched: statements.filter((s) => s.status === 'mismatch').length,
    balances: accounts.filter((a) => a.archived_at == null && balanceStatus(a, now) !== 'confirmed').length,
  };
}
