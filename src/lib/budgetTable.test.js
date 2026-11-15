import { describe, it, expect } from 'vitest';
import { budgetTable, lineRecords, paceVerdict } from './budgetTable';
import { budgetGroupSpend } from './budget';

const pace = (over) => ({ elapsedFraction: 0.5, isPast: false, isFuture: false, isCurrentMonth: true, canProject: true, ...over });

// The hero's and each line's one-word verdict (the revamp, phase 4b;
// design/prototype budMonth): over by an amount, ahead of the month's pace by
// more than ten points, on pace, or within budget once the month is over.
describe('paceVerdict', () => {
  it('says over by how much once the limit is passed', () => {
    expect(paceVerdict(560, 500, pace())).toEqual({ label: 'Over by 60', tone: 'neg' });
  });

  it('says over pace when spending is more than ten points ahead of the month', () => {
    expect(paceVerdict(310, 500, pace())).toEqual({ label: 'Over pace', tone: 'warn' });
    expect(paceVerdict(300, 500, pace())).toEqual({ label: 'On pace', tone: 'pos' });
  });

  it('says within budget for a finished month, and not started for one ahead', () => {
    expect(paceVerdict(480, 500, pace({ isPast: true, isCurrentMonth: false, elapsedFraction: 1 }))).toEqual({ label: 'Within budget', tone: 'pos' });
    expect(paceVerdict(0, 500, pace({ isFuture: true, isCurrentMonth: false, elapsedFraction: 0 }))).toEqual({ label: 'Not started', tone: 'neutral' });
  });

  // The fresh review of 4b: rent paid on the 1st put most households "over
  // pace" for half of every month. The month's pace says nothing until a
  // third of it has gone, as Budget's projection always waited (monthPace).
  it('says nothing of the pace until a third of the month has gone, short of the limit', () => {
    const early = pace({ elapsedFraction: 0.1, canProject: false });
    expect(paceVerdict(600, 1000, early)).toBeNull();
    expect(paceVerdict(1100, 1000, early)).toEqual({ label: 'Over by 100', tone: 'neg' });
  });

  it('says nothing without a limit', () => {
    expect(paceVerdict(10, 0, pace())).toBeNull();
  });
});

const CATS = [
  { id: 'food', name: 'Food', kind: 'expense', parent_id: null },
  { id: 'groc', name: 'Groceries', kind: 'expense', parent_id: 'food' },
  { id: 'dine', name: 'Dining out', kind: 'expense', parent_id: 'food' },
  { id: 'home', name: 'Housing', kind: 'expense', parent_id: null },
  { id: 'rent', name: 'Rent', kind: 'expense', parent_id: 'home' },
  { id: 'fun', name: 'Fun', kind: 'expense', parent_id: null },
  { id: 'shop', name: 'Shopping', kind: 'expense', parent_id: null },
];
const catById = new Map(CATS.map((c) => [c.id, c]));
const NOW = new Date(2026, 9, 20, 12);
const tx = (id, category_id, amount, day = '2026-10-05') => ({ id, category_id, amount, kind: amount < 0 ? 'expense' : 'refund', occurred_at: day, is_shared: true, account_id: 'a' });

