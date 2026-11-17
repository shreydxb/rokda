import { describe, expect, it } from 'vitest';
import { lifePlan, potNeededAt } from './lifePlan';
import { planBand, runsOutYear, shortAtStop, timelineChip, yearRows } from './planView';

// A small household: two people to 85, a pot that grows while they work and
// is spent once they stop. Real returns, today's money.
const people = [
  { name: 'Partner A', birthYear: 1990, lifeExpectancy: 85 },
  { name: 'Partner B', birthYear: 1992, lifeExpectancy: 85 },
];
const args = (over = {}) => ({
  startYear: 2026,
  people,
  retireYear: 2050,
  startPot: 200000,
  annualSaving: 60000,
  preRate: 0.04,
  postRate: 0.03,
  retireSpend: 90000,
  ...over,
});

describe('planBand: Conservative to Optimistic, year by year', () => {
  it('runs the plan on both edges at the same stop year, one figure a year', () => {
    const rates = { conservative: 0.02, optimistic: 0.06 };
    const band = planBand((key) => ({ args: args({ preRate: rates[key], postRate: rates[key] - 0.01 }) }));
    const main = lifePlan(args());
    expect(band.years).toEqual(main.rows.map((r) => r.year));
    expect(band.low).toHaveLength(main.rows.length);
    expect(band.high).toHaveLength(main.rows.length);
    // Ten years in, the cautious edge is below the plan and the hopeful one above.
    const i = 10;
    expect(band.low[i]).toBeLessThan(main.rows[i].start);
    expect(band.high[i]).toBeGreaterThan(main.rows[i].start);
  });
});

describe('shortAtStop: the gap at the year work stops', () => {
  it('is nothing while the money lasts', () => {
    const plan = args();
    const result = lifePlan(plan);
    expect(result.lasts).toBe(true);
    expect(shortAtStop({ result, need: potNeededAt(plan) })).toBeNull();
  });

  it('is what the pot needs then, less what it holds, when the money runs out', () => {
    const plan = args({ retireYear: 2036 });
    const result = lifePlan(plan);
    const need = potNeededAt(plan);
    expect(result.lasts).toBe(false);
    expect(shortAtStop({ result, need })).toBeCloseTo(need - result.potAtStop, 6);
    expect(shortAtStop({ result, need })).toBeGreaterThan(0);
  });

  it('is the goal\'s gap in its year when a goal falls short while still working', () => {
    const plan = args({ startPot: 0, annualSaving: 10000, goals: [{ name: 'Home', year: 2028, amount: 500000 }] });
    const result = lifePlan(plan);
    const row = result.rows.find((r) => r.year === result.shortYear);
    expect(row.working).toBe(true);
    expect(shortAtStop({ result, need: potNeededAt(plan) })).toBe(row.short);
  });

  it('gives no figure when the pot needed could not be worked out', () => {
    const result = lifePlan(args({ retireYear: 2036 }));
    expect(shortAtStop({ result, need: null })).toBeNull();
  });
});

describe('yearRows: the year-by-year fold', () => {
  it('gives every fifth year from this one and the stop year, each with where the plan is', () => {
    const result = lifePlan(args({ retireYear: 2048 }));
    const rows = yearRows(result, { startYear: 2026, stopYear: 2048 });
    expect(rows.map((r) => r.year)).toEqual([2026, 2031, 2036, 2041, 2046, 2048, 2051, 2056, 2061, 2066, 2071, 2076]);
    expect(rows.find((r) => r.year === 2026).status).toBe('working');
    expect(rows.find((r) => r.year === 2048).status).toBe('stop');
    expect(rows.find((r) => r.year === 2051).status).toBe('after');
    expect(rows[0].start).toBe(result.rows[0].start);
  });

  // The fresh review of 6a: a goal the pot can't pay while still working
  // made every year after work read "Nothing left" against a healthy pot.
  it('says nothing is left only in a year after work that the pot can\'t pay', () => {
    const result = lifePlan(args({ startPot: 0, annualSaving: 60000, goals: [{ name: 'Car', year: 2026, amount: 40000 }] }));
    expect(result.rows.find((r) => r.year === result.shortYear).working).toBe(true);
    const rows = yearRows(result, { startYear: 2026, stopYear: 2050 });
    expect(rows.filter((r) => r.status === 'empty')).toEqual([]);
  });

  it('says nothing is left from the year the money runs out', () => {
    const result = lifePlan(args({ retireYear: 2036 }));
    const rows = yearRows(result, { startYear: 2026, stopYear: 2036 });
    const out = rows.filter((r) => r.year >= result.shortYear);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.status === 'empty')).toBe(true);
  });
});

// The chart's "Runs out" dot: the first year after work the pot can't pay,
// even when a goal fell short while still working first.
describe('runsOutYear: where the chart marks the money running out', () => {
  it('is the first year after work the pot can\'t pay, whatever came short before', () => {
    const lasting = lifePlan(args());
    expect(runsOutYear(lasting)).toBeNull();
    const short = lifePlan(args({ retireYear: 2036 }));
    expect(runsOutYear(short)).toBe(short.shortYear);
    const both = lifePlan(args({ retireYear: 2036, goals: [{ name: 'Car', year: 2026, amount: 400000 }] }));
    expect(both.rows.find((r) => r.year === both.shortYear).working).toBe(true);
    expect(runsOutYear(both)).toBe(both.rows.find((r) => !r.working && r.short > 0).year);
  });
});

describe('timelineChip: how a goal sits on the plan', () => {
  const now = new Date(2026, 10, 17);
  const result = lifePlan(args());

  it('names a goal within three years as paid from cash in its year', () => {
    expect(timelineChip({ target_date: '2028-06-01' }, { now, result })).toEqual({ label: 'From cash 2028', tone: 'neutral' });
  });

  it('names a later goal as paid by the plan in its year, or short when the plan is', () => {
    expect(timelineChip({ target_date: '2035-01-01' }, { now, result })).toEqual({ label: 'Paid 2035', tone: 'pos' });
    const short = lifePlan(args({ startPot: 0, annualSaving: 10000, goals: [{ name: 'Home', year: 2035, amount: 900000 }] }));
    expect(timelineChip({ target_date: '2035-01-01' }, { now, result: short })).toEqual({ label: 'Short 2035', tone: 'warn' });
  });

  // The fresh review of 6a: a year the plan doesn't reach is beyond it, not
  // paid, as Goals says (lib/goals.js, outside review B-07).
  it('names a goal dated after the plan ends as beyond it', () => {
    expect(timelineChip({ target_date: '2090-01-01' }, { now, result })).toEqual({ label: 'Beyond the plan', tone: 'neutral' });
  });

  it('names money kept rather than spent, and a goal with no date', () => {
    expect(timelineChip({ target_date: '2030-01-01', counts_in_life_plan: false }, { now, result })).toEqual({ label: 'Kept', tone: 'neutral' });
    expect(timelineChip({ target_date: null }, { now, result })).toEqual({ label: 'No date', tone: 'neutral' });
  });
});
