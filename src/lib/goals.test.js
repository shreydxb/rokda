import { describe, it, expect } from 'vitest';
import { fundInPriority, goalCostAtDate, allocatedValue, goalProgress, monthlyNeed, scopedGoalRows } from './goals';

const NOW = new Date(2026, 8, 24, 12); // 24 September 2026

const GOAL = { id: 'g1', name: 'House', target_amount: 12000, target_date: '2026-12-31', is_shared: true, owner_member_id: null };

describe('monthlyNeed: what the target date needs each month', () => {
  it('spreads what is left over the whole months to the target', () => {
    const progress = goalProgress(GOAL, [{ amount: 3000, occurred_at: '2026-09-01' }], NOW);
    const need = monthlyNeed(GOAL, progress, NOW);
    // Oct, Nov, Dec: 9,000 left over three months.
    expect(need.monthsLeft).toBe(3);
    expect(need.remaining).toBe(9000);
    expect(need.perMonth).toBe(3000);
    expect(need.byLabel).toBe('Dec 2026');
    expect(need.due).toBe(false);
  });

  it('counts linked account value as already saved', () => {
    const progress = goalProgress(GOAL, [], NOW, 6000);
    expect(monthlyNeed(GOAL, progress, NOW).perMonth).toBe(2000);
  });

  it('says the whole remainder is due when the date is this month or past', () => {
    const late = { ...GOAL, target_date: '2026-09-30' };
    const need = monthlyNeed(late, goalProgress(late, [], NOW), NOW);
    expect(need.due).toBe(true);
    expect(need.monthsLeft).toBe(0);
    expect(need.perMonth).toBe(12000);
  });

  it('has nothing to solve with no target date or once funded', () => {
    const undated = { ...GOAL, target_date: null };
    expect(monthlyNeed(undated, goalProgress(undated, [], NOW), NOW)).toBeNull();
    const funded = goalProgress(GOAL, [{ amount: 12000, occurred_at: '2026-09-01' }], NOW);
    expect(monthlyNeed(GOAL, funded, NOW)).toBeNull();
  });

  it('reports the gap against the recent pace', () => {
    // 1,500 over the last three months is a 500/month pace against 3,500 needed.
    const progress = goalProgress(GOAL, [{ amount: 1500, occurred_at: '2026-08-15' }], NOW);
    const need = monthlyNeed(GOAL, progress, NOW);
    expect(need.perMonth).toBe(3500);
    expect(need.shortfall).toBe(3000);
    expect(progress.status).toBe('behind');
  });

  it('agrees with the status chip: a pace that is enough is not a shortfall', () => {
    const progress = goalProgress(GOAL, [{ amount: 9000, occurred_at: '2026-09-01' }], NOW);
    const need = monthlyNeed(GOAL, progress, NOW);
    // 3,000 a month pace, 1,000 a month needed.
    expect(need.shortfall).toBeLessThan(0);
    expect(progress.status).not.toBe('behind');
  });

  it('reads the target date as a calendar day, not UTC midnight', () => {
    // '2026-12-01' parsed as UTC is 30 November west of Greenwich, which
    // would drop a month.
    const first = { ...GOAL, target_date: '2026-12-01' };
    expect(monthlyNeed(first, goalProgress(first, [], NOW), NOW).monthsLeft).toBe(3);
  });
});

describe('scopedGoalRows: one derivation for Goals and the Plan summary', () => {
  const accounts = [
    { id: 'a1', currency: 'AED', balance: 4000, balance_aed: 4000 },
    { id: 'a2', currency: 'INR', balance: 20000, balance_aed: null },
  ];
  const holdings = [{ id: 'h1', value_aed: 2000 }];
  const allocations = [
    { goal_id: 'g1', account_id: 'a1', holding_id: null, share_pct: 50 },
    { goal_id: 'g1', account_id: null, holding_id: 'h1', share_pct: 100 },
    { goal_id: 'g1', account_id: 'a2', holding_id: null, share_pct: 100 },
  ];

  it('includes linked accounts and holdings in saved', () => {
    // 2,000 from half of a1, 2,000 from h1, nothing from the unconverted a2.
    expect(allocatedValue('g1', allocations, accounts, holdings)).toBe(4000);
    const [row] = scopedGoalRows({ goals: [GOAL], contributions: [{ goal_id: 'g1', amount: 1000, occurred_at: '2026-09-01' }], allocations, accounts, holdings, now: NOW });
    expect(row.progress.saved).toBe(5000);
    expect(row.need.remaining).toBe(7000);
  });

  it('halves a shared goal for one person, so the two halves add up to Both', () => {
    const args = { goals: [GOAL], contributions: [{ goal_id: 'g1', amount: 1000, occurred_at: '2026-09-01' }], allocations, accounts, holdings, now: NOW };
    const both = scopedGoalRows(args)[0];
    const one = scopedGoalRows({ ...args, scopeMemberId: 'm1' })[0];
    expect(one.progress.saved * 2).toBe(both.progress.saved);
    expect(one.progress.target * 2).toBe(both.progress.target);
    expect(one.need.perMonth * 2).toBeCloseTo(both.need.perMonth);
  });

  it("leaves out someone else's personal goal", () => {
    const theirs = { ...GOAL, id: 'g2', is_shared: false, owner_member_id: 'm2' };
    expect(scopedGoalRows({ goals: [GOAL, theirs], scopeMemberId: 'm1', now: NOW })).toHaveLength(1);
  });
});

