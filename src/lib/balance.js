// Account balances are MANUAL SNAPSHOTS (QA-02, SHR-243).
//
// A balance means "what a member last confirmed, as of a date". It is not
// derived from an opening balance plus transactions, and the two models are
// never mixed. The consequence the review found: `balance` defaults to 0, so
// an account nobody has valued reads as a confirmed zero — "Nothing owed" on a
// card with recorded spending. An unconfirmed balance is unknown, and says so.

export const BALANCE_STALE_DAYS = 45;

export function isBalanceConfirmed(account) {
  return account?.balance_as_of != null;
}

export function daysSinceBalanceConfirmed(account, now = new Date()) {
  if (!isBalanceConfirmed(account)) return null;
  return Math.floor((now - new Date(account.balance_as_of)) / 86400000);
}

// 'unset'     — nobody has confirmed this balance; the figure is not a fact
// 'stale'     — confirmed, but long enough ago to be worth re-checking
// 'confirmed' — confirmed recently
export function balanceStatus(account, now = new Date(), staleDays = BALANCE_STALE_DAYS) {
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
