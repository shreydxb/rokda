import { atDayOfMonth, isPosted, parseDay, startOfDay } from './day';
import { spendDelta } from './transactionKind';

export function utilisation(account) {
  if (!account.credit_limit) return null;
  return Number(account.balance) / Number(account.credit_limit);
}

// statement_day is a day-of-month (1-31). Returns the most recently closed
// statement date and the next (still-open) close date, straddling "now".
//
// Each date is clamped to the length of its own month: a card that closes on
// the 31st closes on 28 February, not 3 March. `new Date(y, 1, 31)` overflows
// into the next month, which is what produced that date (QA-07).
export function billingCycle(statementDay, now = new Date()) {
  const today = startOfDay(now);
  const year = today.getFullYear();
  const month = today.getMonth();
  const thisMonthClose = atDayOfMonth(year, month, statementDay);
  const lastClose = thisMonthClose > today ? atDayOfMonth(year, month - 1, statementDay) : thisMonthClose;
  const cycleStart = atDayOfMonth(lastClose.getFullYear(), lastClose.getMonth() - 1, statementDay);
  const nextClose = atDayOfMonth(lastClose.getFullYear(), lastClose.getMonth() + 1, statementDay);
  return { cycleStart, lastClose, nextClose };
}

// The single due-date rule, shared by Overview's attention list and the cards
// panel. Both compare whole days from the same starting point, so a card due
// today reads as due today on both screens instead of one of them rolling it
// into next month (QA-07).
export function nextDueDate(dueDay, now = new Date()) {
  if (!dueDay) return null;
  const today = startOfDay(now);
  const thisMonth = atDayOfMonth(today.getFullYear(), today.getMonth(), dueDay);
  return thisMonth >= today ? thisMonth : atDayOfMonth(today.getFullYear(), today.getMonth() + 1, dueDay);
}

export function daysUntilDue(dueDay, now = new Date()) {
  const due = nextDueDate(dueDay, now);
  if (!due) return null;
  return Math.round((due - startOfDay(now)) / 86400000);
}

// Spend on this account since the last statement closed — a running estimate
// of what the next statement will total. Still not a posted vs. authorised
// distinction: we don't track pending/cleared status, so a charge that has
// happened but hasn't cleared counts from its own date.
//
// Two rules it shares with every other spend total in the app, rather than
// keeping its own arithmetic (SHR-252, QA pass 3 P2):
//
//   - A future-dated row is planned, not spent. The cycle window alone does
//     not exclude it: `nextClose` is the end of the CYCLE, and a charge dated
//     next week is inside this cycle while still being in the future. Without
//     isPosted() a -500 charge dated the 20th inflated "Spent so far" on the
//     13th, which is a bill nobody has been charged yet.
//
//   - A refund nets against spend. `Math.max(0, -amount)` read a refund as a
//     positive-signed row and therefore contributed zero, so an expense of 100
//     refunded by 40 reported 100 rather than 60 -- while Budget and Overview,
//     which both route through spendDelta(), reported 60. The card was the
//     only screen disagreeing.
//
// The total can legitimately go negative when a cycle's refunds exceed its
// charges. That is a real net credit, so it is reported rather than clamped;
// the utilisation bar clamps its own width instead.
export function estimatedStatement(transactions, accountId, statementDay, now = new Date()) {
  if (!statementDay) return null;
  const { lastClose, nextClose } = billingCycle(statementDay, now);
  const amount = transactions
    .filter((t) => t.account_id === accountId)
    .filter((t) => isPosted(t, now))
    .filter((t) => {
      const d = parseDay(t.occurred_at);
      return d >= lastClose && d < nextClose;
    })
    .reduce((sum, t) => sum + spendDelta(t, Number(t.amount)), 0);
  return { amount, since: lastClose, closes: nextClose };
}
