import { describe, it, expect } from 'vitest';
import { allocatedValue, cashPerMonth, doneMonth, fundInPriority, goalCostAtDate, goalPace, goalProgress, goalStatuses, isDone, monthlyNeed, scopedGoalRows } from './goals';

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
    // The 1,000 logged is its record, not added on top (Planning audit, 2.8).
    const [row] = scopedGoalRows({ goals: [GOAL], contributions: [{ goal_id: 'g1', amount: 1000, occurred_at: '2026-09-01' }], allocations, accounts, holdings, now: NOW });
    expect(row).toMatchObject({ linked: true, progress: { saved: 4000 }, need: { remaining: 8000 } });
    expect(row.contributions).toHaveLength(1);
  });

  it('counts what is logged to a goal with nothing linked', () => {
    const [row] = scopedGoalRows({ goals: [GOAL], contributions: [{ goal_id: 'g1', amount: 1000, occurred_at: '2026-09-01' }], allocations: [], accounts, holdings, now: NOW });
    expect(row).toMatchObject({ linked: false, progress: { saved: 1000 } });
  });

  it('counts nothing from a loan, a card or a closed account, which hold no money for the goal', () => {
    const linkedAccounts = [
      { id: 'l1', type: 'loan', currency: 'AED', balance: 40000, balance_aed: 40000 },
      { id: 'c1', type: 'credit_card', currency: 'AED', balance: 1500, balance_aed: 1500 },
      { id: 's1', type: 'savings', currency: 'AED', balance: 3000, balance_aed: 3000, archived_at: '2026-09-01T00:00:00Z' },
      { id: 's2', type: 'savings', currency: 'AED', balance: 3000, balance_aed: 3000 },
    ];
    const links = linkedAccounts.map((a) => ({ goal_id: 'g1', account_id: a.id, holding_id: null, share_pct: 100 }));
    expect(allocatedValue('g1', links, linkedAccounts, [])).toBe(3000);
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

  it('spreads the top-up into a monthly saving, invested at the same return, that is worth exactly the top-up today', () => {
    const result = fundInPriority({ rows: [row('a', 1, '2031-09-01', 100_000)], freeMoney: 20_000, returnPct: 6, now });
    const g = result.goals[0];
    expect(g.monthsLeft).toBe(60);
    const i = 1.06 ** (1 / 12) - 1;
    // Sixty payments at that rate, valued today.
    const worthToday = g.monthly * ((1 - (1 + i) ** -60) / i);
    expect(worthToday).toBeCloseTo(g.topUp, 6);
    expect(result.monthly).toBeCloseTo(g.monthly, 9);
  });

  it('needs nothing a month for a goal already covered, and the whole top-up for one due now', () => {
    const covered = fundInPriority({ rows: [row('a', 1, '2031-09-01', 100)], freeMoney: 1000, returnPct: 6, now });
    expect(covered.goals[0].monthly).toBe(0);
    const due = fundInPriority({ rows: [row('a', 1, '2026-09-30', 100)], freeMoney: 0, returnPct: 0, now });
    expect(due.goals[0]).toMatchObject({ monthsLeft: 0, monthly: 100 });
    // A lump sum due now is not a monthly rate, so the total leaves it out.
    expect(due.monthly).toBe(0);
  });
});

