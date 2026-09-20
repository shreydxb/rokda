import { describe, it, expect } from 'vitest';
import { holdingGain, portfolioDayChange, portfolioInvestedAndGain, portfolioValueChange } from './holdings';

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
  // priced_at is on every fixture here on purpose. It was backfilled for every
  // legacy row (docs/holdings-priced-at-migration.md), so null genuinely means
  // "never valued" rather than "old row" -- and a fixture without it is now a
  // holding awaiting its first valuation, which is a different case with its
  // own tests below.
  const PRICED = '2026-09-01T00:00:00Z';

  it('sums invested and P&L across holdings that actually carry a cost basis', () => {
    const holdings = [
      { id: 'h1', value_aed: 12000, invested_value_aed: 10000, is_shared: true, priced_at: PRICED },
      { id: 'h2', value_aed: 5000, invested_value_aed: 4000, is_shared: true, priced_at: PRICED },
    ];
    const result = portfolioInvestedAndGain(holdings, null);
    expect(result).toMatchObject({ available: true, invested: 14000, absolute: 3000 });
    expect(result.pct).toBeCloseTo(3000 / 14000, 5);
  });

  it('excludes holdings with no real invested figure rather than guessing', () => {
    const holdings = [
      { id: 'h1', value_aed: 12000, invested_value_aed: 10000, is_shared: true, priced_at: PRICED },
      { id: 'h2', value_aed: 5000, invested_value_aed: null, is_shared: true, priced_at: PRICED },
    ];
    const result = portfolioInvestedAndGain(holdings, null);
    expect(result.invested).toBe(10000);
    expect(result.absolute).toBe(2000);
  });

  it('is unavailable when no holding has an invested figure', () => {
    const result = portfolioInvestedAndGain([{ id: 'h1', value_aed: 100, invested_value_aed: null, is_shared: true, priced_at: PRICED }], null);
    expect(result.available).toBe(false);
  });
});

// QA #5: this figure was called `portfolioGain` and rendered as a gain with a
// ▲ and a percentage. It is a difference of two market values, which is not
// the same thing, and the gap is not academic -- a deposit shows up as
// profit. The name, the flag and the label on the screen now say so; the
// arithmetic cannot be fixed without dated cash flows.
describe('QA #5: portfolio value change is not investment return', () => {
  const RANGE = '1M';
  const now = new Date('2026-09-20T00:00:00Z');
  const startAsOf = '2026-08-01'; // comfortably before the 1M window opens

  function holding(value) {
    return { id: 'h1', value_aed: value, is_shared: true };
  }

  it('reports a deposit at an unchanged price as a change in value, flagged as such', () => {
    // Worth 10,000 at the range start; 5,000 added since, price flat.
    const history = [{ holding_id: 'h1', as_of: startAsOf, value_aed: 10_000 }];
    const result = portfolioValueChange([holding(15_000)], history, RANGE, null, now);
    expect(result.absolute).toBe(5_000);
    expect(result.pct).toBe(0.5);
    // The investments earned nothing. The only honest thing the function can
    // do about that is refuse to call the number a gain.
    expect(result.includesContributions).toBe(true);
  });

  it('reports a withdrawal as a fall in value, not a loss, and flags it the same way', () => {
    const history = [{ holding_id: 'h1', as_of: startAsOf, value_aed: 10_000 }];
    const result = portfolioValueChange([holding(6_000)], history, RANGE, null, now);
    expect(result.absolute).toBe(-4_000);
    expect(result.includesContributions).toBe(true);
  });

  it('still reports a genuine price move correctly', () => {
    const history = [{ holding_id: 'h1', as_of: startAsOf, value_aed: 10_000 }];
    const result = portfolioValueChange([holding(11_000)], history, RANGE, null, now);
    expect(result.absolute).toBe(1_000);
    expect(result.pct).toBeCloseTo(0.1, 10);
  });

  it('refuses a partial answer when a holding has no history that far back', () => {
    const history = [{ holding_id: 'h1', as_of: startAsOf, value_aed: 10_000 }];
    const holdings = [holding(11_000), { id: 'h2', value_aed: 5_000, is_shared: true }];
    const result = portfolioValueChange(holdings, history, RANGE, null, now);
    expect(result.available).toBe(false);
    expect(result.absolute).toBeNull();
    // Even the unavailable shape carries the flag, so a caller cannot render
    // one branch with the caveat and the other without it.
    expect(result.includesContributions).toBe(true);
  });

  it('splits a shared holding the same way every other scoped figure does', () => {
    const shared = { id: 'h1', value_aed: 15_000, is_shared: true };
    const history = [{ holding_id: 'h1', as_of: startAsOf, value_aed: 10_000 }];
    const result = portfolioValueChange([shared], history, RANGE, 'm1', now);
    expect(result.nowTotal).toBe(7_500);
    expect(result.startTotal).toBe(5_000);
    expect(result.absolute).toBe(2_500);
  });
});

