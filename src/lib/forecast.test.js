import { describe, it, expect } from 'vitest';
import { closedMonths, crossingYear, drawdownPath, fiTarget, futureValue, incomeInYear, independenceTarget, potForWithdrawal, projectYears, realReturn, requiredAnnualSaving, scenarioSets, sustainableWithdrawal } from './forecast';

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

describe('projectYears: the projection, split into its parts', () => {
  const args = { startNetWorth: 200000, annualSaving: 60000, rate: 0.035, inflationPct: 2.5 };

  it('matches futureValue year for year, in both modes', () => {
    for (const mode of ['real', 'nominal']) {
      const path = projectYears({ ...args, mode, years: 30 });
      for (const p of path) {
        expect(p.value).toBeCloseTo(futureValue(p.yearsOut, args.rate, args.startNetWorth, args.annualSaving, mode, args.inflationPct), 6);
      }
    }
  });

  it('splits every year into start + saved + growth', () => {
    for (const p of projectYears({ ...args, mode: 'nominal', years: 30 })) {
      expect(p.start + p.saved + p.growth).toBeCloseTo(p.value, 6);
    }
  });

  it('counts saving at face value in real mode and grown with inflation in nominal', () => {
    expect(projectYears({ ...args, mode: 'real', years: 2 })[2].saved).toBe(120000);
    expect(projectYears({ ...args, mode: 'nominal', years: 1 })[1].saved).toBeCloseTo(61500, 6);
  });

  it('shows growth on a negative start as a cost, not a gain', () => {
    const path = projectYears({ startNetWorth: -50000, annualSaving: 0, rate: 0.05, mode: 'real', inflationPct: 0, years: 1 });
    expect(path[1].growth).toBeCloseTo(-2500, 6);
  });
});

describe('requiredAnnualSaving: what a chosen independence year takes', () => {
  const base = { startNetWorth: 150000, rate: realReturn(6, 2.5), inflationPct: 2.5, goal: 2000000 };

  it('reaches the goal in exactly the chosen year, and a unit less does not', () => {
    for (const mode of ['real', 'nominal']) {
      const years = 18;
      const monthly = Math.ceil(requiredAnnualSaving({ ...base, mode, years }) / 12);
      const cross = (saving) => crossingYear({ ...base, startYear: 2026, annualSaving: saving * 12, mode });
      expect(cross(monthly)).toBe(2026 + years);
      expect(cross(monthly - 1)).toBe(2026 + years + 1);
    }
  });

  it("gives the same figure in today's money and nominal terms", () => {
    const real = requiredAnnualSaving({ ...base, mode: 'real', years: 20 });
    const nominal = requiredAnnualSaving({ ...base, rate: 0.06, mode: 'nominal', years: 20 });
    expect(nominal).toBeCloseTo(real, 4);
  });

  it('is zero when growth alone gets there, and null with no year to solve', () => {
    expect(requiredAnnualSaving({ ...base, startNetWorth: 1900000, mode: 'real', years: 10 })).toBe(0);
    expect(requiredAnnualSaving({ ...base, mode: 'real', years: 0 })).toBeNull();
  });
});

describe('drawdown: how long a pot lasts', () => {
  it('covers whole years and then runs out', () => {
    // 100 at 0% paying 30 a year: three full years, a fourth only in part.
    const { path, lastsYears } = drawdownPath({ start: 100, annualWithdrawal: 30, rate: 0, maxYears: 10 });
    expect(lastsYears).toBe(3);
    expect(path[4].withdrawn).toBe(10);
    expect(path[5].balance).toBe(0);
  });

  it('never runs out when growth outpaces spending', () => {
    const { lastsYears, path } = drawdownPath({ start: 1000000, annualWithdrawal: 20000, rate: 0.04, maxYears: 60 });
    expect(lastsYears).toBeNull();
    expect(path[60].balance).toBeGreaterThan(1000000);
  });

  it('agrees with the closed form for how long a pot lasts', () => {
    // n = −ln(1 − P·r / (w·(1+r))) / ln(1+r): 25× spend at a 3.4% real return
    // covers 51 full years.
    const rate = realReturn(6, 2.5);
    const n = -Math.log(1 - (25 * rate) / (1 + rate)) / Math.log(1 + rate);
    const { lastsYears } = drawdownPath({ start: 25 * 40000, annualWithdrawal: 40000, rate, maxYears: 80 });
    expect(lastsYears).toBe(Math.floor(n));
    expect(lastsYears).toBe(51);
  });

  it('the sustainable withdrawal empties the pot in exactly that many years', () => {
    const rate = realReturn(6, 2.5);
    for (const years of [20, 30, 45]) {
      const w = sustainableWithdrawal({ start: 1000000, rate, years });
      expect(drawdownPath({ start: 1000000, annualWithdrawal: w * 0.999999, rate, maxYears: 60 }).lastsYears).toBe(years);
      expect(drawdownPath({ start: 1000000, annualWithdrawal: w * 1.001, rate, maxYears: 60 }).lastsYears).toBe(years - 1);
      expect(potForWithdrawal({ annualWithdrawal: w, rate, years })).toBeCloseTo(1000000, 4);
    }
  });

  it('handles a zero return and an empty pot', () => {
    expect(sustainableWithdrawal({ start: 300000, rate: 0, years: 30 })).toBe(10000);
    expect(potForWithdrawal({ annualWithdrawal: 10000, rate: 0, years: 30 })).toBe(300000);
    expect(drawdownPath({ start: 0, annualWithdrawal: 1000, rate: 0.03 }).lastsYears).toBe(0);
    expect(sustainableWithdrawal({ start: -5, rate: 0.03, years: 10 })).toBe(0);
  });
});

