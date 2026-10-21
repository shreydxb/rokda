import { atDayOfMonth, isPosted, monthKey, parseDay } from './day';
import { activityHref, isoDay, monthRange, tabHref } from './activityLink';
import { isDerivedBalance } from './accounts';
import { snapshotMonthKeys, lastClosedMonth } from './snapshots';
import { orderPair, transferCandidates } from './transfers';
import { budgetGroupSpend } from './budget';
import { isUncategorised } from './activity';
import { refundLinkOf } from './refunds';
import { duplicatePairs } from './duplicates';

// The monthly review (docs/decisions.md, "A month is reviewed, then closed").
//
// Closing a month used to be one button under Wealth -> Net worth, and nothing
// asked whether the month's records were right before its totals went into
// history. The review is the list of what to settle first, in the order it is
// worth doing: the records (flagged, uncategorised, transfers not yet joined),
// then the card statements, then the balances, then the close itself. Each
// check is worked out from what is already recorded, so it ticks itself off as
// the work is done and nothing extra is stored; the close is the one act that
// is recorded, and it is what marks the month reviewed.
//
// The review covers the whole household, whichever person the sidebar shows:
// a month closes for the household, and a flagged record of either person's is
// still unfinished. Its links open the records for Both (`who: 'both'`), so
// they show what it counted.

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM' for a month (1-12).
export function reviewMonthParam(year, month) {
  return `${year}-${pad(month)}`;
}

// The month the review opens on: the one in the address if it is a finished
// month, otherwise the month just ended. A running month can't be reviewed:
// its records are still arriving.
export function reviewMonth(param, now = new Date()) {
  const latest = lastClosedMonth(now);
  const match = /^(\d{4})-(\d{2})$/.exec(param ?? '');
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month >= 1 && month <= 12 && new Date(year, month - 1, 1) <= latest) return { year, month };
  }
  return { year: latest.getFullYear(), month: latest.getMonth() + 1 };
}

// The way back to the review from where one of its links sends you (SHR-301).
// The link carries the month in `reviewing`, which Money, Wealth and Planning
// read to offer "Back to the review"; the review's own `month` and Activity's
// `review` filter mean something else.
export const REVIEWING_PARAM = 'reviewing';

export function withReviewReturn(href, { year, month }) {
  if (!href) return href;
  const url = new URL(href, 'https://rokda.invalid');
  url.searchParams.set(REVIEWING_PARAM, reviewMonthParam(year, month));
  return `${url.pathname}${url.search}`;
}

// The month a page was opened from the review for, or null. Only a month the
// review can show counts, so a stale or hand-edited address offers nothing.
export function reviewReturn(params, now = new Date()) {
  const asked = params.get(REVIEWING_PARAM);
  if (!asked) return null;
  const month = reviewMonth(asked, now);
  if (reviewMonthParam(month.year, month.month) !== asked) return null;
  return { ...month, href: tabHref('/money', 'review', { month: asked }), label: new Date(month.year, month.month - 1, 1).toLocaleDateString('en-GB', { month: 'long' }) };
}

// The months either side, null where there is nothing to step to.
export function adjacentReviewMonths({ year, month }, now = new Date()) {
  const prev = new Date(year, month - 2, 1);
  const next = new Date(year, month, 1);
  return {
    prev: { year: prev.getFullYear(), month: prev.getMonth() + 1 },
    next: next <= lastClosedMonth(now) ? { year: next.getFullYear(), month: next.getMonth() + 1 } : null,
  };
}

const inMonth = (t, from, to) => {
  const day = parseDay(t.occurred_at);
  return day >= parseDay(from) && day <= parseDay(to);
};

// Pairs of records in the month that look like one transfer recorded as two
// (lib/transfers.js): the same amount out of one account and into another,
// within a few days. Each pair once, money-out side first. A split record is a
// purchase, never one side of a transfer.
export function possibleTransfers(monthRows, transactions) {
  const used = new Set();
  const pairs = [];
  const eligible = transactions.filter((t) => !t.is_split);
  for (const t of monthRows) {
    if (t.is_split || used.has(t.id)) continue;
    const other = transferCandidates(t, eligible).find((c) => !used.has(c.id));
    if (!other) continue;
    used.add(t.id);
    used.add(other.id);
    pairs.push(orderPair(t, other));
  }
  return pairs;
}

// The card statements that closed in the month, one per open card with a
// statement day, with what was recorded about each (Wealth -> Statements).
export function monthStatements({ year, month }, accounts = [], reconciliations = []) {
  const byKey = new Map(reconciliations.map((r) => [`${r.account_id}:${r.statement_date}`, r]));
  const rows = [];
  for (const account of accounts) {
    if (account.type !== 'credit_card' || account.archived_at || !account.statement_day) continue;
    const close = atDayOfMonth(year, month - 1, account.statement_day);
    // A card added after this statement closed has nothing to check for it.
    if (account.created_at && parseDay(account.created_at) > close) continue;
    const statementDate = isoDay(close);
    const status = byKey.get(`${account.id}:${statementDate}`)?.status ?? 'unchecked';
    rows.push({ account, statementDate, status, settled: status === 'confirmed' || status === 'reconciled' });
  }
  return rows.sort((a, b) => a.account.name.localeCompare(b.account.name));
}

