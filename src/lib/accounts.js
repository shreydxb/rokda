// Account lifecycle. An account is closed, not deleted: the transactions that
// happened on it are history and outlive it (QA-01, SHR-242). Hard deletion
// stays available only for an account that was never used — a typo, an
// account added twice — and the database refuses it otherwise.

export function isArchived(account) {
  return account?.archived_at != null;
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
    parts.push(String(account.type ?? '').replace('_', ' '));
  }
  if (isArchived(account)) parts.push('closed');
  return parts.filter(Boolean).join(' · ');
}
