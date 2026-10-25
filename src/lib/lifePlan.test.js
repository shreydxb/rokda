import { describe, it, expect } from 'vitest';
import { agesIn, loansInSpending, loansText, agesLabel, datedIncomesOnTimeline, defaultStopPerson, earliestStop, extraSavingNeeded, goalsOnTimeline, lifePlan, lifePlanBasis, lifePlanStop, maxRetirementSpend, membersLeftOut, noStopCause, noStopText, planEndYear, planPeople, potNeededAt, spendAfterText, yearLeft } from './lifePlan';
import { projectYears, realReturn } from './forecast';

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

describe('lifePlan: who is planned for, and until when', () => {
  it('runs to the end of the year the last person reaches their life expectancy', () => {
    expect(planEndYear(people)).toBe(2079);
    const plan = lifePlan(base);
    expect(plan.rows[0].year).toBe(2026);
    expect(plan.rows.at(-1).year).toBe(2079);
  });

  it('gives each person their age in a year', () => {
    expect(agesIn(people, 2054)).toEqual([
      { name: 'Partner A', age: 60, planned: true },
      { name: 'Partner B', age: 60, planned: true },
    ]);
    expect(agesIn(people, 2075)[0]).toEqual({ name: 'Partner A', age: 81, planned: false });
  });
});

