import { scopedValue } from './scope';
import { isAwaitingFirstValuation } from './valuation';

export const ASSET_CLASS_LABELS = {
  us_equity: 'US equity',
  intl_equity: 'Intl. equity',
  uae_equity: 'UAE equity',
  india_equity: 'India equity',
  india_mf: 'India MF',
  crypto: 'Crypto',
  sukuk: 'Sukuk',
  cash: 'Cash',
  commodity: 'Commodity',
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
  commodity: 'Commodities',
};

export function groupOf(assetClass) {
  return GROUPS[assetClass] ?? 'Other';
}

export const GROUP_ORDER = ['All', 'Global', 'UAE', 'India', 'Crypto', 'Commodities', 'Sukuk', 'Cash'];

export function visibleHoldings(holdings, scopeMemberId, group) {
  return holdings.filter((h) => {
    if (!(scopeMemberId === null || h.is_shared || h.owner_member_id === scopeMemberId)) return false;
    if (group && group !== 'All' && groupOf(h.asset_class) !== group) return false;
    return true;
  });
}

// A holding sold down to nothing after its trade history started: kept, so
// its sales and what they made stay on record, but no longer one of the
// holdings the household has (SHR-367). A holding never traded is edited by
// hand, and a zero there is just a figure someone typed, not a sale.
export function isClosedHolding(holding) {
  return Number(holding?.trades_version) > 0 && holding.quantity != null && Number(holding.quantity) === 0;
}

export function scopedHoldingValue(holding, scopeMemberId) {
  return scopedValue(holding.value_aed, holding, scopeMemberId);
}

// The currencies the database can turn into AED: as is, at the peg, or at
// the household's rupee rate (holdings_derive_cost).
const COST_CURRENCIES = new Set(['AED', 'USD', 'INR']);

// Whether a holding's AED cost is worked out from its units and average price
// rather than typed in. With both, in a currency Rokda converts, the database
// sets it on every save and whenever the rupee rate moves, so a cost entered
// alongside them would be overwritten (docs/decisions.md, "A holding's cost is
// its units at their average price").
export function costFromUnits({ quantity, avg_price, currency } = {}) {
  const filled = (v) => v != null && String(v).trim() !== '' && Number.isFinite(Number(v));
  return filled(quantity) && filled(avg_price) && COST_CURRENCIES.has(String(currency ?? '').toUpperCase());
}

export function scopedInvestedValue(holding, scopeMemberId) {
  if (holding.invested_value_aed == null) return null;
  return scopedValue(holding.invested_value_aed, holding, scopeMemberId);
}

// P&L in absolute AED and percent — null when there's no real invested
// figure to compare against (most holdings today, until entered manually or
// backed by a real broker import), rather than guessing a cost basis.
export function holdingGain(holding, scopeMemberId) {
  // A holding that has never been valued stores 0 because the column demands
  // a number, not because it is worth nothing. Comparing that placeholder
  // against a real cost basis reported a 100% loss on a brand-new holding
  // (QA #6). There is no valuation to compare, so there is no gain to report.
  if (isAwaitingFirstValuation(holding)) return null;
  const invested = scopedInvestedValue(holding, scopeMemberId);
  if (invested === null || invested === 0) return null;
  const value = scopedHoldingValue(holding, scopeMemberId);
  const absolute = value - invested;
  return { absolute, pct: absolute / invested };
}

// Portfolio-level "change today" from each holding's own day_change_pct
// (set by the nightly price-refresh, straight from the price provider) --
// weighted by scoped value, so a big holder moving 1% counts for more than
// a small one moving 5%. Holdings with no day_change_pct (never
// auto-priced, or the day's refresh failed) are excluded from both the
// weighted total and the base it's a percentage of, rather than treated as
// flat -- a silent flat 0% would understate real movement.
export function portfolioDayChange(holdings, scopeMemberId) {
  let priced = 0;
  let absolute = 0;
  let baseValue = 0;
  for (const h of holdings) {
    if (h.day_change_pct == null) continue;
    priced += 1;
    const value = scopedHoldingValue(h, scopeMemberId);
    const changeFraction = h.day_change_pct / 100;
    // value = yesterday's value * (1 + change); solve back for yesterday's.
    const prevValue = value / (1 + changeFraction);
    absolute += value - prevValue;
    baseValue += prevValue;
  }
  if (priced === 0) return { available: false, absolute: 0, pct: null };
  return { available: true, absolute, pct: baseValue > 0 ? absolute / baseValue : null };
}

