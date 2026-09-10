import { describe, it, expect } from 'vitest';
import { portfolioDayChange, portfolioInvestedAndGain } from './holdings';

describe('portfolioDayChange', () => {
  it('weights each holding change by its value, not a flat average', () => {
    const holdings = [
      { id: 'h1', value_aed: 20000, day_change_pct: 10, is_shared: true },
      { id: 'h2', value_aed: 1000, day_change_pct: -50, is_shared: true },
    ];
    const result = portfolioDayChange(holdings, null);
    expect(result.available).toBe(true);
    // h1: prev ~18181.8, gained ~1818.2. h2: prev 2000, lost 1000.
    expect(result.absolute).toBeCloseTo(818.2, 0);
  });

  it('excludes holdings with no day_change_pct rather than treating them as flat', () => {
    const holdings = [
      { id: 'h1', value_aed: 10000, day_change_pct: 5, is_shared: true },
      { id: 'h2', value_aed: 50000, day_change_pct: null, is_shared: true },
    ];
    const result = portfolioDayChange(holdings, null);
    expect(result.available).toBe(true);
    expect(result.absolute).toBeCloseTo(476.19, 1);
  });

  it('is unavailable when nothing has a day change yet', () => {
    const result = portfolioDayChange([{ id: 'h1', value_aed: 100, day_change_pct: null, is_shared: true }], null);
    expect(result.available).toBe(false);
  });
});

describe('portfolioInvestedAndGain', () => {
  it('sums invested and P&L across holdings that actually carry a cost basis', () => {
    const holdings = [
      { id: 'h1', value_aed: 12000, invested_value_aed: 10000, is_shared: true },
      { id: 'h2', value_aed: 5000, invested_value_aed: 4000, is_shared: true },
    ];
    const result = portfolioInvestedAndGain(holdings, null);
    expect(result).toMatchObject({ available: true, invested: 14000, absolute: 3000 });
    expect(result.pct).toBeCloseTo(3000 / 14000, 5);
  });

  it('excludes holdings with no real invested figure rather than guessing', () => {
    const holdings = [
      { id: 'h1', value_aed: 12000, invested_value_aed: 10000, is_shared: true },
      { id: 'h2', value_aed: 5000, invested_value_aed: null, is_shared: true },
    ];
    const result = portfolioInvestedAndGain(holdings, null);
    expect(result.invested).toBe(10000);
    expect(result.absolute).toBe(2000);
  });

  it('is unavailable when no holding has an invested figure', () => {
    const result = portfolioInvestedAndGain([{ id: 'h1', value_aed: 100, invested_value_aed: null, is_shared: true }], null);
    expect(result.available).toBe(false);
  });
});