// Open accounts whose balance nobody has confirmed since the month ended. A
// balance confirmed after the month's last day reads the month end at least
// as well as anything older, and a term deposit's balance is worked out, not
// confirmed.
export function balancesToConfirm({ year, month }, accounts = []) {
  const end = parseDay(monthRange(year, month).to);
  return accounts.filter((a) => {
    if (a.archived_at || isDerivedBalance(a)) return false;
    if (a.created_at && parseDay(a.created_at) > end) return false;
    return a.balance_as_of == null || parseDay(a.balance_as_of) < end;
  });
}

// The month's budget against what was spent, by budgeted group, for the
// summary under the checks. Savings targets stay out, as on Budget.
export function budgetSummary({ year, month }, { transactions = [], budgets = [], categories = [] }, now = new Date()) {
  const savingsIds = new Set(categories.filter((c) => c.is_savings).map((c) => c.id));
  const rows = budgets.filter((b) => b.year === year && b.month === month && !savingsIds.has(b.category_id));
  const catById = new Map(categories.map((c) => [c.id, c]));
  const spend = budgetGroupSpend(transactions, rows.map((r) => r.category_id), catById, year, month, null, now);
  const planned = new Map();
  for (const r of rows) {
    const groupId = catById.get(r.category_id)?.parent_id ?? r.category_id;
    planned.set(groupId, (planned.get(groupId) ?? 0) + Number(r.amount));
  }
  const over = [...planned]
    .map(([groupId, budget]) => ({ categoryId: groupId, name: catById.get(groupId)?.name ?? 'Category', budget, spent: spend.groups.get(groupId) ?? 0 }))
    .filter((g) => g.spent > g.budget)
    .sort((a, b) => b.spent - b.budget - (a.spent - a.budget));
  return {
    budgeted: rows.reduce((s, r) => s + Number(r.amount), 0),
    spentInBudget: spend.inBudgetedGroups,
    outside: spend.outside,
    total: spend.total,
    over,
    hasBudget: rows.length > 0,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayLabel = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// The checklist for one month. Each check is { id, title, status, detail,
// href }: status 'done', 'todo', or 'note' for something worth a look that
// doesn't hold the month up. `done` of `total` counts only the checks that
// can hold it up (`required`), so the count doesn't move when a note appears.
export function monthlyReview({ year, month }, { transactions = [], accounts = [], statementReconciliations = [], netWorthSnapshots = [], transactionLinks = [] }, now = new Date()) {
  const { from, to } = monthRange(year, month);
  const label = new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const rows = transactions.filter((t) => inMonth(t, from, to) && isPosted(t, now));
  const checks = [];

  const flagged = rows.filter((t) => t.needs_review);
  checks.push({
    id: 'review',
    required: true,
    title: 'Flagged records',
    status: flagged.length ? 'todo' : 'done',
    count: flagged.length,
    detail: flagged.length ? `${plural(flagged.length, 'record')} still marked for review.` : 'Nothing left marked for review.',
    href: activityHref({ needsReview: true, from, to, who: 'both' }),
  });

  const uncategorised = rows.filter(isUncategorised);
  checks.push({
    id: 'categorise',
    required: true,
    title: 'Categories',
    status: uncategorised.length ? 'todo' : 'done',
    count: uncategorised.length,
    detail: uncategorised.length
      ? `${plural(uncategorised.length, 'record')} with no category, so Budget and Insights leave ${uncategorised.length === 1 ? 'it' : 'them'} out of every category.`
      : 'Every record has a category.',
    href: activityHref({ categoryId: 'none', from, to, who: 'both' }),
  });

  // A pair confirmed as two real records is remembered, and deleting one
  // ends it too, so unlike a transfer suggestion this can always be settled.
  const duplicates = duplicatePairs(rows, transactions, transactionLinks);
  checks.push({
    id: 'duplicates',
    required: true,
    title: 'Possible duplicates',
    status: duplicates.length ? 'todo' : 'done',
    count: duplicates.length,
    pairs: duplicates,
    detail: duplicates.length
      ? `${plural(duplicates.length, 'pair')} of records on the same account, at the same shop, for the same amount within a few days. Keep both if both are real, or delete the one recorded twice.`
      : 'No records that look recorded twice.',
    href: null,
  });

  const pairs = possibleTransfers(rows, transactions);
  checks.push({
    id: 'transfers',
    // Two records that happen to match aren't always a transfer, and there
    // is nothing to record that says so, so this never holds a month up.
    required: false,
    title: 'Transfers',
    status: pairs.length ? 'note' : 'done',
    count: pairs.length,
    pairs,
    detail: pairs.length
      ? `${plural(pairs.length, 'pair')} of records look like money moved between your own accounts. Joined, they stop counting as spending and income. Leave any that aren't.`
      : 'No unjoined transfers found.',
    href: null,
  });

  // A payment in another currency whose AED is still an estimate: the
  // statement shows what was actually debited (SHR-321). Only asked about in
  // a month that had such payments.
  const foreignRows = rows.filter((t) => t.native_amount != null && t.currency && t.currency !== 'AED');
  if (foreignRows.length) {
    const estimated = foreignRows.filter((t) => t.aed_estimated);
    checks.push({
      id: 'estimates',
      required: true,
      title: 'Payments in other currencies',
      status: estimated.length ? 'todo' : 'done',
      count: estimated.length,
      detail: estimated.length
        ? `${plural(estimated.length, 'payment')} with the AED still estimated from a rate. Enter the AED debited from the statement.`
        : 'Every payment in another currency has the AED actually debited.',
      href: activityHref({ estimated: true, from, to, who: 'both' }),
    });
  }

  // A refund not yet linked to its purchase still nets in its own category,
  // so it doesn't hold the month up; linking it files it where the money was
  // spent (lib/refunds.js).
  const unlinkedRefunds = rows.filter((t) => t.kind === 'refund' && !refundLinkOf(t.id, transactionLinks));
  checks.push({
    id: 'refunds',
    required: false,
    title: 'Refunds',
    status: unlinkedRefunds.length ? 'note' : 'done',
    count: unlinkedRefunds.length,
    detail: unlinkedRefunds.length
      ? `${plural(unlinkedRefunds.length, 'refund')} not linked to the purchase ${unlinkedRefunds.length === 1 ? 'it returns' : 'they return'}. Open one and choose its purchase, and it takes that purchase's category.`
      : 'Every refund is linked to its purchase.',
    href: activityHref({ kind: 'refund', from, to, who: 'both' }),
  });

  const statements = monthStatements({ year, month }, accounts, statementReconciliations);
  if (statements.length) {
    const open = statements.filter((s) => !s.settled);
    checks.push({
      id: 'statements',
      required: true,
      title: 'Card statements',
      status: open.length ? 'todo' : 'done',
      count: open.length,
      statements,
      detail: open.length
        ? `${plural(open.length, 'statement')} that closed in ${label.split(' ')[0]} still to check against what was recorded.`
        : `Every statement that closed in ${label.split(' ')[0]} is checked.`,
      // A refund often lands a statement or two after the purchase, so a
      // purchase returned late in the month can read as a difference here
      // and settle on the next one.
      hint: 'A refund can arrive on a later statement than the purchase it returns.',
      // The statements that closed in this month, however long ago.
      href: tabHref('/wealth', 'statements', { month: reviewMonthParam(year, month) }),
    });
  }

  const closed = snapshotMonthKeys(netWorthSnapshots).has(monthKey(new Date(year, month - 1, 1)));
  const latest = lastClosedMonth(now);
  const closable = year === latest.getFullYear() && month === latest.getMonth() + 1;

  // Balances feed the close, so once the month is closed they no longer ask
  // for anything.
  const unconfirmed = closed ? [] : balancesToConfirm({ year, month }, accounts);
  if (!closed) {
    checks.push({
      id: 'balances',
      required: true,
      title: 'Account balances',
      status: unconfirmed.length ? 'todo' : 'done',
      count: unconfirmed.length,
      accounts: unconfirmed,
      detail: unconfirmed.length
        ? `Not confirmed since ${dayLabel(to)}: ${unconfirmed.map((a) => a.name).join(', ')}.`
        : `Every balance is confirmed since ${dayLabel(to)}.`,
      href: tabHref('/wealth', 'accounts'),
    });
  }

  checks.push({
    id: 'close',
    required: closed || closable,
    title: 'Close the month',
    // An earlier month that was never closed can't be now: a close records
    // today's totals as the month just ended's. It doesn't hold up a review
    // of the records, which are still worth getting right.
    status: closed ? 'done' : closable ? 'todo' : 'note',
    detail: closed
      ? `${label} is closed, and its totals are in history.`
      : closable
        ? `Record ${label}'s net worth under Wealth → Net worth${unconfirmed.length ? ', once the balances are confirmed' : ''}.`
        : `${label} was never closed, and it can't be now: a close records today's totals as the month just ended's.`,
    href: closable && !closed ? '/wealth' : null,
  });

  const counted = checks.filter((c) => c.required);
  const done = counted.filter((c) => c.status === 'done').length;
  return { year, month, from, to, label, checks, done, total: counted.length, complete: done === counted.length, closed };
}