describe('other income in independence', () => {
  const rent = { kind: 'yearly', amount: 20000, starts_after_years: 0, lasts_years: null };
  const laterWork = { kind: 'yearly', amount: 10000, starts_after_years: 2, lasts_years: 3 };
  const gratuity = { kind: 'lump_sum', amount: 90000, starts_after_years: 1, lasts_years: null };

  it('pays yearly income from its start, for its duration, and a lump sum once', () => {
    const incomes = [rent, laterWork, gratuity];
    expect(incomeInYear(incomes, 0)).toEqual({ yearly: 20000, lump: 0 });
    expect(incomeInYear(incomes, 1)).toEqual({ yearly: 20000, lump: 90000 });
    expect(incomeInYear(incomes, 2).yearly).toBe(30000);
    expect(incomeInYear(incomes, 4).yearly).toBe(30000);
    expect(incomeInYear(incomes, 5).yearly).toBe(20000);
  });

  it('lowers the target only by lasting income from day one, and counts the rest', () => {
    const { target, lastingIncome, otherCount } = independenceTarget(60000, 4, [rent, laterWork, gratuity]);
    expect(lastingIncome).toBe(20000);
    expect(target).toBe(fiTarget(40000, 4));
    expect(otherCount).toBe(2);
    expect(independenceTarget(60000, 4, []).target).toBe(fiTarget(60000, 4));
    // Income beyond spending leaves nothing to fund, not a negative target.
    expect(independenceTarget(10000, 4, [rent]).target).toBe(0);
  });

  it('spends income before the pot', () => {
    // 100 pot, spending 30, with 20 a year of rent: the pot pays 10 a year.
    const { path, lastsYears } = drawdownPath({ start: 100, annualWithdrawal: 30, rate: 0, maxYears: 12, incomes: [{ ...rent, amount: 20 }] });
    expect(path[1].withdrawn).toBe(10);
    expect(path[1].income).toBe(20);
    expect(lastsYears).toBe(10);
  });

  it('adds a lump sum and surplus income to the pot', () => {
    const { path } = drawdownPath({ start: 100, annualWithdrawal: 30, rate: 0, maxYears: 3, incomes: [{ ...gratuity, amount: 50 }, { ...rent, amount: 40 }] });
    // Year 1: 40 of income covers 30 of spend, 10 goes in. Year 2: plus 50.
    expect(path[1].balance).toBe(110);
    expect(path[2].balance).toBe(170);
  });

  it('solves the spend and the pot with income, and agrees with the path', () => {
    const rate = realReturn(6, 2.5);
    const incomes = [rent, laterWork, gratuity];
    const w = sustainableWithdrawal({ start: 800000, rate, years: 40, incomes });
    expect(drawdownPath({ start: 800000, annualWithdrawal: w, rate, maxYears: 60, incomes }).lastsYears ?? 99).toBeGreaterThanOrEqual(40);
    expect(drawdownPath({ start: 800000, annualWithdrawal: w + 5, rate, maxYears: 60, incomes }).lastsYears).toBeLessThan(40);
    const pot = potForWithdrawal({ annualWithdrawal: 70000, rate, years: 40, incomes });
    expect(drawdownPath({ start: pot, annualWithdrawal: 70000, rate, maxYears: 60, incomes }).lastsYears ?? 99).toBeGreaterThanOrEqual(40);
    expect(drawdownPath({ start: pot - 5, annualWithdrawal: 70000, rate, maxYears: 60, incomes }).lastsYears).toBeLessThan(40);
  });

  it('needs no pot when income covers the spending', () => {
    expect(potForWithdrawal({ annualWithdrawal: 15000, rate: 0.03, years: 30, incomes: [rent] })).toBe(0);
  });
});
