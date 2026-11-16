import { describe, it, expect } from 'vitest';
import { changeToday, holdingTableRows, priceFreshness, seriesInRange, seriesShortOf, stalePrice } from './investmentsView';

// 16 November 2026, midday.
const NOW = new Date(2026, 10, 16, 12);
const RECENT = '2026-11-15T14:00:00Z';
const OLD = '2026-09-20T09:00:00Z';
const holding = (id, extra = {}) => ({ id, name: id, value_aed: 1000, invested_value_aed: 800, asset_class: 'us_equity', is_shared: true, priced_at: RECENT, trades_version: 0, quantity: 10, ...extra });

describe('stalePrice', () => {
  it('is a price the feed failed to refresh, or one confirmed 30 days ago or more', () => {
    expect(stalePrice(holding('fresh'), NOW)).toBe(false);
    expect(stalePrice(holding('failing', { price_provider: 'twelvedata', price_fetch_error: 'Not found' }), NOW)).toBe(true);
    expect(stalePrice(holding('old', { priced_at: OLD }), NOW)).toBe(true);
  });

  // Never valued is its own state ("Not valued yet"), not an old price.
  it('is not a holding that has never been valued', () => {
    expect(stalePrice(holding('new', { priced_at: null, value_aed: 0 }), NOW)).toBe(false);
  });
});

describe('priceFreshness', () => {
  it('gives the feed’s last run, the oldest valuation, the live feeds and what needs a look, over the holdings still held', () => {
    const f = priceFreshness(
      [
        holding('A', { price_provider: 'twelvedata', price_fetched_at: '2026-11-16T02:00:00Z', priced_at: RECENT }),
        holding('B', { price_provider: 'yahoo', price_fetched_at: '2026-11-15T02:00:00Z', price_fetch_error: 'Not found', priced_at: '2026-11-10T09:00:00Z' }),
        holding('Manual', { priced_at: OLD, last_refreshed: '2026-11-01T02:00:00Z' }),
        holding('New', { priced_at: null, value_aed: 0 }),
        holding('Sold', { trades_version: 3, quantity: 0, priced_at: '2026-01-01T00:00:00Z', price_provider: 'yahoo', price_fetch_error: 'Delisted' }),
      ],
      NOW,
    );
    expect(f.lastRefreshed.toISOString()).toBe('2026-11-16T02:00:00.000Z');
    expect(f.oldestPricedAt.toISOString()).toBe('2026-09-20T09:00:00.000Z');
    expect(f.liveFeeds).toBe(2);
    expect(f.neverPriced).toBe(1);
    expect(f.failing.map((h) => h.id)).toEqual(['B']);
    expect(f.stale.map((h) => h.id)).toEqual(['B', 'Manual']);
  });

  it('has no dates when nothing has been refreshed or valued', () => {
    expect(priceFreshness([holding('New', { priced_at: null, value_aed: 0 })], NOW)).toMatchObject({ lastRefreshed: null, oldestPricedAt: null, liveFeeds: 0, neverPriced: 1, failing: [], stale: [] });
  });
});

// The fresh review of 5b: a failing feed leaves its last change behind,
// which isn't today's; the rows show a dash for it, and so does the total.
describe('changeToday', () => {
  it('leaves out a holding whose feed failed, as its row does', () => {
    const fresh = holding('Fresh', { value_aed: 1100, day_change_pct: 10 });
    const failing = holding('Failing', { value_aed: 5000, day_change_pct: 5, price_provider: 'yahoo', price_fetch_error: 'Not found' });
    const c = changeToday([fresh, failing], null);
    expect(c.available).toBe(true);
    expect(c.absolute).toBeCloseTo(100);
    expect(changeToday([failing], null).available).toBe(false);
  });
});

describe('holdingTableRows', () => {
  it('lists the holdings largest first, each with its share of the total and its profit on cost', () => {
    const rows = holdingTableRows([holding('Small', { value_aed: 1000, invested_value_aed: 800 }), holding('Large', { value_aed: 3000, invested_value_aed: 3500 })], null);
    expect(rows.map((r) => [r.holding.id, r.value, r.invested, r.share])).toEqual([
      ['Large', 3000, 3500, 0.75],
      ['Small', 1000, 800, 0.25],
    ]);
    expect(rows[0].gain).toEqual({ absolute: -500, pct: -500 / 3500 });
  });

  // A never-valued holding's stored 0 is a placeholder (QA #6): no value, no
  // share and no profit, and it sorts last.
  it('gives a holding not valued yet no value, share or profit, after the rest', () => {
    const rows = holdingTableRows([holding('New', { priced_at: null, value_aed: 0 }), holding('A')], null);
    expect(rows.map((r) => [r.holding.id, r.value, r.share, r.gain])).toEqual([
      ['A', 1000, 1, { absolute: 200, pct: 0.25 }],
      ['New', null, null, null],
    ]);
  });

  it('counts one person their own holdings and half the shared ones', () => {
    const rows = holdingTableRows([holding('Shared', { value_aed: 2000, invested_value_aed: 1000 }), holding('Mine', { is_shared: false, owner_member_id: 'm1', value_aed: 1000, invested_value_aed: null })], 'm1');
    expect(rows.map((r) => [r.holding.id, r.value, r.invested, r.share, r.gain])).toEqual([
      ['Shared', 1000, 500, 0.5, { absolute: 500, pct: 1 }],
      ['Mine', 1000, null, 0.5, null],
    ]);
  });
});

describe('seriesInRange', () => {
  const day = (iso) => new Date(`${iso}T00:00:00`);
  const series = [
    { date: day('2026-05-01'), total: 100 },
    { date: day('2026-10-20'), total: 110 },
    { date: day('2026-11-12'), total: 120 },
    { date: NOW, total: 125, isLive: true },
  ];

  it('keeps the points from the range’s start, and today', () => {
    expect(seriesInRange(series, '1M', NOW).map((p) => p.total)).toEqual([110, 120, 125]);
    expect(seriesInRange(series, '1W', NOW).map((p) => p.total)).toEqual([120, 125]);
  });

  it('draws the whole record when the range holds too little to draw', () => {
    expect(seriesInRange([series[0], series[3]], '1W', NOW).map((p) => p.total)).toEqual([100, 125]);
  });
});

describe('seriesShortOf', () => {
  it('names each holding some day of the series left out, once', () => {
    expect(seriesShortOf([{ missing: ['Sukuk'] }, { missing: ['Sukuk', 'Gold'] }, { missing: [] }, {}])).toEqual(['Sukuk', 'Gold']);
  });
});