describe('lifePlan: the timeline', () => {
  it('grows exactly as Forecast projects until work stops', () => {
    const plan = lifePlan(base);
    const forecast = projectYears({ startNetWorth: 500_000, annualSaving: 60_000, rate: base.preRate, mode: 'real', inflationPct: 7, years: 28 });
    expect(plan.potAtStop).toBeCloseTo(forecast[28].value, 4);
  });

  it('pays a goal at the start of its year, and falls short when the pot cannot', () => {
    const goals = [{ name: 'House down payment', year: 2027, amount: 450_000 }];
    const plan = lifePlan({ ...base, startPot: 100_000, goals });
    const y2027 = plan.rows.find((r) => r.year === 2027);
    // 100,000 grown for a year plus 60,000 saved is what 2027 starts with.
    expect(y2027.start).toBeCloseTo(100_000 * (1 + base.preRate) + 60_000, 4);
    expect(y2027.paid).toBeCloseTo(y2027.start, 4);
    expect(y2027.short).toBeCloseTo(450_000 - y2027.start, 4);
    expect(plan.shortYear).toBe(2027);
    // The plan carries on from an empty pot: saving rebuilds it.
    expect(plan.rows.find((r) => r.year === 2028).start).toBeCloseTo(60_000, 4);
  });

  it('spends other income first once work stops, and adds lump sums to the pot', () => {
    const incomes = [
      { kind: 'yearly', amount: 30_000, starts_after_years: 0, lasts_years: null },
      { kind: 'lump_sum', amount: 90_000, starts_after_years: 0 },
    ];
    const plan = lifePlan({ ...base, incomes });
    const y = plan.rows.find((r) => r.year === 2054);
    expect(y.income).toBe(120_000);
    // 61,000 of spending less 30,000 of income comes from the pot, after the lump sum lands.
    expect(y.paid).toBeCloseTo(31_000, 6);
    expect(y.end).toBeCloseTo((y.start + 90_000 - 31_000) * (1 + base.postRate), 4);
  });

  it('spends the survivor share once only one person is planned for', () => {
    const plan = lifePlan({ ...base, survivorPct: 50 });
    // Partner A is planned for to the end of 2074; from 2075 the plan is for one.
    expect(plan.rows.find((r) => r.year === 2074).spend).toBe(61_000);
    const y2075 = plan.rows.find((r) => r.year === 2075);
    expect(y2075.forOne).toBe(true);
    expect(y2075.spend).toBe(30_500);
  });

  // A negative pot was booked as a shortfall in its first year and then
  // reset to zero, so the rest of the debt vanished (Planning audit, 0b-D).
  it('carries a pot below zero while working, and lets saving repay it', () => {
    // A loan 150,000 larger than the accounts, and 60,000 saved a year.
    const plan = lifePlan({ ...base, startPot: -150_000 });
    expect(plan.rows[0].short).toBe(0);
    // Debt earns nothing: 150,000 owed less a year's saving.
    expect(plan.rows[0].end).toBe(-90_000);
    expect(plan.rows[1].start).toBe(-90_000);
    expect(plan.rows[2].start).toBe(-30_000);
    expect(plan.rows[3].start).toBe(30_000);
    expect(earliestStop({ ...base, startPot: -150_000 })).not.toBeNull();
  });

  it('counts what is still owed once work stops as a shortfall', () => {
    const plan = lifePlan({ ...base, startPot: 10_000, annualSaving: -50_000 });
    expect(plan.rows.filter((r) => r.working).every((r) => r.short === 0)).toBe(true);
    expect(plan.shortYear).toBe(2054);
    const stop = plan.rows.find((r) => r.year === 2054);
    // The year's spending and the debt carried into it.
    expect(stop.short).toBeCloseTo(61_000 - stop.start, 6);
    expect(stop.end).toBe(0);
  });

  it('cannot pay a goal from a pot below zero', () => {
    const plan = lifePlan({ ...base, startPot: -150_000, goals: [{ name: 'Car', year: 2027, amount: 20_000 }] });
    expect(plan.shortYear).toBe(2027);
    expect(plan.rows[1].short).toBe(20_000);
    // The debt is still carried, not forgiven alongside.
    expect(plan.rows[1].end).toBe(-30_000);
  });

  // This year was credited with a whole year of saving and growth, so the
  // answer was the same on 2 January and on 30 December (Planning audit, 0b-D).
  it('credits this year with only the share of it still to come', () => {
    expect(yearLeft(new Date(2026, 0, 1))).toBe(1);
    expect(yearLeft(new Date(2026, 9, 21))).toBeCloseTo(72 / 365, 6);
    const plan = lifePlan({ ...base, firstYearShare: 0.25 });
    expect(plan.rows[0].saving).toBe(15_000);
    expect(plan.rows[0].growth).toBeCloseTo(500_000 * ((1 + base.preRate) ** 0.25 - 1), 6);
    // Every later year is a whole one.
    expect(plan.rows[1].saving).toBe(60_000);
    expect(plan.rows[1].start).toBeCloseTo(500_000 * (1 + base.preRate) ** 0.25 + 15_000, 6);
  });

  it('spends only the rest of this year when work has already stopped', () => {
    const plan = lifePlan({ ...base, retireYear: 2026, firstYearShare: 0.5 });
    expect(plan.rows[0].spend).toBe(30_500);
    expect(plan.rows[1].spend).toBe(61_000);
  });

  it('needs the same pot on a later stop day whatever the date today', () => {
    expect(potNeededAt({ ...base, firstYearShare: 0.25 })).toBe(potNeededAt(base));
  });

  it('reproduces the adviser\'s retirement corpus to the rupee', () => {
    // Rs 15 lakh a year today, 7% inflation, 8.5% after retirement, retiring
    // in 2044 and funding Partner B to 2079, spending halved from 2074: the
    // adviser's sheet asks for Rs 13,48,76,610 in 2044 rupees. The sheet halves
    // from the year Partner A turns 80, so they are planned for to 79 here.
    const adviser = {
      ...base,
      people: [
        { name: 'Partner A', birthYear: 1994, lifeExpectancy: 79 },
        { name: 'Partner B', birthYear: 1994, lifeExpectancy: 85 },
      ],
      retireYear: 2044,
      retireSpend: 1_500_000,
      survivorPct: 50,
    };
    const inToday = potNeededAt(adviser);
    expect(Math.abs(inToday * 1.07 ** 18 - 134_876_610)).toBeLessThan(5);
  });
});

