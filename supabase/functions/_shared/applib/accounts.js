// Synced copy of src/lib/accounts.js (isArchived and accountValueAed are what
// is used server-side) -- see scope.js in this same directory for why.
export function isArchived(account) {
  return account?.archived_at != null;
}

// The AED value of an account, or null when it genuinely is not known.
//
// `balance_aed` is written by the account trigger when the row is saved. A
// non-AED account that has never been converted has null there, and the old
// `balance_aed ?? balance` fallback then presented a foreign amount as though
// it were dirhams -- 10,000 rupees counted as 10,000 dirhams (QA pass 3, O3).
// An AED account needs no conversion, so its own balance is the answer.
export function accountValueAed(account) {
  if (account?.balance_aed != null) return Number(account.balance_aed);
  const currency = String(account?.currency ?? 'AED').toUpperCase();
  if (currency === 'AED') return Number(account?.balance ?? 0);
  return null;
}
