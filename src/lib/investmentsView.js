import { holdingGain, isClosedHolding, portfolioDayChange, rangeStartDate, scopedHoldingValue, scopedInvestedValue } from './holdings';
import { isAwaitingFirstValuation, isStale } from './valuation';

// Wealth -> Investments' own figures (the revamp, phase 5b;
// design/prototype invKpis, invChart, holdingsCard and the Prices stamp):
// how fresh the prices are, the holdings table's rows, and the stretch of the
// value history a range draws. The portfolio's sums are lib/holdings.js's.

// A price that needs a look: the feed failed to refresh it, or it was last
// confirmed 30 days ago or more (lib/valuation.js isStale). A holding never
// valued is its own state ("Not valued yet"), not an old price.
export function stalePrice(holding, now = new Date()) {
  if (holding.price_provider && holding.price_fetch_error) return true;
  return Boolean(holding.priced_at) && isStale(holding, now);
}

// What the Prices stamp says and its popover holds, over the holdings still
// held: the feed skips a sold-out holding, so its last price only ages, and
// counting it would call the portfolio stale for good.
//   lastRefreshed  when the feed last ran (price_fetched_at; older rows have
//                  only last_refreshed), which is not how old its prices are:
//                  those carry the exchange's quote time in priced_at
//                  (docs/decisions.md, "A price is as old as its quote")
//   oldestPricedAt the oldest valuation: a portfolio is only as fresh as its
//                  stalest holding (QA-04)
//   liveFeeds      holdings on a live feed
//   neverPriced    holdings no price has reached yet
//   failing        holdings whose last refresh failed
//   stale          holdings whose price needs a look (stalePrice)
export function priceFreshness(holdings, now = new Date()) {
  const held = holdings.filter((h) => !isClosedHolding(h));
  let lastRefreshed = null;
  let oldestPricedAt = null;
  for (const h of held) {
    const ran = h.price_fetched_at ?? h.last_refreshed;
    if (ran && (!lastRefreshed || new Date(ran) > lastRefreshed)) lastRefreshed = new Date(ran);
    if (h.priced_at && (!oldestPricedAt || new Date(h.priced_at) < oldestPricedAt)) oldestPricedAt = new Date(h.priced_at);
  }
  return {
    lastRefreshed,
    oldestPricedAt,
    liveFeeds: held.filter((h) => h.price_provider).length,
    neverPriced: held.filter((h) => !h.priced_at).length,
    failing: held.filter((h) => h.price_provider && h.price_fetch_error),
    stale: held.filter((h) => stalePrice(h, now)),
  };
}

// Change today, from each holding's own move (lib/holdings.js
// portfolioDayChange), leaving out a holding whose feed failed: the change
// it left behind isn't today's, and its row shows a dash (the fresh review of
// 5b).
export function changeToday(holdings, scopeMemberId = null) {
  return portfolioDayChange(
    holdings.filter((h) => !(h.price_provider && h.price_fetch_error)),
    scopeMemberId,
  );
}

// The holdings table, largest first: each holding's value, cost and profit
// for the person in view (their own and half the shared ones), and its share
// of the total. A holding not valued yet stores 0 because the column demands
// a number (QA #6): it has no value, share or profit, and comes last.
export function holdingTableRows(holdings, scopeMemberId = null) {
  const rows = holdings.map((h) => {
    const pending = isAwaitingFirstValuation(h);
    return { holding: h, value: pending ? null : scopedHoldingValue(h, scopeMemberId), invested: scopedInvestedValue(h, scopeMemberId), gain: holdingGain(h, scopeMemberId) };
  });
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  return rows
    .map((r) => ({ ...r, share: r.value === null || !(total > 0) ? null : r.value / total }))
    .sort((a, b) => (a.value === null) - (b.value === null) || (b.value ?? 0) - (a.value ?? 0));
}

// The points a range draws: from its start, and today's. A range that holds
// fewer than two draws the whole record instead, rather than nothing.
export function seriesInRange(series, range, now = new Date()) {
  const start = rangeStartDate(range, now);
  const inRange = series.filter((p) => p.date >= start || p.isLive);
  return inRange.length >= 2 ? inRange : series;
}

// The holdings some day of a series is drawn without, having no value
// recorded then (outside review, B-06), each named once.
export function seriesShortOf(series) {
  return [...new Set(series.flatMap((p) => p.missing ?? []))];
}