describe('noStopCause: why no year lasts', () => {
  it('names a goal the pot cannot pay even while working', () => {
    expect(noStopCause({ ...base, startPot: 0, goals: [{ name: 'Villa', year: 2027, amount: 10_000_000 }] })).toEqual({ kind: 'goal', goal: 'Villa', year: 2027 });
  });

  it('says when more is spent than earned', () => {
    expect(noStopCause({ ...base, annualSaving: -6_000 })).toEqual({ kind: 'spending' });
  });

  it('otherwise says the saving is not enough', () => {
    expect(noStopCause({ ...base, startPot: 0, annualSaving: 1_000, retireSpend: 500_000 })).toEqual({ kind: 'short' });
  });

  it('says when everyone is past the age the plan runs to', () => {
    const outlived = [{ name: 'Partner A', birthYear: 1940, lifeExpectancy: 84 }];
    expect(noStopCause({ ...base, people: outlived })).toEqual({ kind: 'ended' });
    expect(noStopText({ endYear: 2024, whyNone: { kind: 'ended' } })).toBe('Everyone is past the age the plan runs to: plan to a later age');
  });

  it('is said in words for the screens that lead with the answer', () => {
    expect(noStopText({ endYear: 2079, whyNone: { kind: 'goal', goal: 'Villa', year: 2027 } })).toBe('Villa in 2027 falls short, even while still working');
    expect(noStopText({ endYear: 2079, whyNone: { kind: 'spending' } })).toBe('More is spent than earned, so no stop year lasts');
    expect(noStopText({ endYear: 2079, whyNone: { kind: 'short' } })).toBe("No stop year lasts to 2079 on today's saving");
  });
});

describe('lifePlan: what it would take', () => {
  const short = { ...base, retireYear: 2044, retireSpend: 90_000 };

  it('the pot needed when work stops is exactly enough', () => {
    const need = potNeededAt(short);
    const from = { ...short, startYear: 2044, annualSaving: 0 };
    expect(lifePlan({ ...from, startPot: need }).lasts).toBe(true);
    expect(lifePlan({ ...from, startPot: need - 12 }).lasts).toBe(false);
  });

  it('finds the first year work can stop and still last', () => {
    expect(lifePlan(short).lasts).toBe(false);
    const year = earliestStop(short);
    expect(year).toBeGreaterThan(2044);
    expect(lifePlan({ ...short, retireYear: year }).lasts).toBe(true);
    expect(lifePlan({ ...short, retireYear: year - 1 }).lasts).toBe(false);
  });

  it('finds the extra saving a year that makes the chosen year last', () => {
    const extra = extraSavingNeeded(short);
    expect(extra).toBeGreaterThan(0);
    expect(lifePlan({ ...short, annualSaving: short.annualSaving + extra }).lasts).toBe(true);
    expect(lifePlan({ ...short, annualSaving: short.annualSaving + extra - 12 }).lasts).toBe(false);
    // A plan that already lasts needs nothing extra.
    expect(lifePlan(base).lasts).toBe(true);
    expect(extraSavingNeeded(base)).toBe(0);
  });

  it('finds the most that can be spent a year once work stops', () => {
    const most = maxRetirementSpend(short);
    expect(lifePlan({ ...short, retireSpend: most }).lasts).toBe(true);
    expect(lifePlan({ ...short, retireSpend: most + 12 }).lasts).toBe(false);
  });

  it('says so when no year works because a goal falls short while still working', () => {
    const goals = [{ name: 'Villa', year: 2027, amount: 5_000_000 }];
    expect(earliestStop({ ...base, goals })).toBeNull();
    expect(maxRetirementSpend({ ...base, goals })).toBeNull();
    // Saving arrives at the end of the year, too late for a goal due this year.
    expect(extraSavingNeeded({ ...base, goals: [{ name: 'Now', year: 2026, amount: 5_000_000 }] })).toBeNull();
  });

  it('has nothing to save in when work has already stopped', () => {
    const stopped = { ...short, retireYear: 2026, startPot: 10_000 };
    expect(extraSavingNeeded(stopped)).toBeNull();
  });
});