// Portfolio-wide invested total and P&L to date, from whichever holdings
// actually carry a real invested_value_aed -- never a guessed cost basis.
export function portfolioInvestedAndGain(holdings, scopeMemberId) {
  let invested = 0;
  let value = 0;
  let coveredCount = 0;
  let pending = 0;
  for (const h of holdings) {
    const inv = scopedInvestedValue(h, scopeMemberId);
    if (inv === null) continue;
    // The same placeholder zero holdingGain refuses to compare against, one
    // level up -- and the aggregate kept doing exactly what the row was fixed
    // to stop doing (QA #6). A holding with a real AED 10,000 cost basis and
    // no valuation yet contributed its whole cost as a loss, so one new
    // holding made the entire portfolio read -100%.
    //
    // Counted rather than silently dropped: a P&L figure that omits a holding
    // is incomplete, and the caller has to be able to say so.
    if (isAwaitingFirstValuation(h)) {
      pending += 1;
      continue;
    }
    coveredCount += 1;
    invested += inv;
    value += scopedHoldingValue(h, scopeMemberId);
  }
  if (coveredCount === 0) return { available: false, invested: 0, absolute: 0, pct: null, pending };
  const absolute = value - invested;
  return { available: true, invested, absolute, pct: invested > 0 ? absolute / invested : null, pending };
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

// A holding's market sector, tagged once in its editor (Planning audit,
// 4.17), in the editor's groups and order. The eleven market sectors, and
// the sectors an Indian broker's holdings statement gives its shares, so an
// Indian holding carries the same tag as the statement (docs/decisions.md,
// "Indian holdings keep their broker's sectors"). The statement's Energy is
// the market sector of that name. A fund spread across sectors is tagged
// broad: it is in no sector, and not a concentration on its own.
export const SECTOR_GROUPS = [
  {
    label: 'Market sectors',
    sectors: {
      technology: 'Technology',
      communication: 'Communication',
      consumer_discretionary: 'Consumer discretionary',
      consumer_staples: 'Consumer staples',
      energy: 'Energy',
      financials: 'Financials',
      health_care: 'Health care',
      industrials: 'Industrials',
      materials: 'Materials',
      real_estate: 'Real estate',
      utilities: 'Utilities',
    },
  },
  {
    label: "Indian broker's sectors",
    sectors: {
      software_services: 'Software services',
      financial_services: 'Financial services',
      defence: 'Defence',
      engineering_capital_goods: 'Engineering & capital goods',
      healthcare: 'Healthcare',
      auto_ancillary: 'Auto ancillary',
      automobile: 'Automobile',
      metals: 'Metals',
      chemicals: 'Chemicals',
      building_materials: 'Building materials',
      fmcg: 'FMCG',
      retail: 'Retail',
    },
  },
];
export const SECTOR_LABELS = {
  ...Object.assign({}, ...SECTOR_GROUPS.map((g) => g.sectors)),
  broad: 'Spread across sectors',
};

// Shares and share funds have a sector; cash, gold, crypto and sukuk do not,
// so they are never asked for one and count only on their own.
const SECTOR_CLASSES = new Set(['us_equity', 'intl_equity', 'uae_equity', 'india_equity', 'india_mf']);
export function hasSector(assetClass) {
  return SECTOR_CLASSES.has(assetClass);
}

// The most of the investments that sits in one place: the largest sector,
// from the holdings tagged with it, or the largest single holding, whichever
// is more (docs/decisions.md, "A concentration line on Wealth"). Cash is not
// an investment here, and a holding not valued yet counts nothing. A sector
// only wins when it is more than its largest holding, so one holding alone
// in its sector is named as itself. Against the household's cap, when one is
// set. Null when there is nothing invested; kind 'spread' when everything is
// in funds spread across sectors.
export function largestConcentration(holdings, scopeMemberId, capPct = null) {
  const invested = holdings.filter((h) => h.asset_class !== 'cash' && !isAwaitingFirstValuation(h));
  const total = invested.reduce((s, h) => s + scopedHoldingValue(h, scopeMemberId), 0);
  if (!(total > 0)) return null;
  const bySector = new Map();
  let holding = null;
  let untagged = 0;
  for (const h of invested) {
    const sector = hasSector(h.asset_class) ? (h.sector ?? null) : null;
    if (sector === 'broad') continue;
    const value = scopedHoldingValue(h, scopeMemberId);
    if (value <= 0) continue;
    if (!holding || value > holding.value) holding = { name: h.name, sector, value };
    if (sector) bySector.set(sector, (bySector.get(sector) ?? 0) + value);
    else if (hasSector(h.asset_class)) untagged += 1;
  }
  const cap = (share) => (Number(capPct) > 0 ? { pct: Number(capPct), above: share > Number(capPct) / 100 } : null);
  if (!holding) return { kind: 'spread', name: null, sector: null, value: 0, share: 0, total, untagged: 0, cap: cap(0) };
  const [sector, sectorValue] = [...bySector.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null, 0];
  const largest =
    sectorValue > holding.value
      ? { kind: 'sector', name: SECTOR_LABELS[sector] ?? sector, sector, value: sectorValue }
      : { kind: 'holding', name: holding.name, sector: holding.sector, value: holding.value };
  const share = largest.value / total;
  return { ...largest, share, total, untagged, cap: cap(share) };
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

// How much the portfolio's VALUE moved over a range: sums each visible
// holding's start value (from history) and current value, scoped, then diffs
// the totals -- so shared holdings split correctly and the result is
// value-weighted. Returns unavailable if any holding lacks history reaching
// that far back, rather than silently computing from a partial subset.
//
// This is not investment performance, and it was named `portfolioGain` and
// shown as a gain until QA #5 pointed out what that means in practice: start
// a range holding AED 10,000, add AED 5,000 at an unchanged price, and it
// reported +AED 5,000 / +50% when the investments earned nothing. A
// withdrawal becomes a "loss" the same way.
//
// The arithmetic is not fixable from here. Two market values cannot tell
// deposits apart from appreciation; a real return needs dated contributions
// and withdrawals, which nothing in this app records yet (holding_value_history
// stores values, not flows). So the function says what it actually computes,
// in its name and in the `includesContributions` flag every caller renders,
// rather than continuing to call a number a gain when it is not one.
export function portfolioValueChange(holdings, history, range, scopeMemberId, now = new Date()) {
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
    return { available: coveredCount > 0 && coveredCount === holdings.length, nowTotal, startTotal: null, absolute: null, pct: null, includesContributions: true };
  }
  const absolute = nowTotal - startTotal;
  const pct = startTotal > 0 ? absolute / startTotal : null;
  return { available: true, nowTotal, startTotal, absolute, pct, includesContributions: true };
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
