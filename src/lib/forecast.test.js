import { describe, it, expect } from 'vitest';
import { closedMonths, scenarioSets } from './forecast';

const DEFAULTS = { nominal_return_pct: 6.0, inflation_pct: 2.5, safe_withdrawal_pct: 4.0 };

describe('scenarioSets', () => {
  it('falls back to app defaults with no saved assumptions', () => {
    const sets = scenarioSets(null, DEFAULTS);
    expect(sets.baseline.nominalPct).toBe(6.0);
    expect(sets.baseline.inflationPct).toBe(2.5);
  });

  it('derives Conservative and Optimistic as offsets from Baseline', () => {
    const sets = scenarioSets({ nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4 }, DEFAULTS);
    expect(sets.conservative.nominalPct).toBe(4);
    expect(sets.conservative.inflationPct).toBe(3.5);
    expect(sets.optimistic.nominalPct).toBe(8);
    expect(sets.optimistic.inflationPct).toBe(1.5);
  });

  it('never derives a negative Conservative return or Optimistic inflation', () => {
    const sets = scenarioSets({ nominal_return_pct: 1, inflation_pct: 0.5, safe_withdrawal_pct: 4 }, DEFAULTS);
    expect(sets.conservative.nominalPct).toBe(0);
    expect(sets.optimistic.inflationPct).toBe(0);
  });

  it('Custom mirrors Baseline until it has its own saved values', () => {
    const sets = scenarioSets({ nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4 }, DEFAULTS);
    expect(sets.custom.nominalPct).toBe(6);
    expect(sets.custom.meta).toMatch(/not set/i);
  });

  it('Custom uses its own saved values once set', () => {
    const sets = scenarioSets(
      {
        nominal_return_pct: 6,
        inflation_pct: 2.5,
        safe_withdrawal_pct: 4,
        custom_nominal_return_pct: 7.5,
        custom_inflation_pct: 3,
        custom_safe_withdrawal_pct: 3.5,
        custom_updated_at: '2026-08-01T00:00:00Z',
      },
      DEFAULTS,
    );
    expect(sets.custom.nominalPct).toBe(7.5);
    expect(sets.custom.inflationPct).toBe(3);
    expect(sets.custom.swrPct).toBe(3.5);
    expect(sets.custom.meta).not.toMatch(/not set/i);
  });
});

// SHR-252 (762a6c4 recheck): closedMonths had its own income/spend split that
// still classified purely by sign, so Forecast disagreed with Overview about
// the same expense+refund pair. Ported from the QA document.
describe('SHR-252: Forecast treats refunds the same as Overview', () => {
  it('nets an expense and its refund to income 0, spend 0 for that month', () => {
    const rows = [
      { amount: -100, kind: 'expense', occurred_at: '2026-08-05', is_shared: true, category_id: 'c' },
      { amount: 100, kind: 'refund', occurred_at: '2026-08-06', is_shared: true, category_id: 'c' },
    ];
    const months = closedMonths(rows, new Date(2026, 8, 6));
    expect([...months.values()][0]).toEqual({ income: 0, spend: 0 });
  });

  it('still counts real income and real spend normally', () => {
    const rows = [
      { amount: 500, kind: 'income', occurred_at: '2026-08-01', is_shared: true },
      { amount: -200, kind: 'expense', occurred_at: '2026-08-02', is_shared: true },
    ];
    const months = closedMonths(rows, new Date(2026, 8, 6));
    expect([...months.values()][0]).toEqual({ income: 500, spend: 200 });
  });
});