// Planning audit, 1.5: one status per goal, from the one rule for its kind.
describe('goalStatuses', () => {
  const now = new Date(2026, 9, 20);
  const savings = { id: 's', type: 'savings', currency: 'AED', balance: 8000, balance_aed: 8000, archived_at: null };
  const reserve = { id: 'r', type: 'savings', currency: 'AED', balance: 20000, balance_aed: 20000, archived_at: null };
  const goal = (id, extra) => ({ id, name: id, is_shared: true, created_at: '2026-01-01T00:00:00Z', ...extra });
  const goals = [
    goal('Trip', { target_amount: 12000, target_date: '2027-04-01' }),
    goal('Licence', { target_amount: 3000, target_date: '2026-12-01' }),
    goal('House', { target_amount: 900000, target_date: null }),
    goal('Villa', { target_amount: 500000, target_date: '2035-01-01' }),
    goal('Emergency', { target_amount: 20000, target_date: null, counts_in_life_plan: false }),
    goal('Car', { target_amount: 5000, target_date: '2026-10-01' }),
  ];
  const allocations = [
    { goal_id: 'Trip', account_id: 's', share_pct: 50 },
    { goal_id: 'Licence', holding_id: 'h', share_pct: 100 },
    { goal_id: 'Emergency', account_id: 'r', share_pct: 100 },
  ];
  const args = {
    goals,
    contributions: [{ goal_id: 'Trip', amount: 1000, occurred_at: '2026-09-01' }],
    allocations,
    accounts: [savings, reserve],
    holdings: [{ id: 'h', value_aed: 10000 }],
    now,
    inflationPct: 0,
  };
  const byName = (rows) => Object.fromEntries(rows.map((r) => [r.goal.name, r]));

  it('covers a goal due within three years only from cash, with no growth', () => {
    const rows = byName(goalStatuses(args));
    // Half of an 8,000 savings account; the 1,000 logged to it is its record,
    // not added on top (Planning audit, 2.8).
    expect(rows.Trip).toMatchObject({ kind: 'near', state: 'saving', cash: 4000, remaining: 8000, monthsLeft: 6, byLabel: 'Apr 2027' });
    expect(rows.Trip.perMonth).toBeCloseTo(8000 / 6, 6);
    // A holding linked to it counts for nothing: it could be down when the bill comes.
    expect(rows.Licence).toMatchObject({ kind: 'near', state: 'saving', cash: 0, perMonth: 1500 });
    expect(rows.Car).toMatchObject({ kind: 'near', state: 'due', remaining: 5000, perMonth: null });
  });

  it('holds kept money in cash, and leaves an undated goal out of every plan', () => {
    const rows = byName(goalStatuses(args));
    expect(rows.Emergency).toMatchObject({ kind: 'kept', state: 'covered', cash: 20000, remaining: 0 });
    expect(rows.House).toMatchObject({ kind: 'undated', state: 'undated' });
  });

  it('takes a later goal\'s state from the Life plan\'s timeline', () => {
    expect(byName(goalStatuses(args)).Villa).toMatchObject({ kind: 'later', state: 'unchecked' });
    expect(byName(goalStatuses({ ...args, timeline: [{ year: 2035, short: 5000 }] })).Villa).toMatchObject({ state: 'short', year: 2035, short: 5000 });
    expect(byName(goalStatuses({ ...args, timeline: [{ year: 2035, short: 0 }] })).Villa).toMatchObject({ state: 'covered' });
  });

  it('gives the cash a month as it really falls: down once the first date passes', () => {
    const schedule = cashPerMonth(goalStatuses(args));
    expect(schedule.now).toBeCloseTo(1500 + 8000 / 6, 6);
    expect(schedule.until).toBe('Dec 2026');
    expect(schedule.after).toBeCloseTo(8000 / 6, 6);
    expect(cashPerMonth(goalStatuses({ ...args, goals: [goals[2]] }))).toBeNull();
  });

  it('halves a shared goal in one person\'s view, as every joint figure is', () => {
    const rows = byName(goalStatuses({ ...args, scopeMemberId: 'm1' }));
    expect(rows.Trip).toMatchObject({ cash: 2000, remaining: 4000 });
  });

  // Planning audit, 2.7.
  it('leaves a goal marked done out', () => {
    const done = goals.map((g) => (g.id === 'Licence' ? { ...g, done_at: '2026-10-01T08:00:00Z' } : g));
    const rows = byName(goalStatuses({ ...args, goals: done }));
    expect(rows.Licence).toBeUndefined();
    expect(cashPerMonth(Object.values(rows)).now).toBeCloseTo(8000 / 6, 6);
    expect(isDone(done[1])).toBe(true);
    expect(isDone(goals[0])).toBe(false);
    expect(doneMonth(done[1])).toBe('Oct 2026');
    expect(doneMonth(goals[0])).toBeNull();
  });

  it('measures a planned monthly amount against what the date needs', () => {
    const planned = (amounts) => goals.map((g) => (amounts[g.id] !== undefined ? { ...g, planned_monthly: amounts[g.id] } : g));
    // 8,000 to go over 6 months, 1,333.33 a month: 1,334 covers it, the
    // 1,333 shown covers it too, and 1,000 takes 8 months, to Jun 2027.
    expect(byName(goalStatuses({ ...args, goals: planned({ Trip: 1334 }) })).Trip.plan).toMatchObject({ amount: 1334, enough: true, months: 6, byLabel: 'Apr 2027' });
    expect(byName(goalStatuses({ ...args, goals: planned({ Trip: 1333 }) })).Trip.plan).toMatchObject({ enough: true, months: 6, byLabel: 'Apr 2027' });
    expect(byName(goalStatuses({ ...args, goals: planned({ Trip: 1332 }) })).Trip.plan).toMatchObject({ enough: false, months: 7 });
    expect(byName(goalStatuses({ ...args, goals: planned({ Trip: 1000 }) })).Trip.plan).toMatchObject({ enough: false, months: 8, byLabel: 'Jun 2027' });
    // A plan of 0 never covers it; no plan is no plan.
    expect(byName(goalStatuses({ ...args, goals: planned({ Trip: 0 }) })).Trip.plan).toMatchObject({ amount: 0, enough: false, months: null, byLabel: null });
    expect(byName(goalStatuses(args)).Trip).toMatchObject({ planned: null, plan: null });
    // Due now: no monthly plan is on time, but it says when it would be covered.
    expect(byName(goalStatuses({ ...args, goals: planned({ Car: 2500 }) })).Car.plan).toMatchObject({ enough: false, months: 2, byLabel: 'Dec 2026' });
  });

  it('gives an undated reserve with a plan the month it is covered by, and nothing to be on time for', () => {
    const short = goals.map((g) => (g.id === 'Emergency' ? { ...g, target_amount: 26000, planned_monthly: 1000 } : g));
    expect(byName(goalStatuses({ ...args, goals: short })).Emergency).toMatchObject({ state: 'saving', remaining: 6000, plan: { enough: null, months: 6, byLabel: 'Apr 2027' } });
  });

  it('halves a shared goal\'s plan in one person\'s view, and totals the plans beside the need', () => {
    const planned = goals.map((g) => (g.id === 'Trip' ? { ...g, planned_monthly: 1400 } : g));
    expect(byName(goalStatuses({ ...args, goals: planned, scopeMemberId: 'm1' })).Trip).toMatchObject({ planned: 700, plan: { enough: true } });
    expect(cashPerMonth(goalStatuses({ ...args, goals: planned })).planned).toBe(1400);
    expect(cashPerMonth(goalStatuses(args)).planned).toBeNull();
  });
});

