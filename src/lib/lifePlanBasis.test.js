import { describe, it, expect } from 'vitest';
import { AFTER_WORK_RETURN_GAP, CASH_RETURN_DEFAULT, RUPEE_DRIFT, STRESS_FALLS, afterWorkReturn, agesLabel, costsText, defaultStopPerson, lifePlanBasis, lifePlanStop, loansInSpending, loansText, marketFall, membersLeftOut, planPeople, rangeText, rupeeDrift, spendAfterText, stopRange, stressTest } from './lifePlanBasis';
import { costInYear, costsAfterWork, earliestStop, lifePlan, potNeededAt } from './lifePlan';
import { MARKET_FALL, realReturn, scenarioSets } from './forecast';

// The same household as lifePlan.test.js, for the plan's basis: who it is
// for, loans, returns, the range, the stress test and the rupee.

const people = [
  { name: 'Partner A', birthYear: 1994, lifeExpectancy: 80 },
  { name: 'Partner B', birthYear: 1994, lifeExpectancy: 85 },
];

// A household like the adviser's, in today's money.
const base = {
  startYear: 2026,
  people,
  retireYear: 2054,
  startPot: 500_000,
  annualSaving: 60_000,
  preRate: realReturn(11, 7),
  postRate: realReturn(8.5, 7),
  retireSpend: 61_000,
  survivorPct: 100,
  goals: [],
  incomes: [],
};

describe('lifePlanStop: the one answer to when work can stop', () => {
  const members = [
    { id: 'm1', display_name: 'Partner A' },
    { id: 'm2', display_name: 'Partner B' },
  ];
  const memberLife = [
    { member_id: 'm1', birth_year: 1994, life_expectancy: 80 },
    { member_id: 'm2', birth_year: 1994, life_expectancy: 85 },
  ];
  const inputs = { ready: true, monthlySaving: 6000, annualSpend: 48000, source: 'history' };
  const args = { members, memberLife, assumptions: null, inputs, startNetWorth: 200_000, startYear: 2026 };

  it('is the first year the saved plan lasts, as the Life plan tab finds it', () => {
    const stop = lifePlanStop(args);
    const basis = lifePlanBasis({ ...args, people: planPeople(members, memberLife) });
    expect(stop.earliest).toBe(earliestStop(basis.args));
    expect(stop.endYear).toBe(2079);
    expect(agesLabel(stop.ages)).toBe(`Partner A ${stop.earliest - 1994} · Partner B ${stop.earliest - 1994}`);
    expect(lifePlan({ ...basis.args, retireYear: stop.earliest }).lasts).toBe(true);
  });

  it('carries what the answer assumes: spending after work stops, and whether the saved stop year lasts', () => {
    const stop = lifePlanStop(args);
    expect(stop).toMatchObject({ spend: 48000, spendKey: 'today', spendLabel: "Today's", lasts: true, shortYear: null });
    const short = lifePlanStop({ ...args, assumptions: { retirement_year: 2027, retirement_annual_spend: 500_000 } });
    expect(short).toMatchObject({ spend: 500_000, spendKey: 'planned', lasts: false });
    expect(short.shortYear).toBeGreaterThanOrEqual(2027);
  });

  it('says in words how spending after work stops was chosen', () => {
    const fmt = (v) => `AED ${v}`;
    expect(spendAfterText({ spend: 1, spendKey: 'planned', spendLabel: 'Planned' }, fmt)).toBe('spending AED 1 a year after work stops (your plan)');
    expect(spendAfterText({ spend: 1, spendKey: 'less', spendLabel: 'Less what stops' }, fmt)).toBe("spending AED 1 a year after work stops (today's, less what stops)");
    expect(spendAfterText({ spend: 1, spendKey: 'today', spendLabel: "Today's" }, fmt)).toBe('spending AED 1 a year after work stops (as today)');
    expect(spendAfterText({ spend: 1, spendKey: 'today', spendLabel: 'Budgeted' }, fmt)).toBe('spending AED 1 a year after work stops (as budgeted)');
    expect(spendAfterText({ spend: 1, spendKey: 'lean', spendLabel: 'Essentials' }, fmt)).toBe('spending AED 1 a year after work stops (essentials only)');
  });

  it('says when the stop year is assumed, and whose 60th birthday it is', () => {
    expect(lifePlanStop(args)).toMatchObject({ stopYear: 2054, stopAssumed: { name: 'Partner A' } });
    expect(lifePlanStop({ ...args, assumptions: { retirement_year: 2050 } })).toMatchObject({ stopYear: 2050, stopAssumed: null });
  });

  it('names a member the plan leaves out', () => {
    const stop = lifePlanStop({ ...args, memberLife: memberLife.slice(0, 1) });
    expect(stop.leftOut.map((m) => m.display_name)).toEqual(['Partner B']);
    expect(lifePlanStop(args).leftOut).toEqual([]);
  });

  it('has no answer until someone\'s age is set, or with nothing to project from', () => {
    expect(lifePlanStop({ ...args, memberLife: [] })).toBeNull();
    expect(lifePlanStop({ ...args, inputs: { ready: false } })).toBeNull();
  });
});

