import { describe, it, expect } from 'vitest';
import { annualSpendByCategory, basisChoice, budgetInputs, budgetPlan, closedMonths, crossingYear, drawdownPath, fiTarget, forecastInputs, futureValue, incomeInYear, incomesFromStop, incomesWithoutRate, independenceTarget, MARKET_FALL, marketReturns, monthKeyLabel, payMonthTransactions, planningMonths, recordsFromOptions, potForWithdrawal, projectYears, realReturn, requiredAnnualSaving, scenarioSets, spendThatStops, sustainableWithdrawal } from './forecast';

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

  it('a Custom figure saved blank follows Baseline, not 0', () => {
    const sets = scenarioSets(
      { nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4, custom_nominal_return_pct: 9, custom_inflation_pct: null, custom_safe_withdrawal_pct: null, custom_updated_at: '2026-08-01T00:00:00Z' },
      DEFAULTS,
    );
    expect(sets.custom.nominalPct).toBe(9);
    expect(sets.custom.inflationPct).toBe(2.5);
    expect(sets.custom.swrPct).toBe(4);
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

describe('a market fall while drawing down', () => {
  const rate = 0.03;
  const base = { start: 1000000, annualWithdrawal: 50000, rate, maxYears: 60 };

  it('a steady market is exactly the path without returns', () => {
    expect(marketReturns(rate, null)).toBeNull();
    expect(drawdownPath({ ...base, returns: null })).toEqual(drawdownPath(base));
  });

  it('puts the fall in the chosen year and the steady return everywhere else', () => {
    const r = marketReturns(rate, 10, 60);
    expect(r).toHaveLength(60);
    expect(r[8]).toBe(rate);
    expect(r[9]).toBe(MARKET_FALL[0]);
    expect(r[10]).toBe(MARKET_FALL[1]);
    expect(r[11]).toBe(rate);
  });

  it('applies the fall to what is left after the year’s spending', () => {
    const { path } = drawdownPath({ ...base, returns: marketReturns(rate, 1) });
    // 1,000,000 less 50,000 = 950,000, then 20% down.
    expect(path[1].balance).toBeCloseTo(760000, 6);
    expect(path[1].rate).toBe(-0.2);
    expect(path[1].growth).toBeCloseTo(-190000, 6);
    // 760,000 less 50,000 = 710,000, then 10% down.
    expect(path[2].balance).toBeCloseTo(639000, 6);
  });

  it('the same fall costs more years early than late', () => {
    const steady = drawdownPath(base).lastsYears;
    const early = drawdownPath({ ...base, returns: marketReturns(rate, 1) }).lastsYears;
    const late = drawdownPath({ ...base, returns: marketReturns(rate, 10) }).lastsYears;
    expect(early).toBeLessThan(late);
    expect(late).toBeLessThan(steady);
  });

  it('the solvers answer for the fall, and invert each other', () => {
    const returns = marketReturns(rate, 1);
    const steadyMax = sustainableWithdrawal({ start: 1000000, rate, years: 30 });
    const w = sustainableWithdrawal({ start: 1000000, rate, years: 30, returns });
    expect(w).toBeLessThan(steadyMax);
    // Spending that much, the pot lasts the 30 years and not much more.
    const { lastsYears } = drawdownPath({ start: 1000000, annualWithdrawal: w, rate, maxYears: 30, returns });
    expect(lastsYears === null || lastsYears >= 30).toBe(true);
    const pot = potForWithdrawal({ annualWithdrawal: w, rate, years: 30, returns });
    expect(Math.abs(pot - 1000000)).toBeLessThan(50);
  });

  it('finds the pot for other income when the return is below inflation', () => {
    // A negative real return used to cap the search at spend × years, too
    // small a pot for any return that loses money.
    const incomes = [{ kind: 'lump_sum', amount: 1000, starts_after_years: 5 }];
    const pot = potForWithdrawal({ annualWithdrawal: 10000, rate: -0.02, years: 20, incomes });
    expect(pot).toBeGreaterThan(10000 * 20);
    const { lastsYears } = drawdownPath({ start: pot, annualWithdrawal: 10000, rate: -0.02, maxYears: 20, incomes });
    expect(lastsYears === null || lastsYears >= 20).toBe(true);
  });

  it('finds the pot even when the return is negative every year', () => {
    const returns = marketReturns(-0.05, 1);
    const pot = potForWithdrawal({ annualWithdrawal: 10000, rate: -0.05, years: 20, returns });
    const { lastsYears } = drawdownPath({ start: pot, annualWithdrawal: 10000, rate: -0.05, maxYears: 20, returns });
    expect(lastsYears === null || lastsYears >= 20).toBe(true);
    expect(drawdownPath({ start: pot - 100, annualWithdrawal: 10000, rate: -0.05, maxYears: 20, returns }).lastsYears).toBeLessThan(20);
  });
});

describe('budgetPlan and the budget standing in for history', () => {
  const now = new Date(2026, 8, 27); // 27 Sep 2026
  const cats = [
    { id: 'rent', kind: 'expense', is_savings: false },
    { id: 'food', kind: 'expense', is_savings: false },
    { id: 'save', kind: 'expense', is_savings: true },
    { id: 'pay', kind: 'income', is_savings: false },
  ];
  const b = (category_id, year, month, amount) => ({ category_id, year, month, amount: String(amount) });
  const everyMonth2026 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((m) => [b('rent', 2026, m, 6000), b('food', 2026, m, 2000), b('save', 2026, m, 1500), b('pay', 2026, m, 20000)]);

  it('averages spending and the savings target from this month forward, leaving out income budgets', () => {
    expect(budgetPlan(everyMonth2026, cats, now)).toEqual({ monthlySpend: 8000, monthlySaving: 1500, monthCount: 4 });
  });

  it('reads the months ahead, not the past', () => {
    const rows = [b('rent', 2026, 3, 99000), b('rent', 2026, 10, 5000), b('rent', 2026, 11, 7000)];
    expect(budgetPlan(rows, cats, now)).toEqual({ monthlySpend: 6000, monthlySaving: 0, monthCount: 2 });
  });

  it('falls back to the latest past months when nothing ahead is budgeted', () => {
    const rows = [b('rent', 2025, 1, 1000), ...[3, 4, 5].map((m) => b('rent', 2026, m, 3000))];
    const plan = budgetPlan(rows, cats, now);
    expect(plan.monthCount).toBe(4);
    expect(plan.monthlySpend).toBe(2500);
  });

  it('is null with no spending budget', () => {
    expect(budgetPlan([], cats, now)).toBeNull();
    expect(budgetPlan([b('save', 2026, 10, 500)], cats, now)).toBeNull();
  });

  const septemberOnly = [{ id: 't1', amount: -900, kind: 'expense', occurred_at: '2026-09-03', is_shared: true }];

  it('stands in for fewer than three closed months, and says so', () => {
    const plan = budgetPlan(everyMonth2026, cats, now);
    const inputs = forecastInputs(septemberOnly, 100000, now, plan);
    expect(inputs).toMatchObject({ ready: true, source: 'budget', monthCount: 0, budgetMonths: 4, annualSpend: 96000, monthlySaving: 1500, avgMonthlyIncome: 9500 });
  });

  it('steps aside once three months have closed', () => {
    const history = [6, 7, 8].flatMap((m) => [
      { id: `i${m}`, amount: 10000, kind: 'income', occurred_at: `2026-0${m}-05`, is_shared: true },
      { id: `s${m}`, amount: -4000, kind: 'expense', occurred_at: `2026-0${m}-06`, is_shared: true },
    ]);
    const inputs = forecastInputs(history, 100000, now, budgetPlan(everyMonth2026, cats, now));
    expect(inputs).toMatchObject({ ready: true, source: 'actual', annualSpend: 48000, monthlySaving: 6000 });
  });

  it('still needs a net worth to start from, and a budget to stand in', () => {
    expect(forecastInputs(septemberOnly, null, now, budgetPlan(everyMonth2026, cats, now)).ready).toBe(false);
    expect(forecastInputs(septemberOnly, 100000, now, null)).toMatchObject({ ready: false, source: null });
  });

  // Planning audit, 2.9: the household chooses the basis.
  describe('the chosen basis', () => {
    // June to August ended, saving 6,000 a month; the budget saves 1,500.
    const history = [6, 7, 8].flatMap((m) => [
      { id: `i${m}`, amount: 10000, kind: 'income', occurred_at: `2026-0${m}-05`, is_shared: true },
      { id: `s${m}`, amount: -4000, kind: 'expense', occurred_at: `2026-0${m}-06`, is_shared: true },
    ]);
    const plan = budgetPlan(everyMonth2026, cats, now);
    const inputs = (choice, p = plan, txns = history) => forecastInputs(txns, 100000, now, p, [], choice);

    it('reads the choice from the saved assumptions, and nothing else as one', () => {
      expect(basisChoice({ planning_basis: 'budget', records_from: '2026-07-01' })).toEqual({ basis: 'budget', recordsFrom: '2026-07' });
      expect(basisChoice({ planning_basis: 'forecast' })).toEqual({ basis: null, recordsFrom: null });
      expect(basisChoice(null)).toEqual({ basis: null, recordsFrom: null });
    });

    it('keeps the budget once chosen, however many months have ended', () => {
      expect(inputs({ basis: 'budget' })).toMatchObject({ source: 'budget', why: 'chosen', monthlySaving: 1500, monthCount: 3 });
    });

    it('takes the records once chosen, or with nothing chosen, and says which', () => {
      expect(inputs({ basis: 'recorded' })).toMatchObject({ source: 'actual', why: 'chosen', monthlySaving: 6000 });
      expect(inputs({})).toMatchObject({ source: 'actual', why: 'not-chosen', monthlySaving: 6000 });
    });

    it('lets the other stand in when the chosen one cannot be used, and says why', () => {
      // The budget chosen, with no budget set: the records, said as standing in.
      expect(inputs({ basis: 'budget' }, null)).toMatchObject({ source: 'actual', why: 'no-budget' });
      expect(inputs({ basis: 'budget' }, null, septemberOnly)).toMatchObject({ ready: false, why: 'no-budget' });
      // The records chosen, with fewer than three ended: the budget, until then.
      expect(inputs({ basis: 'recorded' }, plan, septemberOnly)).toMatchObject({ source: 'budget', why: 'few-months', basis: 'recorded' });
    });

    it('offers every month from the first recorded to this one to count from, newest first', () => {
      expect(recordsFromOptions(['2026-06', '2026-07', '2026-08'], now)).toEqual(['2026-09', '2026-08', '2026-07', '2026-06']);
      expect(recordsFromOptions([], now)).toEqual(['2026-09']);
      expect(monthKeyLabel('2026-10')).toBe('Oct 2026');
    });

    it('counts records only from the month chosen, and lists every ended month to choose from', () => {
      // From July, two months have ended: too few, so the budget stands in.
      expect(inputs({ basis: 'recorded', recordsFrom: '2026-07' })).toMatchObject({ source: 'budget', why: 'few-months', monthCount: 2, recordedMonths: ['2026-06', '2026-07', '2026-08'] });
      const earlier = [{ id: 'i5', amount: 1000, kind: 'income', occurred_at: '2026-05-05', is_shared: true }, ...history];
      // May recorded in part reads as saving everything; from June it is left out.
      expect(inputs({ basis: 'recorded' }, plan, earlier).monthCount).toBe(4);
      expect(inputs({ basis: 'recorded', recordsFrom: '2026-06' }, plan, earlier)).toMatchObject({ monthCount: 3, monthlySaving: 6000, months: ['2026-06', '2026-07', '2026-08'] });
    });
  });
});

describe('incomesFromStop', () => {
  it('converts rupee income at today\'s rate, and leaves out sums paid in a set year and rows it cannot convert', () => {
    const rows = [
      { id: 'r', name: 'Flat rent', kind: 'yearly', amount: 260_000, currency: 'INR', starts_after_years: 0 },
      { id: 'g', name: 'Gratuity', kind: 'lump_sum', amount: 32_740, starts_after_years: 0 },
      { id: 'l', name: 'LIC', kind: 'lump_sum', amount: 4_350_000, currency: 'INR', in_year: 2044 },
    ];
    expect(incomesFromStop(rows, { inr_per_aed: 26 }).map((r) => [r.id, r.amount])).toEqual([
      ['r', 10_000],
      ['g', 32_740],
    ]);
    expect(incomesFromStop(rows, { inr_per_aed: null }).map((r) => r.id)).toEqual(['g']);
  });
});

describe('spendThatStops', () => {
  const now = new Date(2026, 8, 27);
  const categories = [
    { id: 'rent', name: 'Rent', kind: 'expense', stops_after_work: true },
    { id: 'emi', name: 'Car EMI', kind: 'expense', stops_after_work: true },
    { id: 'food', name: 'Groceries', kind: 'expense' },
    { id: 'save', name: 'Savings', kind: 'expense', is_savings: true, stops_after_work: true },
  ];

  it('reads the budget while it stands in, over the same months', () => {
    const budgets = [9, 10].flatMap((month) => [
      { category_id: 'rent', year: 2026, month, amount: 5850 },
      { category_id: 'emi', year: 2026, month, amount: 2193 },
      { category_id: 'food', year: 2026, month, amount: 2000 },
      { category_id: 'save', year: 2026, month, amount: 3000 },
    ]);
    const inputs = { ready: true, source: 'budget' };
    const result = spendThatStops({ inputs, budgets, categories, now });
    expect(result.categories).toEqual([
      { id: 'rent', name: 'Rent', annual: 70_200 },
      { id: 'emi', name: 'Car EMI', annual: 26_316 },
    ]);
    expect(result.annual).toBe(96_516);
    // Savings are not spending, stopped or not.
    expect(annualSpendByCategory({ inputs, budgets, categories, now }).has('save')).toBe(false);
  });

  it('reads the last closed months once there are three', () => {
    const transactions = [6, 7, 8].flatMap((m) => [
      { id: `r${m}`, amount: -5850, kind: 'expense', category_id: 'rent', occurred_at: `2026-0${m}-06`, is_shared: true },
      { id: `f${m}`, amount: -2000, kind: 'expense', category_id: 'food', occurred_at: `2026-0${m}-10`, is_shared: true },
    ]);
    // The open month is not counted.
    transactions.push({ id: 'now', amount: -9999, kind: 'expense', category_id: 'rent', occurred_at: '2026-09-06', is_shared: true });
    const inputs = forecastInputs(transactions, 0, now);
    expect(inputs.months).toEqual(['2026-06', '2026-07', '2026-08']);
    const result = spendThatStops({ inputs, transactions, categories, now });
    expect(result.annual).toBeCloseTo(70_200, 6);
  });

  it('is nothing until the inputs are ready', () => {
    expect(spendThatStops({ inputs: { ready: false }, categories, now })).toEqual({ annual: 0, categories: [], byCategory: new Map() });
  });
});

describe('payMonthTransactions: a salary counts in the month it is for', () => {
  const salary = { id: 'r', amount: 24000, cadence: 'monthly', next_due_date: '2026-09-30', account_id: 'fab', category_id: 'sal', active: true };
  const tx = (id, day, over = {}) => ({ id, amount: 24000, kind: 'income', account_id: 'fab', category_id: 'sal', occurred_at: day, is_shared: true, ...over });

  it('moves a salary that landed early in the next month back to its month', () => {
    const [t] = payMonthTransactions([tx('a', '2026-11-01')], [salary]);
    expect(t.pay_month_date).toBe('2026-10-30');
    // October gets it, November does not.
    const months = closedMonths(payMonthTransactions([tx('a', '2026-11-01')], [salary]), new Date(2026, 11, 15));
    expect([...months.keys()]).toEqual(['2026-10']);
  });

  it('moves a salary paid early into the previous month forward to its own', () => {
    // Due 31 Jan (clamped from the 30th anchor), paid on the 24th: January either way.
    expect(payMonthTransactions([tx('a', '2027-01-24')], [salary])[0].pay_month_date).toBeUndefined();
    // Due 1 Mar from a 1st-of-month schedule, paid 26 Feb: counted in March.
    const firstOfMonth = { ...salary, next_due_date: '2026-10-01' };
    expect(payMonthTransactions([tx('b', '2027-02-26')], [firstOfMonth])[0].pay_month_date).toBe('2027-03-01');
  });

  it('leaves alone income that matches no reminder, and spending', () => {
    const other = [tx('c', '2026-11-01', { account_id: 'wio' }), tx('d', '2026-11-01', { amount: 9000 }), { ...tx('e', '2026-11-01'), kind: 'expense', amount: -24000 }];
    expect(payMonthTransactions(other, [salary]).map((t) => t.pay_month_date)).toEqual([undefined, undefined, undefined]);
    expect(payMonthTransactions(other, [])).toBe(other);
  });

  // Where the records begin, moving pay made a month with no spending, or a
  // month with no pay (Planning audit, 0b-D).
  const spend = (id, day, amount = -8000, over = {}) => ({ id, amount, kind: 'expense', account_id: 'fab', category_id: 'groc', occurred_at: day, is_shared: true, ...over });
  const recorded = (months) => [...months.keys()];

  it('never counts pay for the month before the first record', () => {
    // Records start in August. July's salary landed on 1 August.
    const txns = [tx('s0', '2026-08-01'), tx('s1', '2026-08-30'), tx('s2', '2026-09-30'), tx('s3', '2026-10-30'), spend('a', '2026-08-05'), spend('b', '2026-09-05'), spend('c', '2026-10-05')];
    const months = planningMonths(txns, [salary], new Date(2026, 10, 15));
    expect(recorded(months)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect([...months.values()].map((m) => m.income)).toEqual([24000, 24000, 24000]);
    const inputs = forecastInputs(txns, 0, new Date(2026, 10, 15), null, [salary]);
    expect(inputs.monthCount).toBe(3);
    expect(inputs.monthlySaving).toBe(16000);
  });

  it('leaves out a first month whose pay landed before the records began', () => {
    // Paid on the 28th for the month after. July's pay landed in June.
    const firstOfMonth = { ...salary, next_due_date: '2026-10-01' };
    const txns = [tx('s1', '2026-07-28'), tx('s2', '2026-08-28'), tx('s3', '2026-09-28'), spend('a', '2026-07-05'), spend('b', '2026-08-05'), spend('c', '2026-09-05'), spend('d', '2026-10-05'), tx('s4', '2026-10-28')];
    const months = planningMonths(txns, [firstOfMonth], new Date(2026, 10, 15));
    expect(recorded(months)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(forecastInputs(txns, 0, new Date(2026, 10, 15), null, [firstOfMonth]).monthlySaving).toBe(16000);
  });

  it('keeps a first month that has its own pay', () => {
    const firstOfMonth = { ...salary, next_due_date: '2026-10-01' };
    // July's pay on 1 July, August's on 28 July.
    const txns = [tx('s0', '2026-07-01'), tx('s1', '2026-07-28'), tx('s2', '2026-08-28'), spend('a', '2026-07-05'), spend('b', '2026-08-05'), spend('c', '2026-09-05')];
    expect(recorded(planningMonths(txns, [firstOfMonth], new Date(2026, 9, 15)))).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('takes a category\'s spending over the same months as all spending', () => {
    const rent = (id, day) => spend(id, day, -3000, { category_id: 'rent' });
    const txns = [tx('s0', '2026-08-01'), tx('s1', '2026-08-30'), tx('s2', '2026-09-30'), tx('s3', '2026-10-30'), spend('a', '2026-08-05', -5000), spend('b', '2026-09-05', -5000), spend('c', '2026-10-05', -5000), rent('r1', '2026-08-01'), rent('r2', '2026-09-01'), rent('r3', '2026-10-01')];
    const categories = [
      { id: 'groc', kind: 'expense', name: 'Groceries' },
      { id: 'rent', kind: 'expense', name: 'Rent', stops_after_work: true },
    ];
    const now = new Date(2026, 10, 15);
    const inputs = forecastInputs(txns, 0, now, null, [salary]);
    // Three months of 8,000, not four with a phantom month of nothing spent.
    expect(inputs.annualSpend).toBe(96000);
    expect(spendThatStops({ inputs, transactions: txns, categories, now }).annual).toBe(36000);
  });

  it('keeps each month at one salary when payday wanders across the month end', () => {
    const txns = [tx('s1', '2026-08-28'), tx('s2', '2026-10-01'), tx('s3', '2026-10-29')];
    const months = closedMonths(payMonthTransactions(txns, [salary]), new Date(2026, 10, 15));
    expect([...months.entries()].map(([k, v]) => [k, v.income])).toEqual([
      ['2026-08', 24000],
      ['2026-09', 24000],
      ['2026-10', 24000],
    ]);
  });
});

describe('incomesWithoutRate', () => {
  it('names the rows in a currency with no rate to AED', () => {
    const rows = [
      { id: 'a', currency: 'AED' },
      { id: 'b', currency: 'INR' },
      { id: 'c', currency: 'USD' },
      { id: 'd' },
    ];
    expect(incomesWithoutRate(rows, { inr_per_aed: null }).map((r) => r.id)).toEqual(['b']);
    expect(incomesWithoutRate(rows, { inr_per_aed: 25 })).toEqual([]);
  });
});

// Planning audit, 1.2: the budget's answer stays in view once records take over.
describe('budgetInputs', () => {
  const plan = { monthlySpend: 4000, monthlySaving: 2000, monthCount: 2 };

  it('gives the budget\'s figures however many months are recorded', () => {
    expect(budgetInputs(plan, 100000, 5)).toEqual({
      ready: true,
      source: 'budget',
      monthCount: 5,
      budgetMonths: 2,
      hasNetWorth: true,
      avgMonthlyIncome: 6000,
      avgMonthlySpend: 4000,
      annualSpend: 48000,
      monthlySaving: 2000,
      startNetWorth: 100000,
    });
  });

  it('is what forecastInputs stands in with before three months end', () => {
    expect(forecastInputs([], 100000, new Date(2026, 9, 20), plan)).toMatchObject({ ...budgetInputs(plan, 100000, 0), why: 'few-months' });
  });

  it('has nothing to give without a budget or a starting point', () => {
    expect(budgetInputs(null, 100000)).toBeNull();
    expect(budgetInputs(plan, null)).toBeNull();
  });
});

// Planning audit, 1.3: a row of defaults is not a choice.
describe('scenarioSets: saved or defaults', () => {
  it('calls Baseline the defaults until the assumptions drawer has saved', () => {
    expect(scenarioSets(null).baseline).toMatchObject({ saved: false, meta: 'Defaults, nothing saved', nominalPct: 6, inflationPct: 2.5, swrPct: 4 });
    // A row another editor created holds the same figures, and is not saved.
    expect(scenarioSets({ nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4, retirement_year: 2050 }).baseline.meta).toBe('Defaults, nothing saved');
    expect(scenarioSets({ nominal_return_pct: 7, inflation_pct: 3, safe_withdrawal_pct: 4, assumptions_saved_at: '2026-10-23T09:00:00Z' }).baseline).toMatchObject({
      saved: true,
      meta: 'Your saved assumptions',
      nominalPct: 7,
    });
  });
});
