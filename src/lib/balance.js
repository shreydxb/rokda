// Account balances are MANUAL SNAPSHOTS (QA-02, SHR-243).
//
// A balance means "what a member last confirmed, as of a date". It is not
// derived from an opening balance plus transactions, and the two models are
// never mixed. The consequence the review found: `balance` defaults to 0, so
// an account nobody has valued reads as a confirmed zero — "Nothing owed" on a
// card with recorded spending. An unconfirmed balance is unknown, and says so.

import { isDerivedBalance, isBalanceConfirmed } from './accounts';

export const BALANCE_STALE_DAYS = 45;

// isDerivedBalance/isBalanceConfirmed moved to accounts.js so that
// overviewMath.js -- which is mirrored into _shared/applib, where balance.js
// does not exist -- can apply the same rule instead of restating it. Re-exported
// here because this is where the rest of the app expects to find them.
export { isDerivedBalance, isBalanceConfirmed } from './accounts';

export function daysSinceBalanceConfirmed(account, now = new Date()) {
  // Keyed off the stamp itself, not off isBalanceConfirmed: a derived balance
  // is valued without ever carrying one, and `new Date(null)` is 1970, which
  // would report it as tens of thousands of days stale.
  if (account?.balance_as_of == null) return null;
  return Math.floor((now - new Date(account.balance_as_of)) / 86400000);
}

// 'unset'     — nobody has confirmed this balance; the figure is not a fact
// 'stale'     — confirmed, but long enough ago to be worth re-checking
// 'confirmed' — confirmed recently
export function balanceStatus(account, now = new Date(), staleDays = BALANCE_STALE_DAYS) {
  // Recomputed daily, so it cannot go stale the way a typed-in figure does.
  if (isDerivedBalance(account)) return 'confirmed';
  if (!isBalanceConfirmed(account)) return 'unset';
  return daysSinceBalanceConfirmed(account, now) >= staleDays ? 'stale' : 'confirmed';
}

export function balanceLabel(account, now = new Date()) {
  const status = balanceStatus(account, now);
  if (status === 'unset') return 'Balance not set';
  if (status === 'stale') return `Balance checked ${daysSinceBalanceConfirmed(account, now)}d ago`;
  return null;
}

// Net worth is provisional whenever any account contributing to it has never
// had its balance confirmed: the total is arithmetic over numbers that were
// never asserted.
export function unconfirmedAccounts(accounts = []) {
  return accounts.filter((a) => !isBalanceConfirmed(a));
}

export function netWorthProvisional(accounts = []) {
  return unconfirmedAccounts(accounts).length > 0;
}