describe('defaultStopPerson and membersLeftOut', () => {
  it('takes the eldest, then the first by name, whatever order the roster comes in', () => {
    const a = { name: 'Partner A', birthYear: 1994 };
    const b = { name: 'Partner B', birthYear: 1990 };
    const c = { name: 'Partner C', birthYear: 1990 };
    expect(defaultStopPerson([a, b, c]).name).toBe('Partner B');
    expect(defaultStopPerson([c, a, b]).name).toBe('Partner B');
    expect(defaultStopPerson([])).toBeUndefined();
  });

  it('leaves out the members with no ages for the plan', () => {
    const members = [{ id: 'm1', display_name: 'Partner A' }, { id: 'm2', display_name: 'Partner B' }];
    expect(membersLeftOut(members, [{ member_id: 'm2' }])).toEqual([members[0]]);
    expect(membersLeftOut(members, [])).toEqual(members);
  });
});

// Planning audit, 2.10: a loan paid out of spending is counted there, once.

describe('loans counted once', () => {
  const now = new Date(2026, 9, 20);
  const loanAccount = { id: 'la', type: 'loan', currency: 'AED', balance: 12000, balance_aed: 12000, archived_at: null };
  const card = { id: 'cc', type: 'credit_card', currency: 'AED', balance: 3000, balance_aed: 3000, archived_at: null };
  // 12,000 at 0% and 1,000 a month: clears in 12 months, about Oct 2027.
  const car = { id: 'd1', name: 'Car loan', balance: 12000, apr_pct: 0, minimum_payment: 1000, account_id: 'la' };

  it('takes a loan whose instalment is spending, and leaves cards, transfers and loans that never clear alone', () => {
    const debts = [
      car,
      { id: 'd2', name: 'Card', balance: 3000, apr_pct: 30, minimum_payment: 200, account_id: 'cc' },
      { id: 'd3', name: 'Family loan', balance: 6000, apr_pct: 0, minimum_payment: 500, account_id: null },
      { id: 'd4', name: 'Never', balance: 50000, apr_pct: 24, minimum_payment: 500, account_id: null },
    ];
    const loans = loansInSpending({ debts, accounts: [loanAccount, card], now });
    expect(loans).toEqual([
      { id: 'd1', name: 'Car loan', balance: 12000, monthly: 1000, months: 12, inNetWorth: true },
      { id: 'd3', name: 'Family loan', balance: 6000, monthly: 500, months: 12, inNetWorth: false },
    ]);
    // Paid by transfers into its own account: the records count it as saving.
    const transfers = [{ id: 't1', kind: 'transfer', account_id: 'la', amount: 1000, occurred_at: '2026-09-01' }];
    expect(loansInSpending({ debts: [car], accounts: [loanAccount], transactions: transfers, now })).toEqual([]);
    // A transfer more than a year old says nothing about how it is paid now.
    expect(loansInSpending({ debts: [car], accounts: [loanAccount], transactions: [{ ...transfers[0], occurred_at: '2025-06-01' }], now })).toHaveLength(1);
  });

  const people = [{ id: 'm1', name: 'Partner A', birthYear: 1990, lifeExpectancy: 85 }];
  const inputs = { ready: true, monthlySaving: 2000, annualSpend: 60000, source: 'actual' };
  const basisWith = (loans, extra = {}) => lifePlanBasis({ people, assumptions: { inflation_pct: 0, retirement_year: 2050 }, inputs, startNetWorth: 88000, loans, startYear: 2026, now, ...extra });

  it('starts from what is owned before what a loan in net worth owes', () => {
    const loans = loansInSpending({ debts: [car], accounts: [loanAccount], now });
    expect(basisWith([]).args.startPot).toBe(88000);
    expect(basisWith(loans).args.startPot).toBe(100000);
    // A loan net worth doesn't see was never taken off the start.
    expect(basisWith([{ ...loans[0], inNetWorth: false }]).args.startPot).toBe(88000);
  });

  it('raises saving by the instalment once the loan clears, from the month after', () => {
    const basis = basisWith(loansInSpending({ debts: [car], accounts: [loanAccount], now }));
    expect(basis.loans[0]).toMatchObject({ clears: 'Oct 2027', year: 2027, monthsInYear: 2, perYear: 12000 });
    const rows = lifePlan(basis.args).rows;
    const saving = (year) => rows.find((r) => r.year === year).saving;
    // Nov and Dec 2027 free, then the whole year.
    expect(saving(2027)).toBeCloseTo(24000 + 2000, 6);
    expect(saving(2028)).toBeCloseTo(24000 + 12000, 6);
  });

  it('counts the freed instalment in today\'s money', () => {
    const basis = basisWith(loansInSpending({ debts: [car], accounts: [loanAccount], now }), { assumptions: { inflation_pct: 2.5, retirement_year: 2050 } });
    expect(basis.loans[0].perYear).toBeCloseTo(12000 / 1.025, 6);
  });

  it('takes it off spending after work stops only when that spending is today\'s', () => {
    const late = { ...car, balance: 120000, account_id: null };
    const stopEarly = { assumptions: { inflation_pct: 0, retirement_year: 2027 } };
    const basis = basisWith(loansInSpending({ debts: [late], now }), stopEarly);
    // 120 months: clears Oct 2036, free from Nov.
    const spend = (b, year) => lifePlan(b.args).rows.find((r) => r.year === year).spend;
    expect(spend(basis, 2036)).toBeCloseTo(60000 - 2000, 6);
    expect(spend(basis, 2037)).toBeCloseTo(60000 - 12000, 6);
    const planned = basisWith(loansInSpending({ debts: [late], now }), { assumptions: { inflation_pct: 0, retirement_year: 2027, retirement_annual_spend: 50000 } });
    expect(spend(planned, 2037)).toBe(50000);
  });

  it('says what it takes the loans to do', () => {
    const fmt = (v) => `AED ${v.toLocaleString('en-US')}`;
    const loans = basisWith(loansInSpending({ debts: [car], accounts: [loanAccount], now })).loans;
    expect(loansText(loans, 12000, fmt)).toBe(
      "Car loan's AED 1,000 a month is in today's spending until it clears about Oct 2027, and saving rises by it after that. The plan starts from what you own before the AED 12,000 it owes, which its instalment repays."
    );
    const two = [...loans, { ...loans[0], name: 'Family loan', months: 30, clears: 'Apr 2029' }];
    expect(loansText(two, 0, fmt)).toBe("The instalments on Car loan and Family loan are in today's spending until each clears, the last about Apr 2029, and saving rises by each after that.");
    expect(loansText([], 0, fmt)).toBeNull();
  });

  it('moves the stop year earlier than counting the loan twice did', () => {
    const loans = loansInSpending({ debts: [car], accounts: [loanAccount], now });
    expect(earliestStop(basisWith(loans).args)).toBeLessThan(earliestStop(basisWith([]).args));
  });
});

