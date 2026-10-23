// Account lifecycle. An account is closed, not deleted: the transactions that
// happened on it are history and outlive it (QA-01, SHR-242). Hard deletion
// stays available only for an account that was never used — a typo, an
// account added twice — and the database refuses it otherwise.

// What each stored account type is called on screen. The keys are every value
// the accounts_type_check constraint allows, in the order they are offered and
// grouped; a type this map doesn't know reads as Other.
export const ACCOUNT_TYPE_LABELS = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  fd: 'Fixed deposit',
  credit_card: 'Credit card',
  loan: 'Loan',
  investment: 'Investment',
  other: 'Other',
};

export function accountTypeLabel(type) {
  return ACCOUNT_TYPE_LABELS[type] ?? 'Other';
}

// How a fixed deposit's interest compounds, as offered in its editor.
export const COMPOUNDING_LABELS = {
  simple: 'Simple (paid at maturity)',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  half_yearly: 'Half-yearly',
  annually: 'Annually',
};

export function isArchived(account) {
  return account?.archived_at != null;
}

// A loan or a card: its balance is what is owed, not money the household has.
const LIABILITY_TYPES = new Set(['credit_card', 'loan']);
export function isLiabilityAccount(account) {
  return LIABILITY_TYPES.has(account?.type);
}

// What a loan or card owes, from a balance stored as the amount owed. A card
// stored below zero is in credit and owes nothing, as net worth and the bot
// read it. A loan cannot be in credit: one stored below zero was typed that
// way before the account editor asked for the amount owed, and owes it.
export function amountOwed(account, value = account?.balance) {
  const n = Number(value ?? 0);
  return account?.type === 'credit_card' ? Math.max(0, n) : Math.abs(n);
}

export function activeAccounts(accounts = []) {
  return accounts.filter((a) => !isArchived(a));
}

export function archivedAccounts(accounts = []) {
  return accounts.filter(isArchived);
}

// Choices offered for a *new* entry: open accounts only. When editing an
// existing record that already points at a closed account, that account stays
// in the list so saving the record doesn't silently move it somewhere else.
export function selectableAccounts(accounts = [], currentAccountId = null) {
  return accounts.filter((a) => !isArchived(a) || (currentAccountId != null && a.id === currentAccountId));
}

export function transactionsForAccount(transactions = [], accountId) {
  return transactions.filter((t) => t.account_id === accountId);
}

// Only an account with no transactions may be hard-deleted. This mirrors the
// foreign key, which is the real guarantee — the UI just refuses earlier and
// with a better explanation.
export function canDeleteAccount(account, transactions = []) {
  return transactionsForAccount(transactions, account?.id).length === 0;
}

// What the "Remove" action should actually do, and what the confirmation has to
// tell the user before they do it.
export function closurePlan(account, transactions = []) {
  const linked = transactionsForAccount(transactions, account?.id).length;
  const balance = Number(account?.balance) || 0;
  if (linked === 0) {
    return {
      action: 'delete',
      transactionCount: 0,
      balance,
      title: 'Delete this account?',
      detail: 'It has no transactions, so nothing is lost.',
    };
  }
  return {
    action: 'archive',
    transactionCount: linked,
    balance,
    title: 'Close this account?',
    detail:
      `Its ${linked} transaction${linked === 1 ? '' : 's'} stay in your history and reports. ` +
      'The account stops being offered for new entries.' +
      (balance !== 0 ? ' Its balance is not zero, so closing it changes your net worth.' : ''),
  };
}

// Selector labels. The live editor offered "FAB" twice and "WIO" twice with
// nothing to tell them apart. Qualify a name only when it is actually
// ambiguous, so the common case stays short.
export function accountOptionLabel(account, { members = [], accounts = [] } = {}) {
  const parts = [account.name];
  if (accounts.filter((a) => a.name === account.name).length > 1) {
    const owner = account.is_shared
      ? 'Joint'
      : members.find((m) => m.id === account.owner_member_id)?.display_name;
    if (owner) parts.push(owner);
    parts.push(accountTypeLabel(account.type));
  }
  if (isArchived(account)) parts.push('closed');
  return parts.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- valuation

// The AED value of an account, or null when it genuinely is not known.
//
// `balance_aed` is written by the account trigger when the row is saved. A
// non-AED account that has never been converted has null there, and the old
// `balance_aed ?? balance` fallback then presented a foreign amount as though
// it were dirhams -- 10,000 rupees counted as 10,000 dirhams in net worth
// (QA pass 3, O3). An AED account needs no conversion, so its own balance is
// the answer.
//
// Null means unknown, and unknown is not zero. Callers must decide what to do
// with it rather than have a number chosen for them.
export function accountValueAed(account) {
  if (account?.balance_aed != null) return Number(account.balance_aed);
  const currency = String(account?.currency ?? 'AED').toUpperCase();
  if (currency === 'AED') return Number(account?.balance ?? 0);
  return null;
}

export function isAccountValued(account) {
  return accountValueAed(account) !== null;
}

// The open accounts whose AED value nobody knows. Any total built from
// accounts is incomplete by exactly this much, and the whole point of QA #4 is
// that "incomplete" has to travel with the number rather than being discarded
// at the first caller: a total that quietly omits an unconverted loan reads as
// the complete picture, and is wrong in the direction that flatters.
//
// Closed accounts are excluded, matching every other current-position figure:
// they are not part of what the household holds today, so a missing conversion
// on one is not a gap in today's total.
export function unvaluedAccounts(accounts = []) {
  return accounts.filter((a) => !isArchived(a) && !isAccountValued(a));
}

// The one sentence every screen uses for that gap, so Overview, Wealth,
// Forecast and the bot describe the same condition the same way instead of
// each inventing wording (or, worse, each choosing differently what to
// mention).
export function unvaluedNote(count, { capitalised = true } = {}) {
  if (!count) return null;
  const noun = count === 1 ? 'account' : 'accounts';
  const verb = count === 1 ? 'has' : 'have';
  const lead = capitalised ? 'Excludes' : 'excludes';
  return `${lead} ${count} ${noun} in another currency that ${verb} no AED conversion yet.`;
}

// A fixed deposit's balance is derived: compute_account_derived_fields()
// calculates it from principal, rate and dates, and the daily fd-accrual job
// touches every active FD so that trigger recomputes it against today. There
// is nothing for anyone to confirm (QA pass 3, O4).
//
// These two live here rather than in balance.js because overviewMath.js needs
// them and is mirrored into _shared/applib for the Edge Functions, which have
// no copy of balance.js. balance.js re-exports them, so every existing import
// keeps working and there is still exactly one definition.
export function isDerivedBalance(account) {
  return account?.type === 'fd' && account?.principal != null && account?.interest_rate_pct != null;
}

export function isBalanceConfirmed(account) {
  return isDerivedBalance(account) || account?.balance_as_of != null;
}
