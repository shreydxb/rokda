import { describe, expect, it } from 'vitest';
import { describeCost, describeIncome, nativeAmountLabel } from './planRows';

describe('planRows', () => {
  it('shows a rupee or dollar amount in its own currency, and nothing for dirhams', () => {
    expect(nativeAmountLabel({ currency: 'INR', amount: 4350000 })).toBe('₹43,50,000');
    expect(nativeAmountLabel({ currency: 'USD', amount: 1200 })).toBe('$1,200');
    expect(nativeAmountLabel({ currency: 'AED', amount: 1200 })).toBeNull();
  });

  it('says when other income starts, how long it pays, and whether it lowers the target', () => {
    expect(describeIncome({ kind: 'yearly', starts_after_years: 0, lasts_years: null }, null)).toBe('From the first year, for good · lowers the target');
    expect(describeIncome({ kind: 'yearly', starts_after_years: 2, lasts_years: 1 }, null)).toBe('From 2 years in, for 1 year');
    expect(describeIncome({ kind: 'lump_sum', starts_after_years: 0 }, null)).toBe('One-off, in the first year of independence');
    expect(describeIncome({ kind: 'lump_sum', in_year: 2044 }, null)).toBe('Paid in 2044 · counted on the Life plan in that year');
    expect(describeIncome({ kind: 'yearly', currency: 'INR' }, null)).toMatch(/^Not counted/);
  });

  it('says who a cost is for, how it rises, and when it runs', () => {
    expect(describeCost({ per_person: true, rise_pct: '3', starts_after_years: 0, lasts_years: null }, null)).toBe(
      'Each person · rising 3% a year above inflation · from the year work stops, for good'
    );
    expect(describeCost({ per_person: false, rise_pct: '0', starts_after_years: 5, lasts_years: 10 }, null)).toBe(
      'The household · level in today’s money · from 5 years after work stops, for 10 years'
    );
    expect(describeCost({ currency: 'INR', amount: 1 }, { inr_per_aed: 25 })).toMatch(/^The household/);
    expect(describeCost({ currency: 'INR', amount: 1 }, null)).toMatch(/^Not counted/);
  });
});