// Planning audit, 3.12: the stop year under Baseline and Conservative.

describe('stopRange', () => {
  const people = [{ id: 'm1', name: 'Partner A', birthYear: 1990, lifeExpectancy: 85 }];
  const inputs = { ready: true, monthlySaving: 3000, annualSpend: 48000, source: 'actual' };
  const basisFor = (stop) => (fcSet) => lifePlanBasis({ people, assumptions: { retirement_year: stop }, inputs, startNetWorth: 100000, startYear: 2026, fcSet });

  it('gives each scenario at the same stop year, with what is left or when it runs out, and its earliest year', () => {
    const range = stopRange(basisFor(2050));
    expect(range.map((r) => [r.key, r.label, r.stopYear])).toEqual([
      ['baseline', 'Baseline', 2050],
      ['conservative', 'Conservative', 2050],
    ]);
    const [baseline, conservative] = range;
    // Conservative's lower return and higher inflation leave less, or none.
    expect(baseline.lasts ? baseline.left : -Infinity).toBeGreaterThan(conservative.lasts ? conservative.left : -1);
    expect(conservative.earliest === null || conservative.earliest >= baseline.earliest).toBe(true);
  });

  it('says the range in words', () => {
    const fmt = (v) => `AED ${Math.round(v).toLocaleString('en-US')}`;
    const lasts = { label: 'Baseline', lasts: true, endYear: 2075, left: 1200000 };
    const out = { label: 'Conservative', lasts: false, shortYear: 2068, shortWorking: false };
    expect(rangeText([lasts, out], fmt)).toBe('Baseline lasts to 2075 with AED 1,200,000 left · Conservative runs out in 2068');
    expect(rangeText([{ ...out, shortYear: 2030, shortWorking: true }], fmt)).toBe('Conservative falls short for a goal in 2030');
  });
});

