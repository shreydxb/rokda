// Cash cover: can the household's readily-spendable money actually cover
// what's coming due soon, or is that liquidity really sitting somewhere
// else (an FD, a brokerage account) that isn't a same-day source of cash.

import { accountValueAed, isArchived } from './accounts.js';
import { parseDay } from './day.js';

// Deliberately excludes: credit_card/loan (liabilities, not cover),
// investment (selling isn't same-day or guaranteed at a given price), fd
// (breaking one early usually costs a penalty), and 'other' (too ambiguous
// to assume it's spendable). A household with real liquidity spread across
// other buckets will show a shortfall here -- that's the honest answer, not
// a bug in the check.
const LIQUID_ACCOUNT_TYPES = new Set(['checking', 'savings', 'cash']);

export function isLiquidAccount(account) {
  return !isArchived(account) && LIQUID_ACCOUNT_TYPES.has(account?.type);
}

export function liquidTotalAed(accounts = []) {
  return accounts.filter(isLiquidAccount).reduce((sum, a) => sum + (accountValueAed(a) ?? 0), 0);
}

// `bills` is the same shape getUpcomingBills/toolGetUpcomingBills already
// return: { recurring: [{amount_aed, due_date}], credit_cards: [{amount_owed_aed, due_date}] }.
// That tool already looks out 14 days; cash cover narrows to a tighter,
// more urgent window (`days`), since the point is "can this week be
// covered", not the whole fortnight.
export function dueWithinAed(bills, days, today = new Date()) {
  const start = parseDay(today);
  const cutoff = new Date(start);
  cutoff.setDate(cutoff.getDate() + days);
  const inWindow = (dueDate) => {
    const d = parseDay(dueDate);
    return d >= start && d <= cutoff;
  };
  const recurringTotal = (bills?.recurring ?? [])
    .filter((r) => inWindow(r.due_date))
    .reduce((sum, r) => sum + Number(r.amount_aed || 0), 0);
  const cardsTotal = (bills?.credit_cards ?? [])
    .filter((c) => inWindow(c.due_date))
    .reduce((sum, c) => sum + Number(c.amount_owed_aed || 0), 0);
  return recurringTotal + cardsTotal;
}

const round2 = (n) => Math.round(n * 100) / 100;

export function cashCoverStatus(accounts, bills, { days = 7, today = new Date() } = {}) {
  const liquidAed = round2(liquidTotalAed(accounts));
  const dueAed = round2(dueWithinAed(bills, days, today));
  const covered = liquidAed >= dueAed;
  return { liquidAed, dueAed, days, covered, shortfallAed: covered ? 0 : round2(dueAed - liquidAed) };
}
