// Synced copy of src/screens/overviewMath.js (trimmed to what the Telegram
// assistant's tools need) -- see scope.js in this same directory for why.
import { scopedValue } from './scope.js';
import { accountValueAed, isArchived } from './accounts.js';
import { scopedHoldingValue, visibleHoldings } from './holdings.js';

const LIABILITY_TYPES = new Set(['credit_card', 'loan']);
const LIQUID_TYPES = new Set(['checking', 'savings', 'cash']);

function visibleToScope(row, scopeMemberId) {
  if (scopeMemberId === null) return true;
  return row.is_shared || row.owner_member_id === scopeMemberId;
}

export function visibleAccounts(accounts, scopeMemberId) {
  return accounts.filter((a) => !isArchived(a) && visibleToScope(a, scopeMemberId));
}

export function netWorthSummary(accounts, scopeMemberId, holdings = []) {
  let assets = 0;
  let liabilities = 0;
  let unvalued = 0;
  for (const a of visibleAccounts(accounts, scopeMemberId)) {
    // An account whose AED value is unknown is counted, not guessed at:
    // adding a foreign balance as though it were dirhams is worse than
    // reporting the total as incomplete (QA pass 3, O3).
    const aed = accountValueAed(a);
    if (aed === null) {
      unvalued += 1;
      continue;
    }
    const v = scopedValue(aed, a, scopeMemberId);
    if (LIABILITY_TYPES.has(a.type)) liabilities += v;
    else assets += v;
  }
  for (const h of visibleHoldings(holdings, scopeMemberId)) {
    assets += scopedHoldingValue(h, scopeMemberId);
  }
  return { assets, liabilities, netWorth: assets - liabilities, unvalued };
}

export function liquidAssets(accounts, scopeMemberId) {
  return visibleAccounts(accounts, scopeMemberId)
    .filter((a) => LIQUID_TYPES.has(a.type))
    .reduce((sum, a) => sum + scopedValue(accountValueAed(a) ?? 0, a, scopeMemberId), 0);
}