describe('budgetTable', () => {
  const budgets = [
    { id: 'b1', category_id: 'groc', amount: 1000, year: 2026, month: 10 },
    { id: 'b2', category_id: 'dine', amount: 400, year: 2026, month: 10 },
    { id: 'b3', category_id: 'rent', amount: 6000, year: 2026, month: 10 },
    { id: 'b4', category_id: 'fun', amount: 200, year: 2026, month: 10 },
  ];
  const transactions = [
    tx('t1', 'groc', -600),
    tx('t2', 'dine', -450),
    tx('t3', 'food', -50),
    tx('t4', 'rent', -6000),
    tx('t5', 'shop', -300),
    tx('t6', null, -70),
    // Two earlier months, for the usual.
    tx('s1', 'groc', -800, '2026-09-05'),
    tx('a1', 'groc', -1000, '2026-08-05'),
    tx('s2', 'dine', -200, '2026-09-06'),
  ];
  const spend = budgetGroupSpend(transactions, budgets.map((b) => b.category_id), catById, 2026, 10, null, NOW);
  const table = budgetTable({ budgets, catById, spend, transactions, year: 2026, month: 10, scopeMemberId: null });

  it('gives a group with several lines a header, its lines, and Other for what none of them holds', () => {
    const food = table.sections[0];
    expect(food.group).toMatchObject({ id: 'food', name: 'Food', spent: 1100, limit: 1400 });
    expect(food.lines.map((l) => [l.name, l.spent, l.limit])).toEqual([
      ['Groceries', 600, 1000],
      ['Dining out', 450, 400],
      ['Other Food', 50, null],
    ]);
  });

  it('gives the usual month over up to six earlier months with records', () => {
    const [groceries, dining] = table.sections[0].lines;
    expect(groceries.usual).toBe(900);
    expect(dining.usual).toBe(100);
    expect(table.sections[0].group.usual).toBe(1000);
  });

  it('makes a group with one budgeted line one row, counting the whole group', () => {
    const housing = table.sections[1];
    expect(housing.group).toBeNull();
    expect(housing.lines).toEqual([expect.objectContaining({ name: 'Housing › Rent', spent: 6000, limit: 6000, recordsCategoryId: 'home', budget: budgets[2] })]);
    expect(table.sections[2].lines[0]).toMatchObject({ name: 'Fun', spent: 0, limit: 200, usual: null });
  });

  it('totals the budgeted lines, and what was spent outside them, uncategorised apart', () => {
    expect(table.budgeted).toEqual({ spent: 7100, limit: 7600 });
    expect(table.outside).toBe(370);
    expect(table.uncategorised).toBe(70);
  });
});

// The fresh review of 4b: a group budgeted alongside its own lines has a
// "· general" line, and its records are those filed to the group itself.
describe('budgetTable: a group budgeted alongside its lines', () => {
  it("lists only the group's own records under its general line", () => {
    const budgets = [
      { id: 'g', category_id: 'food', amount: 500, year: 2026, month: 10 },
      { id: 'b', category_id: 'groc', amount: 1000, year: 2026, month: 10 },
    ];
    const transactions = [tx('own', 'food', -50), tx('sub', 'groc', -600)];
    const spend = budgetGroupSpend(transactions, budgets.map((b) => b.category_id), catById, 2026, 10, null, NOW);
    const { sections } = budgetTable({ budgets, catById, spend, transactions, year: 2026, month: 10, scopeMemberId: null });
    const general = sections[0].lines.find((l) => l.name === 'Food · general');
    expect(general).toMatchObject({ spent: 50, ownOnly: true });
    expect(lineRecords(transactions, general.recordsCategoryId, CATS, 2026, 10, null, NOW, { ownOnly: general.ownOnly }).map((r) => r.t.id)).toEqual(['own']);
  });
});

// A line's records, opened beneath it.
describe('lineRecords', () => {
  it("lists the month's posted spending in the line's categories, newest first, with each one's amount in them", () => {
    const transactions = [
      tx('a', 'groc', -40, '2026-10-02'),
      tx('b', 'food', -20, '2026-10-09'),
      tx('c', 'dine', -30, '2026-10-05'),
      tx('d', 'groc', -99, '2026-09-30'),
      tx('e', 'groc', -10, '2026-10-25'),
    ];
    const rows = lineRecords(transactions, 'food', CATS, 2026, 10, null, NOW);
    expect(rows.map((r) => [r.t.id, r.amount])).toEqual([
      ['b', -20],
      ['c', -30],
      ['a', -40],
    ]);
    expect(lineRecords(transactions, 'groc', CATS, 2026, 10, null, NOW).map((r) => r.t.id)).toEqual(['a']);
  });
});
