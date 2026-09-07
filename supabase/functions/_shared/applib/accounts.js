// Synced copy of src/lib/accounts.js (isArchived only is used server-side) --
// see scope.js in this same directory for why.
export function isArchived(account) {
  return account?.archived_at != null;
}
