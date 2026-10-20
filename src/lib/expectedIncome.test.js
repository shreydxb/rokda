import { describe, expect, it } from 'vitest';
import { expectedDatesLabel, expectedIncome } from './expectedIncome';

// Pay on the 25th and the last day, as a household's two salaries might land.
const SALARY_A = { id: 'r1', name: 'Salary A', amount: 10000, cadence: 'monthly', next_due_date: '2026-10-25', is_shared: true, active: true };
const SALARY_B = { id: 'r2', name: 'Salary B', amount: 8000, cadence: 'monthly', next_due_date: '2026-10-30', is_shared: false, owner_member_id: 'm2', active: true };
const BILL = { id: 'r3', name: 'Rent', amount: -5000, cadence: 'monthly', next_due_date: '2026-10-01', is_shared: true, active: true };
const income = (amount, occurred_at) => ({ id: occurred_at + amount, amount, kind: 'income', occurred_at, is_shared: true });

const OCT_1 = new Date(2026, 9, 1);
const at = (y, m, d) => new Date(y, m, d, 12);

describe('expectedIncome: pay due this period and not yet recorded', () => {
  it('lists each salary still to come this month, and leaves bills out', () => {
    const { items, total } = expectedIncome([SALARY_A, SALARY_B, BILL], [], { kind: 'mtd', start: OCT_1, now: at(2026, 9, 20) });
    expect(items.map((i) => i.name)).toEqual(['Salary A', 'Salary B']);
    expect(total).toBe(18000);
  });

  it('drops a salary once it is recorded, near its date and near its amount', () => {
    const { items } = expectedIncome([SALARY_A, SALARY_B], [income(9800, '2026-10-24')], { kind: 'mtd', start: OCT_1, now: at(2026, 9, 26) });
    expect(items.map((i) => i.name)).toEqual(['Salary B']);
  });

  it('keeps it expected when what arrived is a different amount, or a refund', () => {
    const refund = { ...income(10000, '2026-10-25'), kind: 'refund' };
    const { items } = expectedIncome([SALARY_A], [income(4000, '2026-10-25'), refund], { kind: 'mtd', start: OCT_1, now: at(2026, 9, 26) });
    expect(items.map((i) => i.name)).toEqual(['Salary A']);
  });

  it('stops calling it expected once its window has passed: it is late then', () => {
    const { items } = expectedIncome([{ ...SALARY_A, next_due_date: '2026-10-05' }], [], { kind: 'mtd', start: OCT_1, now: at(2026, 9, 20) });
    expect(items).toEqual([]);
  });

  it('counts every date left in a quarter, and stops at a schedule\'s end', () => {
    const quarter = expectedIncome([SALARY_A, { ...SALARY_B, ends_on: '2026-11-30' }], [], { kind: 'qtd', start: OCT_1, now: at(2026, 9, 20) });
    expect(quarter.items.map((i) => `${i.name} ${i.due.getMonth() + 1}/${i.due.getDate()}`)).toEqual([
      'Salary A 10/25',
      'Salary B 10/30',
      'Salary A 11/25',
      'Salary B 11/30',
      'Salary A 12/25',
    ]);
  });

  it('follows the scope: half of a shared salary, none of the partner\'s own', () => {
    const { items, total } = expectedIncome([SALARY_A, SALARY_B], [], { kind: 'mtd', start: OCT_1, now: at(2026, 9, 20), scopeMemberId: 'm1' });
    expect(items.map((i) => i.name)).toEqual(['Salary A']);
    expect(total).toBe(5000);
  });

  it('ignores a paused schedule', () => {
    expect(expectedIncome([{ ...SALARY_A, active: false }], [], { kind: 'mtd', start: OCT_1, now: at(2026, 9, 20) }).items).toEqual([]);
  });
});

describe('expectedDatesLabel', () => {
  const on = (...dates) => dates.map(([m, d]) => ({ due: new Date(2026, m, d) }));
  it('names the month once for dates in the same month', () => {
    expect(expectedDatesLabel(on([9, 25]))).toBe('25 Oct');
    expect(expectedDatesLabel(on([9, 25], [9, 30]))).toBe('25 and 30 Oct');
    expect(expectedDatesLabel(on([9, 25], [10, 25], [10, 30]))).toBe('25 Oct, 25 and 30 Nov');
  });
});
