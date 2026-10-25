import { describe, it, expect } from 'vitest';
import { annualSpendByCategory, basisChoice, budgetInputs, budgetPlan, closedMonths, forecastInputs, incomeInYear, incomesFromStop, incomesWithoutRate, monthKeyLabel, payMonthTransactions, planningMonths, recordsFromOptions, scenarioSets, spendThatStops } from './forecast';

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
    expect(sets.custom.meta).not.toMatch(/not set/i);
  });

  it('a Custom figure saved blank follows Baseline, not 0', () => {
    const sets = scenarioSets(
      { nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4, custom_nominal_return_pct: 9, custom_inflation_pct: null, custom_safe_withdrawal_pct: null, custom_updated_at: '2026-08-01T00:00:00Z' },
      DEFAULTS,
    );
    expect(sets.custom.nominalPct).toBe(9);
    expect(sets.custom.inflationPct).toBe(2.5);
  });
});

// SHR-252 (762a6c4 recheck): closedMonths had its own income/spend split that
// still classified purely by sign, so the plan disagreed with Overview about
// the same expense+refund pair. Ported from the QA document.
describe('SHR-252: the plan treats refunds the same as Overview', () => {
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

describe('other income once work stops', () => {
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
    expect(scenarioSets(null).baseline).toMatchObject({ saved: false, meta: 'Defaults, nothing saved', nominalPct: 6, inflationPct: 2.5 });
    // A row another editor created holds the same figures, and is not saved.
    expect(scenarioSets({ nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4, retirement_year: 2050 }).baseline.meta).toBe('Defaults, nothing saved');
    expect(scenarioSets({ nominal_return_pct: 7, inflation_pct: 3, safe_withdrawal_pct: 4, assumptions_saved_at: '2026-10-23T09:00:00Z' }).baseline).toMatchObject({
      saved: true,
      meta: 'Your saved assumptions',
      nominalPct: 7,
    });
  });
});