// Planning audit, 3.13: the return once work stops, and the costs that start then.

describe('afterWorkReturn', () => {
  const sets = scenarioSets({ nominal_return_pct: 7, inflation_pct: 3 });

  it('is one point below the working return until the household sets its own', () => {
    expect(AFTER_WORK_RETURN_GAP).toBe(1);
    expect(afterWorkReturn({ nominal_return_pct: 7 }, sets, sets.baseline)).toBe(6);
    expect(afterWorkReturn({ nominal_return_pct: 7, retirement_return_pct: 6.5 }, sets, sets.baseline)).toBe(6.5);
  });

  it('moves with the scenario, both returns together', () => {
    // Conservative is two points lower before work stops, so it is after too.
    expect(afterWorkReturn({ nominal_return_pct: 7 }, sets, sets.conservative)).toBe(4);
    expect(afterWorkReturn({ nominal_return_pct: 7, retirement_return_pct: 6.5 }, sets, sets.optimistic)).toBe(8.5);
  });

  it('is what the life plan grows the pot at once work stops', () => {
    const inputs = { ready: true, monthlySaving: 3000, annualSpend: 48000, source: 'actual' };
    const basis = lifePlanBasis({ people, assumptions: { nominal_return_pct: 7, inflation_pct: 3 }, inputs, startNetWorth: 100000, startYear: 2026 });
    expect(basis.postNominal).toBe(6);
    expect(basis.args.postRate).toBeCloseTo(realReturn(6, 3), 10);
    expect(basis.args.preRate).toBeCloseTo(realReturn(7, 3), 10);
  });
});

