// Synced copy of src/lib/holdings.js -- see scope.js in this same directory
// for why. Extended beyond the original trim (visibleHoldings,
// scopedHoldingValue only) to cover what the Telegram assistant's
// get_holdings tool needs: gain/loss, allocation by class, and range
// performance against holding_value_history.
import { scopedValue } from './scope.js';

const GROUPS = {
  us_equity: 'Global',
  intl_equity: 'Global',
  uae_equity: 'UAE',
  india_equity: 'India',
  india_mf: 'India',
  crypto: 'Crypto',
  sukuk: 'Sukuk',
  cash: 'Cash',
  commodity: 'Commodities',
};

export function groupOf(assetClass) {
  return GROUPS[assetClass] ?? 'Other';
}

export function visibleHoldings(holdings, scopeMemberId, group) {
  return holdings.filter((h) => {
    if (!(scopeMemberId === null || h.is_shared || h.owner_member_id === scopeMemberId)) return false;
    if (group && group !== 'All' && groupOf(h.asset_class) !== group) return false;
    return true;
  });
}

export function scopedHoldingValue(holding, scopeMemberId) {
  return scopedValue(holding.value_aed, holding, scopeMemberId);
}

export function scopedInvestedValue(holding, scopeMemberId) {
  if (holding.invested_value_aed == null) return null;
  return scopedValue(holding.invested_value_aed, holding, scopeMemberId);
}

// P&L in absolute AED and percent -- null when there's no real invested
// figure to compare against (most holdings today, until entered manually or
// backed by a real broker import), rather than guessing a cost basis.
export function holdingGain(holding, scopeMemberId) {
  const invested = scopedInvestedValue(holding, scopeMemberId);
  if (invested === null || invested === 0) return null;
  const value = scopedHoldingValue(holding, scopeMemberId);
  const absolute = value - invested;
  return { absolute, pct: absolute / invested };
}

export function allocationByClass(holdings, scopeMemberId) {
  const totals = new Map();
  let grandTotal = 0;
  for (const h of holdings) {
    const v = scopedHoldingValue(h, scopeMemberId);
    totals.set(h.asset_class, (totals.get(h.asset_class) ?? 0) + v);
    grandTotal += v;
  }
  return [...totals.entries()]
    .map(([assetClass, value]) => ({ assetClass, value, share: grandTotal > 0 ? value / grandTotal : 0 }))
    .sort((a, b) => b.value - a.value);
}

const RANGE_DAYS = { '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825 };

export function rangeStartDate(range, now = new Date()) {
  if (range === 'YTD') return new Date(now.getFullYear(), 0, 1);
  const days = RANGE_DAYS[range];
  return new Date(now.getTime() - days * 86400000);
}

// Value of one holding as of the closest history point at/before `date`.
// Returns null if no history point exists that early (range not covered).
function valueAsOf(history, holdingId, date) {
  const points = history.filter((p) => p.holding_id === holdingId && new Date(p.as_of) <= date);
  if (points.length === 0) return null;
  return points.reduce((latest, p) => (new Date(p.as_of) > new Date(latest.as_of) ? p : latest)).value_aed;
}

// Portfolio-level gain over a range: sums each visible holding's start
// value (from history) and current value, scoped, then diffs the totals --
// so shared holdings split correctly and the result is value-weighted.
// Returns available:false if any holding lacks history reaching that far
// back, rather than silently computing from a partial, misleading subset.
export function portfolioGain(holdings, history, range, scopeMemberId, now = new Date()) {
  const startDate = rangeStartDate(range, now);
  let startTotal = 0;
  let nowTotal = 0;
  let coveredCount = 0;
  for (const h of holdings) {
    const startRaw = valueAsOf(history, h.id, startDate);
    const nowValue = scopedHoldingValue(h, scopeMemberId);
    nowTotal += nowValue;
    if (startRaw !== null) {
      coveredCount += 1;
      startTotal += scopedValue(startRaw, h, scopeMemberId);
    }
  }
  if (coveredCount === 0 || coveredCount < holdings.length) {
    return { available: coveredCount > 0 && coveredCount === holdings.length, nowTotal, startTotal: null, absolute: null, pct: null };
  }
  const absolute = nowTotal - startTotal;
  const pct = startTotal > 0 ? absolute / startTotal : null;
  return { available: true, nowTotal, startTotal, absolute, pct };
}
