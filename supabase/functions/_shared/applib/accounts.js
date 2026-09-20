// Synced copy of src/lib/accounts.js (isArchived, accountValueAed and the
// unvalued helpers are what is used server-side) -- see scope.js in this same
// directory for why.
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

export function isAccountValued(account) {
  return accountValueAed(account) !== null;
}

// The open accounts whose AED value nobody knows. Any total built from accounts
// is incomplete by exactly this much, and the bot has to be able to say so --
// a /brief or a "what's our net worth" that quietly omits an unconverted loan
// reads as the complete picture (QA #4).
export function unvaluedAccounts(accounts = []) {
  return accounts.filter((a) => !isArchived(a) && !isAccountValued(a));
}

// The same sentence the web app uses, so the bot and the screens describe the
// same gap in the same words.
export function unvaluedNote(count, { capitalised = true } = {}) {
  if (!count) return null;
  const noun = count === 1 ? 'account' : 'accounts';
  const verb = count === 1 ? 'has' : 'have';
  const lead = capitalised ? 'Excludes' : 'excludes';
  return `${lead} ${count} ${noun} in another currency that ${verb} no AED conversion yet.`;
}