describe('costs that start when work stops', () => {
  const two = [
    { name: 'Partner A', birthYear: 1990, lifeExpectancy: 80 },
    { name: 'Partner B', birthYear: 1990, lifeExpectancy: 90 },
  ];
  const cover = { id: 'c1', name: 'Health cover', amount: '10000', currency: 'AED', per_person: true, rise_pct: '0', starts_after_years: 0, lasts_years: null };
  const visa = { id: 'c2', name: 'Visa fees', amount: '2000', currency: 'AED', per_person: false, rise_pct: '0', starts_after_years: 0, lasts_years: null };

  it('counts a cost for each person once for each person still planned for', () => {
    const costs = costsAfterWork([cover, visa], null, 2026);
    // Both planned in 2050; only Partner B after 2070.
    expect(costInYear(costs, two, 2050, 2050)).toBe(22000);
    expect(costInYear(costs, two, 2071, 2050)).toBe(12000);
  });

  it('rises above inflation from now, not from the year work stops', () => {
    const costs = costsAfterWork([{ ...cover, per_person: false, rise_pct: '3' }], null, 2026);
    expect(costInYear(costs, two, 2050, 2050)).toBeCloseTo(10000 * 1.03 ** 24, 6);
    expect(costInYear(costs, two, 2051, 2050)).toBeCloseTo(10000 * 1.03 ** 25, 6);
  });

  it('starts and ends when it says, counted from the year work stops', () => {
    const costs = costsAfterWork([{ ...visa, starts_after_years: 2, lasts_years: 3 }], null, 2026);
    expect([2050, 2051, 2052, 2053, 2054, 2055].map((y) => costInYear(costs, two, y, 2050))).toEqual([0, 0, 2000, 2000, 2000, 0]);
  });

  it('converts at today\'s rate, and leaves out a cost with no rate yet', () => {
    const rupees = { ...visa, id: 'c3', currency: 'INR', amount: '100000' };
    expect(costsAfterWork([rupees], null)).toEqual([]);
    expect(costsAfterWork([rupees], { inr_per_aed: 25 })[0].amount).toBeCloseTo(4000, 6);
  });

  it('adds to the spending once work stops, and not before', () => {
    const plain = lifePlan({ ...base, people: two, retireYear: 2050 });
    const costs = costsAfterWork([visa], null, 2026);
    const plan = lifePlan({ ...base, people: two, retireYear: 2050, costs });
    const row = (p, y) => p.rows.find((r) => r.year === y);
    expect(row(plan, 2049)).toMatchObject({ spend: 0, costs: 0 });
    expect(row(plan, 2050).costs).toBe(2000);
    expect(row(plan, 2050).spend).toBe(row(plain, 2050).spend + 2000);
    expect(plan.left).toBeLessThan(plain.left);
  });

  it('needs a bigger pot when work stops, with the rise counted from now', () => {
    const args = { ...base, people: two, retireYear: 2050 };
    const flat = costsAfterWork([{ ...cover, per_person: false }], null, 2026);
    const rising = costsAfterWork([{ ...cover, per_person: false, rise_pct: '3' }], null, 2026);
    expect(potNeededAt({ ...args, costs: flat })).toBeGreaterThan(potNeededAt(args));
    // potNeededAt starts the timeline at the stop year; the rise still counts from 2026.
    const needed = potNeededAt({ ...args, costs: rising });
    expect(lifePlan({ ...args, startYear: 2050, startPot: needed, annualSaving: 0, costs: rising }).rows[0].costs).toBeCloseTo(10000 * 1.03 ** 24, 6);
  });

  it('carries through the basis and the stop answer', () => {
    const members = [{ id: 'm1', display_name: 'Partner A' }];
    const memberLife = [{ member_id: 'm1', birth_year: 1990, life_expectancy: 85 }];
    const inputs = { ready: true, monthlySaving: 3000, annualSpend: 48000, source: 'actual' };
    const args = { members, memberLife, assumptions: { retirement_year: 2050 }, inputs, startNetWorth: 100000, startYear: 2026, costs: [cover, visa] };
    const stop = lifePlanStop(args);
    expect(stop.costsAtStop).toBe(12000);
    expect(stop.costs.map((c) => c.name)).toEqual(['Health cover', 'Visa fees']);
    expect(lifePlanStop({ ...args, costs: [] }).earliest).toBeLessThan(stop.earliest);
    const basis = lifePlanBasis({ ...args, people: planPeople(members, memberLife) });
    expect(basis.costsAtStop).toBe(12000);
  });

  it('says what the costs are, and adds them to the spending a stop year rests on', () => {
    const fmt = (v) => `AED ${Math.round(v).toLocaleString('en-US')}`;
    const costs = costsAfterWork([{ ...cover, rise_pct: '3' }, { ...visa, starts_after_years: 1, lasts_years: 10 }], null, 2026);
    expect(costsText(costs, fmt)).toBe(
      'Costs that start when work stops, on top of the spending: Health cover AED 10,000 a year for each person, rising 3% a year above inflation from now; Visa fees AED 2,000 a year, from 1 year after work stops, for 10 years.'
    );
    expect(costsText([], fmt)).toBeNull();
    expect(spendAfterText({ spend: 1, spendKey: 'planned', costsAtStop: 2 }, (v) => `AED ${v}`)).toBe('spending AED 1 a year after work stops (your plan), plus AED 2 a year of costs that start then');
  });
});

// Planning audit, 3.14: the stress test runs through the Life plan itself.