describe('goals priced at today\'s cost', () => {
  const now = new Date(2026, 8, 27);

  it('grows a today\'s cost at the goal\'s own rate until its date', () => {
    // The adviser's villa: Rs 5 Cr today at 8% for 18 years (Sep 2026 to Sep 2044).
    const villa = { target_amount: '50000000', target_date: '2044-09-01', cost_today: true, inflation_pct: '8' };
    expect(goalCostAtDate(villa, now)).toBeCloseTo(50000000 * 1.08 ** 18, 0);
    expect(goalCostAtDate(villa, now) / 1e7).toBeCloseTo(19.98, 2);
  });

  it('uses the household\'s inflation when the goal has none, and leaves amounts-on-the-date alone', () => {
    expect(goalCostAtDate({ target_amount: 1000, target_date: '2028-09-01', cost_today: true, inflation_pct: null }, now, 5)).toBeCloseTo(1102.5, 6);
    expect(goalCostAtDate({ target_amount: 1000, target_date: '2028-09-01', cost_today: false }, now, 5)).toBe(1000);
    expect(goalCostAtDate({ target_amount: 1000, target_date: null, cost_today: true }, now, 5)).toBe(1000);
  });

  it('measures progress against the cost on the date', () => {
    const goal = { id: 'g', name: 'Car', target_amount: 1000, target_date: '2028-09-01', cost_today: true, inflation_pct: 5, is_shared: true };
    const [row] = scopedGoalRows({ goals: [goal], contributions: [{ goal_id: 'g', amount: 1000, occurred_at: '2026-09-01' }], now });
    // Today's price saved is not yet the price in two years.
    expect(row.progress.target).toBeCloseTo(1102.5, 6);
    expect(row.progress.status).not.toBe('funded');
  });
});

describe('fundInPriority', () => {
  const now = new Date(2026, 8, 27);
  const row = (id, priority, date, cost, saved = 0) => ({ goal: { id, priority, target_date: date }, progress: { target: cost, saved } });

  it('discounts each goal to what it needs today, at the expected return', () => {
    const { goals } = fundInPriority({ rows: [row('a', null, '2036-09-01', 1000)], freeMoney: 0, returnPct: 10, now });
    expect(goals[0].neededToday).toBeCloseTo(1000 / 1.1 ** 10, 6);
    expect(goals[0].topUp).toBeCloseTo(goals[0].neededToday, 6);
  });

  it('covers goals in priority order, then unnumbered ones by date, until the money runs out', () => {
    const rows = [row('late', null, '2030-01-01', 100), row('second', 2, '2027-01-01', 100), row('first', 1, '2040-01-01', 100), row('soon', null, '2028-01-01', 100)];
    const result = fundInPriority({ rows, freeMoney: 250, returnPct: 0, now });
    expect(result.goals.map((g) => g.goal.id)).toEqual(['first', 'second', 'soon', 'late']);
    expect(result.goals.map((g) => g.pct)).toEqual([1, 1, 0.5, 0]);
    expect(result.topUp).toBe(150);
    expect(result.freeLeft).toBe(0);
  });

  it('counts what is already set aside for a goal before the free money', () => {
    const result = fundInPriority({ rows: [row('a', 1, '2027-01-01', 100, 60), row('b', 2, '2027-01-01', 100)], freeMoney: 50, returnPct: 0, now });
    expect(result.goals[0]).toMatchObject({ saved: 60, fromFree: 40, pct: 1 });
    expect(result.goals[1]).toMatchObject({ fromFree: 10, topUp: 90 });
  });

  it('leaves undated goals out', () => {
    expect(fundInPriority({ rows: [row('a', 1, null, 100)], freeMoney: 0, returnPct: 5, now }).goals).toEqual([]);
  });
});
