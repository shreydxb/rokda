// Synced copy of src/lib/holdings.js (trimmed to what overviewMath.js needs
// server-side) -- see scope.js in this same directory for why.
import { scopedValue } from './scope.js';

export function visibleHoldings(holdings, scopeMemberId, group) {
  return holdings.filter((h) => {
    if (!(scopeMemberId === null || h.is_shared || h.owner_member_id === scopeMemberId)) return false;
    if (group && group !== 'All' && h.asset_class !== group) return false;
    return true;
  });
}

export function scopedHoldingValue(holding, scopeMemberId) {
  return scopedValue(holding.value_aed, holding, scopeMemberId);
}
