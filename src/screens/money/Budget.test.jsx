import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/dom';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen as renderBare } from '../../test/renderScreen';

// The screen reads its month from the address, so it renders inside a router.
const renderScreen = (ui) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);
import Budget from './Budget';

// What a save sends, for the editor's month (E2-2).
const { upserts, updates } = vi.hoisted(() => ({ upserts: [], updates: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: (rows) => {
        upserts.push(rows);
        return Promise.resolve({ error: null });
      },
      // A limit typed in place (the revamp, phase 4b).
      update: (row) => ({
        eq: (col, id) => ({
          select: () => {
            updates.push({ table, row, id });
            return Promise.resolve({ data: [{ id }], error: null });
          },
        }),
      }),
    }),
  },
}));

describe('Budget: household share', () => {
  const TWO = [
    { id: 'm1', display_name: 'Alex' },
    { id: 'm2', display_name: 'Sam' },
  ];
  const CATS = [
    { id: 'housing', name: 'Housing', kind: 'expense', parent_id: null },
    { id: 'rent', name: 'Rent', kind: 'expense', parent_id: 'housing' },
    { id: 'family', name: 'Family Support', kind: 'expense', parent_id: null },
    { id: 'raipur', name: 'Raipur Remittance', kind: 'expense', parent_id: 'family', owner_member_id: 'm2' },
  ];
  const renderShare = (members) =>
    renderScreen(
      <Budget
        household={{ id: 'h' }}
        me={{ id: 'm1' }}
        members={members}
        loading={false}
        data={{
          categories: CATS,
          budgets: [
            { id: 'b1', category_id: 'rent', year: 2026, month: 9, amount: 6000 },
            { id: 'b2', category_id: 'raipur', year: 2026, month: 9, amount: 400 },
          ],
          transactions: [{ id: 't1', amount: -6000, kind: 'expense', occurred_at: '2026-09-01', is_shared: true, category_id: 'rent', account_id: 'a1' }],
          accounts: [{ id: 'a1', owner_member_id: 'm1', is_shared: false }],
          recurring: [
            { id: 'r1', amount: 30000, cadence: 'monthly', next_due_date: '2026-09-30', owner_member_id: 'm1', is_shared: false },
            { id: 'r2', amount: 10000, cadence: 'monthly', next_due_date: '2026-09-25', owner_member_id: 'm2', is_shared: false },
          ],
          reload: vi.fn().mockResolvedValue(undefined),
        }}
      />,
    );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 3));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('splits shared lines by income and gives the one transfer that evens it up', () => {
    renderShare(TWO);
    const section = screen.getByRole('region', { name: 'Household share' });
    expect(section.textContent).toMatch(/Alex 75% · Sam 25%/);
    // Her part of the rent he paid: 25% of 6,000.
    expect(section.querySelector('.bud-share-settle').textContent).toMatch(/To even up so far\s*1,500 from Sam to Alex/);
    expect(section.textContent).not.toMatch(/owes/);
  });

  it('marks one person’s own lines in the budget with their initial', () => {
    renderShare(TWO);
    const row = screen.getByText('Family Support › Raipur Remittance').closest('tr');
    expect(within(row).getByRole('img', { name: 'Sam' })).toBeTruthy();
  });

  it('is not shown for a household of one', () => {
    renderShare(TWO.slice(0, 1));
    expect(screen.queryByRole('region', { name: 'Household share' })).toBeNull();
  });
});

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
const CATEGORIES = [
  { id: 'util', name: 'Utilities', kind: 'expense', parent_id: null },
  { id: 'dewa', name: 'DEWA', kind: 'expense', parent_id: 'util' },
];

function renderBudget({ budgets, transactions }) {
  return renderScreen(
    <Budget
      household={{ id: 'h' }}
      me={{ id: 'm1' }}
      members={MEMBERS}
      loading={false}
      data={{ transactions, categories: CATEGORIES, budgets, reload: vi.fn().mockResolvedValue(undefined) }}
    />,
  );
}