describe('the stress test', () => {
  it('overrides the return in the years the fall comes, counted from the year work stops', () => {
    const early = marketFall(1);
    expect([2049, 2050, 2051, 2052].map((y) => early(y, 2050))).toEqual([null, MARKET_FALL[0], MARKET_FALL[1], null]);
    const late = marketFall(10);
    expect([2058, 2059, 2060, 2061].map((y) => late(y, 2050))).toEqual([null, MARKET_FALL[0], MARKET_FALL[1], null]);
    // It moves with the stop year.
    expect(early(2052, 2052)).toBe(MARKET_FALL[0]);
  });

  it('grows the pot at the overriding return in those years, and the steady one otherwise', () => {
    const plan = lifePlan({ ...base, returnFor: marketFall(1) });
    const row = (y) => plan.rows.find((r) => r.year === y);
    expect(row(2054).rate).toBe(MARKET_FALL[0]);
    expect(row(2055).rate).toBe(MARKET_FALL[1]);
    expect(row(2056).rate).toBe(base.postRate);
    expect(row(2053).rate).toBe(base.preRate);
    expect(row(2054).growth).toBeCloseTo((row(2054).start - row(2054).paid) * MARKET_FALL[0], 6);
  });

  const inputs = { ready: true, monthlySaving: 4000, annualSpend: 60000, source: 'actual' };
  const basisAt = (stop, extra = {}) =>
    lifePlanBasis({ people, assumptions: { retirement_year: stop }, inputs, startNetWorth: 300000, startYear: 2026, ...extra });

  it('puts the plan at its stop year through a steady return and the same fall early and late', () => {
    const stress = stressTest(basisAt(2054));
    expect(stress.outcomes.map((o) => [o.key, o.fallYear])).toEqual([
      ['steady', null],
      ['early', 2054],
      ['late', 2063],
    ]);
    const [steady, early, late] = stress.outcomes;
    // The same two bad years: earlier hurts more, as the pot is largest then.
    const ending = (o) => (o.lasts ? o.left : -1e9 + o.shortYear);
    expect(ending(steady)).toBeGreaterThan(ending(late));
    expect(ending(late)).toBeGreaterThan(ending(early));
    expect(early.rows[0].year).toBe(2054);
    expect(early.earliest === null || early.earliest >= steady.earliest).toBe(true);
    expect(steady.earliest).toBe(earliestStop(basisAt(2054).args));
  });

  it('counts what the Life plan counts, spending for one included', () => {
    const forOne = stressTest(basisAt(2054, { assumptions: { retirement_year: 2054, survivor_spend_pct: 50 } }));
    const full = stressTest(basisAt(2054));
    expect(forOne.outcomes[1].left).toBeGreaterThan(full.outcomes[1].left);
  });

  it('leaves out a fall that would come after the plan ends', () => {
    const stress = stressTest(basisAt(2078));
    expect(stress.outcomes.map((o) => o.key)).toEqual(['steady', 'early']);
    expect(STRESS_FALLS.map((f) => f.key)).toEqual(['steady', 'early', 'late']);
  });

  it('says what the pot pays in the year work stops, after other income', () => {
    const basis = basisAt(2054, { incomes: [{ id: 'r', name: 'Rent', kind: 'yearly', amount: 12000, starts_after_years: 0, lasts_years: null }] });
    const { firstDraw } = stressTest(basis);
    expect(firstDraw.year).toBe(2054);
    expect(firstDraw.drawn).toBeCloseTo(60000 - 12000, 6);
    expect(firstDraw.share).toBeCloseTo(firstDraw.drawn / firstDraw.pot, 10);
  });
});

// Planning audit, 4.19: cash earns a cash rate, and what is in rupees can be
// put through a weakening rupee.