// Planning audit, 2.8: a goal's pace from its one source.
describe('goalPace', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const months = (days) => days / (365.25 / 12);
  const goal = { id: 'g', created_at: '2026-01-01T00:00:00Z' };
  const savings = { id: 's', type: 'savings', currency: 'AED', balance: 10000, balance_aed: 10000, archived_at: null };
  const link = (extra) => ({ goal_id: 'g', account_id: 's', holding_id: null, share_pct: 50, ...extra });
  const event = (at, old_balance, new_balance, account_id = 's') => ({ account_id, recorded_at: at, old_balance, new_balance });
  // Opened in June at 2,000, 4,000 by August, 10,000 by October.
  const events = [event('2026-06-01T08:00:00Z', null, 2000), event('2026-08-01T08:00:00Z', 2000, 4000), event('2026-10-01T08:00:00Z', 4000, 10000)];

  it('takes what was logged over the last three months, for a goal with nothing linked', () => {
    const contributions = [
      { goal_id: 'g', amount: 900, occurred_at: '2026-09-15' },
      { goal_id: 'g', amount: 300, occurred_at: '2026-08-10' },
      { goal_id: 'g', amount: 5000, occurred_at: '2026-05-01' },
    ];
    const pace = goalPace({ goal, contributions, now });
    expect(pace).toMatchObject({ from: 'logged', months: 3 });
    expect(pace.perMonth).toBeCloseTo(1200 / months(91), 6);
  });

  it('waits for a month of record: a goal made last week has no pace yet', () => {
    expect(goalPace({ goal: { ...goal, created_at: '2026-10-13T00:00:00Z' }, contributions: [{ goal_id: 'g', amount: 500, occurred_at: '2026-10-14' }], now })).toEqual({ from: 'logged', short: true });
  });

  it('takes a linked account\'s balance change at its share, and nothing that was also logged', () => {
    const pace = goalPace({ goal, contributions: [{ goal_id: 'g', amount: 700, occurred_at: '2026-09-15' }], allocations: [link()], accounts: [savings], balanceEvents: events, now });
    // 2,000 at the window's start in July, 10,000 now: half of 8,000.
    expect(pace).toMatchObject({ from: 'linked', months: 3 });
    expect(pace.perMonth).toBeCloseTo(4000 / months(91), 6);
  });

  it('starts at the first recorded change, and waits for a month of them', () => {
    const recent = [event('2026-10-11T08:00:00Z', 4000, 6000), event('2026-10-15T08:00:00Z', 6000, 10000)];
    expect(goalPace({ goal, allocations: [link()], accounts: [savings], balanceEvents: recent, now })).toEqual({ from: 'linked', short: true });
    expect(goalPace({ goal, allocations: [link()], accounts: [savings], balanceEvents: [], now })).toEqual({ from: 'linked', short: true });
    // From 1 Sep: 4,000 then, 10,000 now, half of it over 49 days.
    const pace = goalPace({ goal, allocations: [link()], accounts: [savings], balanceEvents: [event('2026-09-01T12:00:00Z', 3000, 4000), ...recent], now });
    expect(pace.perMonth).toBeCloseTo(3000 / months(49), 6);
    expect(pace.months).toBe(2);
  });

  it('converts a rupee account\'s change at today\'s rate, and says when an account fell', () => {
    const rupees = { id: 'r', type: 'savings', currency: 'INR', balance: 50000, balance_aed: 2000, archived_at: null };
    const pace = goalPace({ goal, allocations: [link({ account_id: 'r', share_pct: 100 })], accounts: [rupees], balanceEvents: [event('2026-07-01T00:00:00Z', null, 25000, 'r')], now });
    expect(pace.perMonth).toBeCloseTo(1000 / months(91), 6);
    const fell = goalPace({ goal, allocations: [link()], accounts: [{ ...savings, balance: 1000, balance_aed: 1000 }], balanceEvents: events, now });
    expect(fell.perMonth).toBeLessThan(0);
  });

  it('measures nothing without a cash account linked, or with the history unread', () => {
    expect(goalPace({ goal, allocations: [{ goal_id: 'g', account_id: null, holding_id: 'h', share_pct: 100 }], accounts: [savings], balanceEvents: events, now })).toBeNull();
    expect(goalPace({ goal, allocations: [link()], accounts: [savings], balanceEvents: null, now })).toBeNull();
  });

  it('is on each cash goal\'s status, halved for one person\'s view of a shared goal', () => {
    const row = (scopeMemberId) =>
      goalStatuses({ goals: [{ ...goal, name: 'Trip', is_shared: true, target_amount: 30000, target_date: '2027-06-01' }], allocations: [link()], accounts: [savings], balanceEvents: events, scopeMemberId, now, inflationPct: 0 })[0];
    expect(row(null).pace.perMonth).toBeCloseTo(4000 / months(91), 6);
    expect(row('m1').pace.perMonth).toBeCloseTo(2000 / months(91), 6);
  });
});