describe('goalsOnTimeline', () => {
  const goal = (over) => ({ id: 'g', name: 'Car', target_amount: '45000', target_date: '2027-06-01', counts_in_life_plan: true, ...over });

  it('brings a goal back to today\'s money from its date', () => {
    expect(goalsOnTimeline([goal({ target_date: '2028-03-01' })], 2026, 2.5)).toEqual([
      { id: 'g', name: 'Car', year: 2028, amount: 45000 / 1.025 ** 2 },
    ]);
  });

  it('pays a date already past this year', () => {
    expect(goalsOnTimeline([goal({ target_date: '2024-01-01' })], 2026, 2.5)[0]).toMatchObject({ year: 2026, amount: 45000 });
  });

  it('leaves off goals with no date, kept rather than spent, or done, and orders by year', () => {
    const goals = [
      goal({ id: 'a', target_date: '2030-01-01' }),
      goal({ id: 'b', target_date: null }),
      goal({ id: 'c', counts_in_life_plan: false }),
      goal({ id: 'd', target_date: '2027-01-01' }),
      goal({ id: 'e', target_date: '2028-01-01', done_at: '2026-10-01T08:00:00Z' }),
    ];
    expect(goalsOnTimeline(goals, 2026, 0).map((g) => g.id)).toEqual(['d', 'a']);
  });
});

describe('goalsOnTimeline: today\'s costs', () => {
  it('moves a today\'s cost by its own rate less general inflation', () => {
    const villa = { id: 'v', name: 'Villa', target_amount: '1000', target_date: '2036-06-01', cost_today: true, inflation_pct: '8', counts_in_life_plan: true };
    expect(goalsOnTimeline([villa], 2026, 2.5)[0].amount).toBeCloseTo(1000 * (1.08 / 1.025) ** 10, 6);
    // At the general rate, a today's cost stays the same in today's money.
    expect(goalsOnTimeline([{ ...villa, inflation_pct: null }], 2026, 2.5)[0].amount).toBeCloseTo(1000, 9);
  });
});

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

describe('sums paid in a set year (policy maturities)', () => {
  const household = { inr_per_aed: 25 };
  const policy = { id: 'a', name: 'Policy A maturity', kind: 'lump_sum', amount: 5_000_000, currency: 'INR', in_year: 2044 };

  it('converts at today\'s rate and brings the amount back to today\'s money', () => {
    expect(datedIncomesOnTimeline([policy], 2026, 2.5, household)).toEqual([{ id: 'a', name: 'Policy A maturity', year: 2044, amount: 200_000 / 1.025 ** 18 }]);
  });

  it('leaves out a year already past, and a rupee sum with no rate', () => {
    expect(datedIncomesOnTimeline([{ ...policy, in_year: 2025 }], 2026, 2.5, household)).toEqual([]);
    expect(datedIncomesOnTimeline([policy], 2026, 2.5, { inr_per_aed: null })).toEqual([]);
  });

  it('adds the sum to the pot in its year, while still working', () => {
    const inflows = [{ id: 'a', name: 'Policy A maturity', year: 2044, amount: 100_000 }];
    const plan = lifePlan({ ...base, inflows });
    const without = lifePlan(base);
    const y = plan.rows.find((r) => r.year === 2044);
    expect(y.working).toBe(true);
    expect(y.inflows.map((i) => i.name)).toEqual(['Policy A maturity']);
    expect(y.income).toBe(100_000);
    expect(y.end - without.rows.find((r) => r.year === 2044).end).toBeCloseTo(100_000 * (1 + base.preRate), 4);
  });

  it('is kept apart from income timed from the stop year', () => {
    const basis = lifePlanBasis({
      people,
      assumptions: null,
      inputs: { ready: true, monthlySaving: 5000, annualSpend: 60_000, source: 'actual' },
      startNetWorth: 100_000,
      incomes: [policy, { id: 'g', name: 'Gratuity', kind: 'lump_sum', amount: 30_000, starts_after_years: 0 }],
      household,
      startYear: 2026,
    });
    expect(basis.args.incomes.map((i) => i.name)).toEqual(['Gratuity']);
    expect(basis.args.inflows.map((i) => i.name)).toEqual(['Policy A maturity']);
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
