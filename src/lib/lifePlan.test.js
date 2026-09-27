import { describe, it, expect } from 'vitest';
import { agesIn, agesLabel, earliestStop, extraSavingNeeded, goalsOnTimeline, lifePlan, lifePlanBasis, lifePlanStop, maxRetirementSpend, planEndYear, planPeople, potNeededAt } from './lifePlan';
import { projectYears, realReturn } from './forecast';

const people = [
  { name: 'Shreyash', birthYear: 1994, lifeExpectancy: 80 },
  { name: 'Tarika', birthYear: 1994, lifeExpectancy: 85 },
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
      { name: 'Shreyash', age: 60, planned: true },
      { name: 'Tarika', age: 60, planned: true },
    ]);
    expect(agesIn(people, 2075)[0]).toEqual({ name: 'Shreyash', age: 81, planned: false });
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
    // Shreyash is planned for to the end of 2074; from 2075 the plan is for one.
    expect(plan.rows.find((r) => r.year === 2074).spend).toBe(61_000);
    const y2075 = plan.rows.find((r) => r.year === 2075);
    expect(y2075.forOne).toBe(true);
    expect(y2075.spend).toBe(30_500);
  });

  it('counts spending more than is earned while working as drawing on the pot', () => {
    const plan = lifePlan({ ...base, startPot: 10_000, annualSaving: -50_000 });
    expect(plan.shortYear).toBe(2026);
    expect(plan.rows[0].end).toBe(0);
  });

  it('reproduces the adviser\'s retirement corpus to the rupee', () => {
    // Rs 15 lakh a year today, 7% inflation, 8.5% after retirement, retiring
    // in 2044 and funding Tarika to 2079, spending halved from 2074: the
    // adviser's sheet asks for Rs 13,48,76,610 in 2044 rupees. The sheet halves
    // from the year Shreyash turns 80, so he is planned for to 79 here.
    const adviser = {
      ...base,
      people: [
        { name: 'Shreyash', birthYear: 1994, lifeExpectancy: 79 },
        { name: 'Tarika', birthYear: 1994, lifeExpectancy: 85 },
      ],
      retireYear: 2044,
      retireSpend: 1_500_000,
      survivorPct: 50,
    };
    const inToday = potNeededAt(adviser);
    expect(Math.abs(inToday * 1.07 ** 18 - 134_876_610)).toBeLessThan(5);
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

  it('leaves off goals with no date, or kept rather than spent, and orders by year', () => {
    const goals = [goal({ id: 'a', target_date: '2030-01-01' }), goal({ id: 'b', target_date: null }), goal({ id: 'c', counts_in_life_plan: false }), goal({ id: 'd', target_date: '2027-01-01' })];
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
    { id: 'm1', display_name: 'Shreyash' },
    { id: 'm2', display_name: 'Tarika' },
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
    expect(agesLabel(stop.ages)).toBe(`Shreyash ${stop.earliest - 1994} · Tarika ${stop.earliest - 1994}`);
    expect(lifePlan({ ...basis.args, retireYear: stop.earliest }).lasts).toBe(true);
  });

  it('has no answer until someone\'s age is set, or with nothing to project from', () => {
    expect(lifePlanStop({ ...args, memberLife: [] })).toBeNull();
    expect(lifePlanStop({ ...args, inputs: { ready: false } })).toBeNull();
  });
});
