// Synced copy of src/lib/valuation.js (only the never-valued check is used
// server-side) -- see scope.js in this same directory for why.

// A holding nothing has ever put a number on. holdings.value_aed is `not null
// default 0`, so a row created before its first price refresh stores a zero
// that nobody asserted -- and a zero that means "unknown" is not the same fact
// as a zero that means "this is worth nothing" (QA #6). priced_at is set only
// when a valuation is actually confirmed, by a person or by the price feed,
// and was backfilled for every legacy row, so null here really does mean
// never.
export function isAwaitingFirstValuation(holding) {
  return !!holding && holding.priced_at == null;
}
