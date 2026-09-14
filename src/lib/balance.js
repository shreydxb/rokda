// Account balances are MANUAL SNAPSHOTS (QA-02, SHR-243).
//
// A balance means "what a member last confirmed, as of a date". It is not
// derived from an opening balance plus transactions, and the two models are
// never mixed. The consequence the review found: `balance` defaults to 0, so
// an account nobody has valued reads as a confirmed zero — "Nothing owed" on a
// card with recorded spending. An unconfirmed balance is unknown, and says so.

export const BALANCE_STALE_DAYS = 45;

// A fixed deposit's balance is not a human assertion and never will be. The
// database computes it from principal, rate and dates
// (compute_account_derived_fields), and the daily fd-accrual job touches every
// active FD so that trigger recomputes it against today. There is nothing for
// anyone to confirm (QA pass 3, O4).
//
// Waiting for a confirmation that cannot arrive is what made one deposit count
// two ways on a single screen: netWorthSummary() includes balance_aed in the
// total, while NetWorth's composition bar contributed zero for anything
// "unset" -- so the bar's shares did not add up to the total printed above
// them. The attention list then asked for the impossible, and did it while
// stating something false: "net worth treats it as zero until someone
// confirms what it actually is", when net worth was already counting it.
//
// An FD without the inputs to compute from is not derived, and falls back to
// the ordinary rules.
export function isDerivedBalance(account) {
  return account?.type === 'fd' && account?.principal != null && account?.interest_rate_pct != null;
}

export function isBalanceConfirmed(account) {
  return isDerivedBalance(account) || account?.balance_as_of != null;
}

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