beforeEach(() => {
  // Early in the month (3/30 elapsed, well under the 1/3 pace-projection
  // threshold) -- the exact window where a real overspend used to be
  // invisible because "over" only ever looked at the projected close.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 3));
});

afterEach(() => {
  vi.useRealTimers();
});

// The month as the prototype lays it out (the revamp, phase 4b): the spent of
// budget with its verdict, the table with each line's usual, a limit typed in
// place, and a line's records beneath it.
describe('Budget: the month', () => {
  const CATS = [
    { id: 'food', name: 'Food', kind: 'expense', parent_id: null },
    { id: 'groc', name: 'Groceries', kind: 'expense', parent_id: 'food' },
    { id: 'dine', name: 'Dining out', kind: 'expense', parent_id: 'food' },
    { id: 'shop', name: 'Shopping', kind: 'expense', parent_id: null },
  ];
  const BUDGETS = [
    { id: 'b1', category_id: 'groc', year: 2026, month: 9, amount: 1000 },
    { id: 'b2', category_id: 'dine', year: 2026, month: 9, amount: 400 },
  ];
  const TXNS = [
    { id: 't1', amount: -300, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'groc', merchant: 'Grocer' },
    { id: 't2', amount: -450, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'dine', merchant: 'Cafe' },
    { id: 't3', amount: -50, kind: 'expense', occurred_at: '2026-09-01', is_shared: true, category_id: 'food', merchant: 'Market' },
    { id: 't4', amount: -120, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'shop', merchant: 'Store' },
    { id: 't5', amount: -30, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: null, merchant: 'Unknown' },
    // August, for the usual month.
    { id: 'a1', amount: -200, kind: 'expense', occurred_at: '2026-08-10', is_shared: true, category_id: 'dine', merchant: 'Cafe' },
  ];
  const reload = vi.fn().mockResolvedValue(undefined);
  const onOpenRecords = vi.fn();
  const render = (props = {}) =>
    renderScreen(
      <Budget household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} loading={false} onOpenRecords={onOpenRecords} data={{ transactions: TXNS, categories: CATS, budgets: BUDGETS, reload }} {...props} />,
    );
  const row = (name) => screen.getByText(name, { selector: '.bud-name' }).closest('tr');

  beforeEach(() => {
    updates.length = 0;
    reload.mockClear();
    onOpenRecords.mockClear();
  });

  it('gives the spent of budget, how far through the month it is, and the verdict', () => {
    render();
    const hero = screen.getByRole('region', { name: 'Spent of budget' });
    expect(hero.textContent).toMatch(/800\s*of 1,400/);
    expect(hero.textContent).toMatch(/57% spent · 10% of month gone/);
    expect(within(hero).getByText('Over pace')).toBeTruthy();
  });

  it('lists a group with its lines, Other for what none of them holds, and says a line is over', () => {
    render();
    expect(row('Food').textContent).toMatch(/800/);
    expect(row('Dining out').textContent).toMatch(/Over by 50/);
    expect(row('Other Food').textContent).toMatch(/50/);
  });

  it("gives each line's usual month, and says when this month is well above it", () => {
    render();
    expect(row('Dining out').querySelector('.bud-usual').textContent).toBe('+125% 200');
    expect(row('Groceries').querySelector('.bud-usual').textContent).toBe('');
  });

  it('saves a limit typed in place', async () => {
    render();
    const input = screen.getByRole('textbox', { name: 'Groceries limit' });
    fireEvent.change(input, { target: { value: '1,200' } });
    await act(async () => fireEvent.focusOut(input));
    expect(updates).toEqual([{ table: 'budgets', row: { amount: 1200 }, id: 'b1' }]);
    expect(reload).toHaveBeenCalled();
  });

  it('leaves a limit that is not a number as it was', async () => {
    render();
    const input = screen.getByRole('textbox', { name: 'Groceries limit' });
    fireEvent.change(input, { target: { value: 'lots' } });
    await act(async () => fireEvent.focusOut(input));
    expect(updates).toEqual([]);
    expect(input.value).toBe('1,000');
  });

  it("opens a line's records beneath it, with the way to all of them and to its budget", () => {
    render();
    fireEvent.click(screen.getByText('Dining out', { selector: '.bud-name' }));
    const records = screen.getByRole('region', { name: 'Dining out this month' });
    expect(within(records).getByText('Cafe')).toBeTruthy();
    fireEvent.click(within(records).getByRole('button', { name: 'All in Activity →' }));
    expect(onOpenRecords).toHaveBeenCalledWith({ categoryId: 'dine', year: 2026, month: 9 });
    fireEvent.click(within(records).getByRole('button', { name: 'Edit budget' }));
    expect(screen.getByRole('dialog', { name: 'Edit budget' })).toBeTruthy();
  });

  it('totals the budgeted lines, and opens what was spent outside them', () => {
    render();
    expect(row('Budgeted').textContent).toMatch(/800/);
    expect(row('Outside budget').textContent).toMatch(/150/);
    fireEvent.click(within(row('Outside budget')).getByRole('button', { name: '30 uncategorised' }));
    expect(onOpenRecords).toHaveBeenCalledWith({ categoryId: 'none', year: 2026, month: 9 });
    fireEvent.click(within(row('Outside budget')).getByRole('button', { name: 'Activity →' }));
    expect(onOpenRecords).toHaveBeenLastCalledWith({ year: 2026, month: 9 });
  });

  it('counts the whole group on its one budgeted line, so spending on the group is not "not started"', () => {
    renderBudget({
      budgets: [{ id: 'b1', category_id: 'dewa', year: 2026, month: 9, amount: 300 }],
      transactions: [{ id: 't1', amount: -250, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'util' }],
    });
    expect(row('Utilities › DEWA').textContent).toMatch(/250/);
  });

  it('says over by how much in the hero once the budget is passed, however early', () => {
    renderBudget({
      budgets: [{ id: 'b1', category_id: 'dewa', year: 2026, month: 9, amount: 300 }],
      transactions: [{ id: 't1', amount: -450, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'dewa' }],
    });
    expect(within(screen.getByRole('region', { name: 'Spent of budget' })).getByText('Over by 150')).toBeTruthy();
  });

  it('puts Month and Year, the month and + Budget in the header', () => {
    render();
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy();
    expect(screen.getByText('Sep 2026', { selector: '.ds-stepper-label' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Budget' })).toBeTruthy();
  });
});

describe('Budget: the year view adds up like a budget sheet', () => {
  const CATS = [
    { id: 'util', name: 'Utilities', kind: 'expense', parent_id: null },
    { id: 'dewa', name: 'DEWA', kind: 'expense', parent_id: 'util' },
    { id: 'net', name: 'Internet', kind: 'expense', parent_id: 'util' },
    { id: 'food', name: 'Groceries', kind: 'expense', parent_id: null },
  ];
  const BUDGETS = [
    { id: 'b1', category_id: 'dewa', year: 2026, month: 8, amount: 300 },
    { id: 'b2', category_id: 'net', year: 2026, month: 8, amount: 200 },
    { id: 'b3', category_id: 'dewa', year: 2026, month: 12, amount: 300 },
    { id: 'b4', category_id: 'net', year: 2026, month: 12, amount: 200 },
  ];
  const TXNS = [
    { id: 'i', amount: 5000, kind: 'income', occurred_at: '2026-08-01', is_shared: true, category_id: null },
    { id: 'd', amount: -120, kind: 'expense', occurred_at: '2026-08-03', is_shared: true, category_id: 'dewa' },
    { id: 'n', amount: -180, kind: 'expense', occurred_at: '2026-08-04', is_shared: true, category_id: 'net' },
    { id: 'p', amount: -50, kind: 'expense', occurred_at: '2026-08-05', is_shared: true, category_id: 'util' }, // on the parent
    { id: 'g', amount: -400, kind: 'expense', occurred_at: '2026-08-06', is_shared: true, category_id: 'food' }, // unbudgeted
  ];

  function openYear() {
    renderScreen(
      <Budget
        household={{ id: 'h' }}
        me={{ id: 'm1' }}
        members={MEMBERS}
        loading={false}
        data={{ transactions: TXNS, categories: CATS, budgets: BUDGETS, reload: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByText('Year'));
  }

  const cellTexts = (label) => [...screen.getByText(label, { selector: 'td' }).closest('tr').querySelectorAll('td')].map((td) => td.textContent);

  it('rolls the group up and shows what none of its subcategories holds as Other', () => {
    openYear();
    // August is column 8 (index 8 after the label cell).
    expect(cellTexts('Utilities')[8]).toBe('350');
    expect(cellTexts('DEWA')[8]).toBe('120');
    expect(cellTexts('Internet')[8]).toBe('180');
    expect(cellTexts('Other Utilities')[8]).toBe('50');
  });

  it('keeps budgeted + outside equal to all spending, and nets income against all of it', () => {
    openYear();
    expect(cellTexts('Budgeted subtotal')[8]).toBe('350');
    expect(cellTexts('Outside budget')[8]).toBe('400');
    expect(cellTexts('All spending')[8]).toBe('750');
    expect(cellTexts('Net saved')[8]).toBe('4,250');
    expect(cellTexts('Saved so far')[8]).toBe('4,250');
  });

  it('shows budgets for months ahead, and a year total and share per group', () => {
    openYear();
    const util = cellTexts('Utilities');
    expect(util[12]).toBe('500'); // December's budget
    expect(util[13]).toBe('850'); // 350 spent + 500 budgeted
    expect(util[15]).toBe('47%'); // 350 of the 750 spent
  });

  it('draws the monthly net and running total charts', () => {
    openYear();
    expect(screen.getByText('Net saved each month')).toBeTruthy();
    expect(screen.getByText('Saved so far in 2026')).toBeTruthy();
  });
});

describe('Budget: a savings category is a target, not spending', () => {
  const CATS = [
    { id: 'food', name: 'Groceries', kind: 'expense', parent_id: null },
    { id: 'save', name: 'Savings & Investments', kind: 'expense', parent_id: null, is_savings: true },
  ];
  const BUDGETS = [
    { id: 'b1', category_id: 'food', year: 2026, month: 9, amount: 2000 },
    { id: 'b2', category_id: 'save', year: 2026, month: 9, amount: 3000 },
    { id: 'b3', category_id: 'save', year: 2026, month: 10, amount: 3000 },
  ];
  const TXNS = [
    { id: 'i', amount: 10000, kind: 'income', occurred_at: '2026-09-01', is_shared: true, category_id: null },
    { id: 'g', amount: -1500, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'food' },
  ];
  const render = () =>
    renderScreen(
      <Budget household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} loading={false} data={{ transactions: TXNS, categories: CATS, budgets: BUDGETS, reload: vi.fn() }} />,
    );

  it('keeps the target out of the spending budget', () => {
    render();
    // 1,500 of 2,000 -- not of 5,000.
    expect(screen.getByRole('region', { name: 'Spent of budget' }).textContent).toMatch(/1,500\s*of 2,000/);
    expect(screen.queryByText(/of 5,000/)).toBeNull();
  });

  it('shows the target against what the month saved', () => {
    render();
    const card = screen.getByRole('region', { name: 'Savings target' });
    // 10,000 income less 1,500 spent = 8,500 saved of a 3,000 target.
    expect(card.textContent).toMatch(/8,500\s*of 3,000/);
    expect(within(card).getByText('Target met')).toBeTruthy();
    expect(card.textContent).toMatch(/85% of income saved/);
  });

  it('gives the target its own row in the year view, outside the budgeted subtotal', () => {
    render();
    fireEvent.click(screen.getByText('Year'));
    const cells = (label) => [...screen.getByText(label, { selector: 'td' }).closest('tr').querySelectorAll('td')].map((td) => td.textContent);
    expect(cells('Savings target')[10]).toBe('3,000');
    expect(cells('Budgeted subtotal')[10]).toBe('0');
    expect(screen.queryByText('Savings & Investments', { selector: 'td' })).toBeNull();
  });
});

// Round 2 of the outside review, E2-3: spending that never loaded is not
// spending of nothing. The month read "0 spent" against every budget.
describe('Budget: records that never loaded', () => {
  it('says they could not load instead of showing nothing spent, and offers to try again', () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    renderScreen(
      <Budget
        household={{ id: 'h' }}
        me={{ id: 'm1' }}
        members={[{ id: 'm1', display_name: 'Alex' }]}
        loading={false}
        data={{
          categories: [{ id: 'rent', name: 'Rent', kind: 'expense', parent_id: null }],
          budgets: [{ id: 'b1', category_id: 'rent', year: 2026, month: 9, amount: 6000 }],
          transactions: [],
          errors: { transactions: 'network' },
          loaded: {},
          reload,
        }}
      />,
    );
    expect(screen.getByText('Couldn’t load transactions.')).toBeTruthy();
    expect(screen.queryByText('Rent')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalled();
  });

  // Records that loaded once and failed on a refresh are still the
  // household's: they are kept on screen, not withheld.
  it('keeps showing records that loaded before a refresh failed', () => {
    renderScreen(
      <Budget
        household={{ id: 'h' }}
        me={{ id: 'm1' }}
        members={[{ id: 'm1', display_name: 'Alex' }]}
        loading={false}
        data={{
          categories: [{ id: 'rent', name: 'Rent', kind: 'expense', parent_id: null }],
          budgets: [{ id: 'b1', category_id: 'rent', year: 2026, month: 9, amount: 6000 }],
          transactions: [],
          errors: { transactions: 'network' },
          loaded: { transactions: true, budgets: true, categories: true },
          reload: vi.fn(),
        }}
      />,
    );
    expect(screen.queryByText('Couldn’t load transactions.')).toBeNull();
    expect(screen.getByRole('button', { name: '+ Budget' })).toBeTruthy();
  });
});

// Round 2 of the outside review, E2-2: an editor opened on this month, with no
// month in the address, followed the page's "today". Left open past midnight
// at a month's end, it saved into the next month.
describe('Budget: an open editor keeps its month', () => {
  beforeEach(() => {
    upserts.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves into the month it was opened on after the month turns', async () => {
    renderScreen(
      <Budget
        household={{ id: 'h' }}
        me={{ id: 'm1' }}
        members={[{ id: 'm1', display_name: 'Alex' }]}
        loading={false}
        data={{ categories: [{ id: 'rent', name: 'Rent', kind: 'expense', parent_id: null }], budgets: [], transactions: [], reload: vi.fn().mockResolvedValue(undefined) }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Budget' }));
    const editor = within(screen.getByRole('dialog', { name: 'Set budget' }));
    fireEvent.change(editor.getByLabelText('Monthly limit'), { target: { value: '500' } });
    fireEvent.click(editor.getByRole('button', { name: 'Rent' }));
    // A day at a time: the page sets its clock for each midnight only once
    // the one before has rendered.
    for (let day = 0; day < 2; day += 1) {
      act(() => {
        vi.advanceTimersByTime(24 * 3600 * 1000);
      });
    }
    // The page has moved on to October; the open editor has not.
    expect(screen.getByText('Nothing budgeted for Oct 2026 yet.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(editor.getByRole('button', { name: 'Save' }));
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual([expect.objectContaining({ category_id: 'rent', year: 2026, month: 9, amount: 500 })]);
  });
});
