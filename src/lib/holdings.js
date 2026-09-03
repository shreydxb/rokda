import { scopedValue } from './scope';

export const ASSET_CLASS_LABELS = {
  us_equity: 'US equity',
  intl_equity: 'Intl. equity',
  uae_equity: 'UAE equity',
  india_equity: 'India equity',
  india_mf: 'India MF',
  crypto: 'Crypto',
  sukuk: 'Sukuk',
  cash: 'Cash',
};

const GROUPS = {
  us_equity: 'Global',
  intl_equity: 'Global',
  uae_equity: 'UAE',
  india_equity: 'India',
  india_mf: 'India',
  crypto: 'Crypto',
  sukuk: 'Sukuk',
  cash: 'Cash',
};

export function groupOf(assetClass) {
  return GROUPS[assetClass] ?? 'Other';
}

export const GROUP_ORDER = ['All', 'Global', 'UAE', 'India', 'Crypto', 'Sukuk', 'Cash'];

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
export const RANGES = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '5Y'];

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
// value (from history) and current value, scoped, then diffs the totals —
// so shared holdings split correctly and the result is value-weighted.
// Returns null if none of the holdings have history reaching that far back
// (rather than silently computing from a partial, misleading subset).
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

// Chart series: portfolio total at each historical date any holding has a
// point for, plus the live "now" total.
export function portfolioSeries(holdings, history, scopeMemberId, now = new Date()) {
  const dates = [...new Set(history.map((p) => p.as_of))].sort();
  const series = dates.map((d) => {
    const dateObj = new Date(d);
    let total = 0;
    for (const h of holdings) {
      const raw = valueAsOf(history, h.id, dateObj);
      if (raw !== null) total += scopedValue(raw, h, scopeMemberId);
    }
    return { date: dateObj, total };
  });
  series.push({
    date: now,
    total: holdings.reduce((s, h) => s + scopedHoldingValue(h, scopeMemberId), 0),
    isLive: true,
  });
  return series;
}
