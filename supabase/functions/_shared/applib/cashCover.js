// Synced copy of src/lib/cashCover.js -- see scope.js in this same directory
// for why. If you change the frontend original, mirror the change here too.
//
// Cash cover: can the household's readily-spendable money actually cover
// what's coming due soon, or is that liquidity really sitting somewhere
// else (an FD, a brokerage account) that isn't a same-day source of cash.

import { accountValueAed, isArchived, unvaluedAccounts, unvaluedNote } from './accounts.js';
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

// The liquid accounts whose AED value nobody knows. `liquidTotalAed` treats
// them as zero, which is the only arithmetic available -- but a zero that
// stands for "unknown" is exactly what turns a shortfall warning into a
// confident wrong answer, in either direction. cashCoverStatus reports the
// count so the caller can say the cover figure is incomplete (QA #4).
export function unvaluedLiquidAccounts(accounts = []) {
  return unvaluedAccounts(accounts).filter(isLiquidAccount);
}

// `bills` is the same shape getUpcomingBills/toolGetUpcomingBills already
// return: { recurring: [{amount_aed, due_date}], credit_cards: [{amount_owed_aed, due_date}] }.
// That tool already looks out 14 days; cash cover narrows to a tighter,
// more urgent window (`days`), since the point is "can this week be
// covered", not the whole fortnight.
//
// An AED amount of null means nobody knows what this costs in dirhams -- a
// foreign-currency card that was never converted, or a bill recorded in
// another currency. That is NOT the same as zero, and the two must not be
// summed together. See unvaluedDueBills below.
function billsDueWithin(bills, days, today) {
  const start = parseDay(today);
  const cutoff = new Date(start);
  cutoff.setDate(cutoff.getDate() + days);
  const inWindow = (dueDate) => {
    const d = parseDay(dueDate);
    return d >= start && d <= cutoff;
  };
  return [
    ...(bills?.recurring ?? []).filter((r) => inWindow(r.due_date)).map((r) => r.amount_aed),
    ...(bills?.credit_cards ?? []).filter((c) => inWindow(c.due_date)).map((c) => c.amount_owed_aed),
  ];
}

export function dueWithinAed(bills, days, today = new Date()) {
  return billsDueWithin(bills, days, today)
    .filter((amount) => amount != null)
    .reduce((sum, amount) => sum + Number(amount || 0), 0);
}

// How much of what is due has no AED amount at all. `dueWithinAed` can only
// leave these out, which makes the due total an UNDERSTATEMENT -- and an
// understated due total is what turns "covered" into a confident wrong
// answer, in the one direction that stops someone acting (QA #4).
//
// This is the mirror image of unvaluedLiquidAccounts and has to be reported
// separately, because the two point opposite ways: an unknown liquid asset
// makes a shortfall warning suspect, an unknown bill makes a clean bill of
// health suspect. Folding them into one count would lose that.
export function unvaluedDueBills(bills, days, today = new Date()) {
  return billsDueWithin(bills, days, today).filter((amount) => amount == null).length;
}

const round2 = (n) => Math.round(n * 100) / 100;

export function cashCoverStatus(accounts, bills, { days = 7, today = new Date() } = {}) {
  const liquidAed = round2(liquidTotalAed(accounts));
  const dueAed = round2(dueWithinAed(bills, days, today));
  const covered = liquidAed >= dueAed;
  // `unvalued` travels with the verdict rather than being folded into it:
  // an unconverted savings account means the cover figure understates, so a
  // "covered" answer is still trustworthy while a shortfall might not be.
  const unvalued = unvaluedLiquidAccounts(accounts ?? []).length;
  // `unvaluedDue` points the other way, so it gets its own flag rather than
  // being added to `unvalued`. When something due has no AED amount, the due
  // total is too low and `covered` is arithmetic about an incomplete sum --
  // true, and not to be trusted. Callers must not state a clean verdict on
  // an uncertain one, and must not use it to suppress a warning.
  const unvaluedDue = unvaluedDueBills(bills, days, today);
  return {
    liquidAed,
    dueAed,
    days,
    covered,
    certain: unvaluedDue === 0,
    shortfallAed: covered ? 0 : round2(dueAed - liquidAed),
    unvalued,
    unvaluedDue,
  };
}

// The sentence the bot actually says. It lives here rather than in the
// webhook because it is where the caveat either reaches the reader or does
// not -- which is the whole of QA #4 -- and in index.ts no unit test could
// reach it.
export function formatCashCoverLine(status) {
  const liquid = Number(status?.liquidAed ?? 0).toLocaleString();
  const due = Number(status?.dueAed ?? 0).toLocaleString();
  const base = `Cash cover: AED ${liquid} liquid vs AED ${due} due in the next ${status?.days} days`;
  const missing = status?.unvaluedDue ?? 0;

  // An unknown amount among what is due means the due total is a floor, not
  // the figure. "Covered" would be a clean verdict on an incomplete sum, so
  // it is not stated. A shortfall still is -- an understated total already
  // exceeding the liquid money only understates the problem.
  if (missing > 0) {
    const noun = missing === 1 ? 'One bill' : `${missing} bills`;
    const verb = missing === 1 ? 'has' : 'have';
    const note = `${noun} due in this window ${verb} no AED amount, so what's due is higher than this.`;
    return status?.covered
      ? `${base} -- can't say whether that is covered. ${note}`
      : `${base} -- short by at least AED ${Number(status?.shortfallAed ?? 0).toLocaleString()}. ${note}`;
  }

  const verdict = status?.covered
    ? `${base} -- covered.`
    : `${base} -- short by AED ${Number(status?.shortfallAed ?? 0).toLocaleString()}.`;
  // A "short by" warning built on a liquid figure that omits an unconverted
  // account can be wrong in the direction that causes action (QA #4), so the
  // omission is stated on the same line as the verdict it undermines.
  return status?.unvalued ? `${verdict} ${unvaluedNote(status.unvalued)}` : verdict;
}