describe('cash and the rupee', () => {
  it('grows the cash kept at the cash rate and the rest at the return', () => {
    const cashRate = 0.005;
    const plan = lifePlan({ ...base, cashPot: 100_000, cashRate });
    const row = plan.rows[0];
    expect(row.growth).toBeCloseTo(100_000 * cashRate + 400_000 * base.preRate, 6);
    // Cash earns less, so the plan ends with less.
    expect(plan.left).toBeLessThan(lifePlan(base).left);
  });

  it('keeps it all as cash once the pot is below the cash, and a fall leaves the cash alone', () => {
    const small = lifePlan({ ...base, startPot: 50_000, annualSaving: 0, retireYear: 2026, retireSpend: 0, cashPot: 100_000, cashRate: 0.01 });
    expect(small.rows[0].growth).toBeCloseTo(50_000 * 0.01, 6);
    const fall = lifePlan({ ...base, retireYear: 2026, retireSpend: 0, annualSaving: 0, cashPot: 100_000, cashRate: 0, returnFor: () => -0.2 });
    expect(fall.rows[0].growth).toBeCloseTo(400_000 * -0.2, 6);
  });

  it('takes a cash rate from the assumptions, the default when there is none, the same in every scenario', () => {
    const inputs = { ready: true, monthlySaving: 4000, annualSpend: 60000, source: 'actual' };
    const basis = (assumptions, fcSet) => lifePlanBasis({ people, assumptions, inputs, startNetWorth: 300000, start: { cash: 50000, rupees: 0 }, startYear: 2026, fcSet });
    expect(basis(null).cashNominal).toBe(CASH_RETURN_DEFAULT);
    expect(basis(null).args.cashPot).toBe(50000);
    expect(basis(null).args.cashRate).toBeCloseTo(realReturn(CASH_RETURN_DEFAULT, 2.5), 10);
    expect(basis({ cash_return_pct: '4.00' }).cashNominal).toBe(4);
    expect(basis({ cash_return_pct: '4.00' }, 'conservative').cashNominal).toBe(4);
  });

  it('with the rupee weakening, makes rupee income, lump sums and the rupee share worth less, and rupee costs cheaper', () => {
    const at = (year, extra) => lifePlan({ ...base, retireYear: 2030, ...extra }).rows.find((r) => r.year === year);
    const income = [{ kind: 'yearly', amount: 10_000, starts_after_years: 0, lasts_years: null, inr: true }];
    expect(at(2036, { incomes: income, drift: 0.03 }).income).toBeCloseTo(10_000 * 0.97 ** 10, 6);
    expect(at(2036, { incomes: [{ ...income[0], inr: false }], drift: 0.03 }).income).toBe(10_000);
    const inflows = [{ id: 'p', name: 'Policy', year: 2036, amount: 50_000, inr: true }];
    expect(at(2036, { inflows, drift: 0.03 }).income).toBeCloseTo(50_000 * 0.97 ** 10, 6);
    const costs = [{ amount: 5_000, perPerson: false, risePct: 0, startsAfterYears: 0, lastsYears: null, since: 2026, inr: true }];
    expect(at(2036, { costs, drift: 0.03 }).costs).toBeCloseTo(5_000 * 0.97 ** 10, 6);
    const held = lifePlan({ ...base, rupeeShare: 0.5, drift: 0.03 }).rows[0];
    expect(held.growth).toBeCloseTo(500_000 * base.preRate - 500_000 * 0.5 * 0.03, 6);
  });

  it('puts the plan through the rupee weakening when anything is in rupees, and not otherwise', () => {
    const inputs = { ready: true, monthlySaving: 4000, annualSpend: 60000, source: 'actual' };
    const household = { inr_per_aed: 25 };
    const policy = { id: 'p', name: 'Policy maturity', kind: 'lump_sum', in_year: 2044, amount: 2_500_000, currency: 'INR' };
    const basis = (extra) => lifePlanBasis({ people, assumptions: { retirement_year: 2054 }, inputs, startNetWorth: 300000, household, startYear: 2026, ...extra });
    expect(rupeeDrift(basis({}))).toBeNull();
    const drift = rupeeDrift(basis({ incomes: [policy], start: { cash: 0, rupees: 60000 } }));
    expect(drift.drift).toBe(RUPEE_DRIFT);
    expect(drift.rupees).toEqual({ held: 60000, share: 0.2, incomes: 1, costs: 0 });
    const ending = (o) => (o.lasts ? o.left : -1e9 + o.shortYear);
    expect(ending(drift.weaker)).toBeLessThan(ending(drift.steady));
    expect(drift.weaker.earliest === null || drift.weaker.earliest >= drift.steady.earliest).toBe(true);
  });
});
