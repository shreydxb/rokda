// Synced copy of src/screens/overviewMath.js (trimmed to what the Telegram
// assistant's tools need) -- see scope.js in this same directory for why.
import { scopedValue } from './scope.js';
import { accountValueAed, isArchived } from './accounts.js';
import { scopedHoldingValue, visibleHoldings } from './holdings.js';
import { isAwaitingFirstValuation } from './valuation.js';

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
  // Never-valued holdings are counted for the same reason: their stored
  // value_aed is a placeholder 0, not a measurement (SHR-292).
  let unpricedHoldings = 0;
  for (const h of visibleHoldings(holdings, scopeMemberId)) {
    if (isAwaitingFirstValuation(h)) {
      unpricedHoldings += 1;
      continue;
    }
    assets += scopedHoldingValue(h, scopeMemberId);
  }
  return { assets, liabilities, netWorth: assets - liabilities, unvalued, unpricedHoldings };
}

// The same sentence the web app uses for what a net-worth total leaves out.
export function incompleteNote({ accounts = 0, holdings = 0 } = {}, { capitalised = true, sentence = true } = {}) {
  const parts = [];
  if (accounts) {
    parts.push(`${accounts} ${accounts === 1 ? 'account' : 'accounts'} in another currency that ${accounts === 1 ? 'has' : 'have'} no AED conversion yet`);
  }
  if (holdings) {
    parts.push(`${holdings} ${holdings === 1 ? 'holding' : 'holdings'} that ${holdings === 1 ? 'has' : 'have'} never been valued`);
  }
  if (parts.length === 0) return null;
  return `${capitalised ? 'Excludes' : 'excludes'} ${parts.join(', and ')}${sentence ? '.' : ''}`;
}

export function liquidAssets(accounts, scopeMemberId) {
  return visibleAccounts(accounts, scopeMemberId)
    .filter((a) => LIQUID_TYPES.has(a.type))
    .reduce((sum, a) => sum + scopedValue(accountValueAed(a) ?? 0, a, scopeMemberId), 0);
}