// QA #6: holdings.value_aed is `not null default 0`, so a holding created
// before its first price refresh stores a zero nobody asserted. Measuring
// that placeholder against a real cost basis reported a total loss on a
// brand-new holding.
describe('QA #6: a never-valued holding has no gain to report', () => {
  const PRICED = '2026-09-19T00:00:00Z';

  it('reports no gain rather than a 100% loss before the first price arrives', () => {
    const pending = { id: 'h1', value_aed: 0, invested_value_aed: 10_000, is_shared: true, priced_at: null };
    expect(holdingGain(pending, null)).toBeNull();
  });

  it('reports the real loss once a price has actually been recorded', () => {
    const priced = { id: 'h1', value_aed: 0, invested_value_aed: 10_000, is_shared: true, priced_at: PRICED };
    // A genuine wipeout is still a wipeout -- the fix suppresses the
    // unasserted zero, not a measured one.
    expect(holdingGain(priced, null)).toEqual({ absolute: -10_000, pct: -1 });
  });

  it('reports an ordinary gain unchanged', () => {
    const priced = { id: 'h1', value_aed: 12_000, invested_value_aed: 10_000, is_shared: true, priced_at: PRICED };
    expect(holdingGain(priced, null)).toEqual({ absolute: 2_000, pct: 0.2 });
  });
});

// QA #6 reached the individual holding row and stopped there. holdingGain
// refuses to compare a placeholder zero against a cost basis; the aggregate
// one level up kept doing exactly that.
describe('a holding awaiting its first valuation is not a loss', () => {
  const priced = {
    id: 'h1', is_shared: true, owner_member_id: null,
    value_aed: 12000, invested_value_aed: 10000, priced_at: '2026-09-01T00:00:00Z',
  };
  // value_aed is 0 because the column is not null, not because it is worthless.
  const pending = {
    id: 'h2', is_shared: true, owner_member_id: null,
    value_aed: 0, invested_value_aed: 10000, priced_at: null,
  };

  it('does not report a 100% loss on a brand-new holding', () => {
    const gain = portfolioInvestedAndGain([pending], null);
    // Old behaviour: invested 10000, value 0, absolute -10000, pct -1.
    expect(gain.available).toBe(false);
    expect(gain.absolute).toBe(0);
    expect(gain.pct).toBeNull();
    expect(gain.pending).toBe(1);
  });

  it('leaves it out of a portfolio that also holds priced positions', () => {
    const gain = portfolioInvestedAndGain([priced, pending], null);
    expect(gain.available).toBe(true);
    expect(gain.invested).toBe(10000);
    expect(gain.absolute).toBe(2000);
    expect(gain.pct).toBeCloseTo(0.2);
    // Reported, not silently dropped: the figure omits a holding.
    expect(gain.pending).toBe(1);
  });

  it('counts nothing pending once every holding is valued', () => {
    expect(portfolioInvestedAndGain([priced], null).pending).toBe(0);
  });

  it('still ignores holdings with no cost basis at all', () => {
    const noBasis = { ...priced, id: 'h3', invested_value_aed: null };
    const gain = portfolioInvestedAndGain([priced, noBasis], null);
    expect(gain.invested).toBe(10000);
    expect(gain.pending).toBe(0);
  });
});
