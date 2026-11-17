import { describe, expect, it } from 'vitest';
import { goalChip, goalGroups, goalTableRow } from './goalsView';

// Goals & debts' goal tables (the revamp, phase 6b): a row a goal, grouped
// as lib/goals.js goalStatuses sorts them. Rows here are shaped like its
// output, with only what each case needs.
const goal = (id, extra = {}) => ({ id, name: id, target_amount: 10000, target_date: '2028-06-30', priority: null, is_shared: true, owner_member_id: null, ...extra });
const near = (g, extra = {}) => ({
  goal: g,
  kind: 'near',
  state: 'saving',
  cost: 10000,
  cash: 4000,
  remaining: 6000,
  perMonth: 300,
  byLabel: 'Jun 2028',
  planned: null,
  plan: null,
  pace: { from: 'logged', perMonth: 250, months: 3 },
  progress: { saved: 4000 },
  ...extra,
});
const later = (g, extra = {}) => ({ goal: g, kind: 'later', state: 'covered', cost: 50000, year: 2035, short: 0, byLabel: 'Jan 2035', planned: null, progress: { saved: 5000 }, ...extra });

describe('goalTableRow: what a goal\'s row shows', () => {
  it('gives a goal held in cash its target, cash saved, share, need a month and pace', () => {
    const row = goalTableRow(near(goal('Car')));
    expect(row).toMatchObject({ target: 10000, by: 'Jun 2028', saved: 4000, needs: 300, pace: 250, paceLow: false });
    expect(row.share).toBeCloseTo(0.4, 6);
    expect(row.chip).toEqual({ label: 'Saving', tone: 'warn' });
    expect(row.why).toMatch(/^Due within 3 years, so paid from cash: 300 a month to Jun 2028\./);
  });

  it('marks the pace low when it is below what is planned, or nothing went in', () => {
    expect(goalTableRow(near(goal('A'), { planned: 400, plan: { amount: 400, enough: false, months: 20, byLabel: 'Feb 2028' } })).paceLow).toBe(true);
    expect(goalTableRow(near(goal('B'), { pace: { from: 'logged', perMonth: 0, months: 3 } })).paceLow).toBe(true);
    // Too short a record to measure: no pace, and nothing marked.
    const short = goalTableRow(near(goal('C'), { pace: { from: 'linked', short: true } }));
    expect(short.pace).toBeNull();
    expect(short.paceLow).toBe(false);
  });

  it('asks for the whole remainder of a goal whose date has come', () => {
    expect(goalTableRow(near(goal('D'), { state: 'due', perMonth: null, remaining: 6000 })).needs).toBe(6000);
  });

  it('gives a later goal what is set aside for it, and neither a need nor a pace', () => {
    const row = goalTableRow(later(goal('Home', { target_date: '2035-01-31' })));
    expect(row).toMatchObject({ target: 50000, by: 'Jan 2035', saved: 5000, needs: null, pace: null, paceLow: false });
    expect(row.chip).toEqual({ label: 'Paid in 2035', tone: 'pos' });
  });

  it('says a goal with no date has none', () => {
    const row = goalTableRow({ goal: goal('Boat', { target_date: null }), kind: 'undated', state: 'undated', cost: 8000, planned: null, progress: { saved: 0 } });
    expect(row).toMatchObject({ by: null, saved: 0, needs: null, share: 0 });
    expect(row.chip).toEqual({ label: 'No date', tone: 'neutral' });
  });
});

describe('goalChip: one status a goal', () => {
  it('reads a goal held in cash by its cash and its plan', () => {
    expect(goalChip(near(goal('A'), { state: 'covered' }))).toEqual({ label: 'Covered', tone: 'pos' });
    expect(goalChip(near(goal('A'), { state: 'due' }))).toEqual({ label: 'Due', tone: 'warn' });
    expect(goalChip(near(goal('A'), { plan: { enough: true } }))).toEqual({ label: 'Planned', tone: 'pos' });
    expect(goalChip(near(goal('A'), { plan: { enough: false } }))).toEqual({ label: 'Plan short', tone: 'warn' });
  });

  it('reads a later goal by the plan\'s timeline', () => {
    expect(goalChip(later(goal('A'), { state: 'short' }))).toEqual({ label: 'Short in 2035', tone: 'warn' });
    expect(goalChip(later(goal('A'), { state: 'beyond' }))).toEqual({ label: 'Beyond the plan', tone: 'neutral' });
    expect(goalChip(later(goal('A'), { state: 'unchecked' }))).toEqual({ label: 'Not checked', tone: 'neutral' });
  });
});

describe('goalGroups: the cards, in order, with their totals', () => {
  it('groups by kind in the prototype\'s order, leaving out an empty group', () => {
    const rows = [later(goal('Home')), near(goal('Car')), { ...near(goal('Fund')), kind: 'kept' }];
    expect(goalGroups(rows).map((g) => g.kind)).toEqual(['near', 'kept', 'later']);
  });

  it('adds up what each group has saved, its target and what it needs a month', () => {
    const [group] = goalGroups([near(goal('Car')), near(goal('Trip'), { cash: 1000, cost: 5000, perMonth: 200 })]);
    expect(group).toMatchObject({ saved: 5000, target: 15000, needs: 500 });
  });

  it('orders a group by priority, then by date, unnumbered goals last', () => {
    const rows = [
      near(goal('Later date', { target_date: '2028-09-30' })),
      near(goal('Second', { priority: 2, target_date: '2028-01-31' })),
      near(goal('Earlier date', { target_date: '2027-03-31' })),
      near(goal('First', { priority: 1, target_date: '2028-12-31' })),
    ];
    expect(goalGroups(rows)[0].rows.map((r) => r.goal.name)).toEqual(['First', 'Second', 'Earlier date', 'Later date']);
  });
});
