import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import Budget from './Budget';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];
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

describe('Budget: over-budget shows red and "over by", even too early to project', () => {
  it('flags a subcategory already spent past its limit before a projection is possible', () => {
    renderBudget({
      budgets: [{ id: 'b1', category_id: 'dewa', year: 2026, month: 9, amount: 300 }],
      transactions: [{ id: 't1', amount: -450, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'dewa' }],
    });
    expect(screen.getByText(/over by/i)).toBeTruthy();
    expect(document.querySelector('.bud-bar-over')).toBeTruthy();
  });

  it('the hero note says "Already X over budget" instead of "too early to project"', () => {
    renderBudget({
      budgets: [{ id: 'b1', category_id: 'dewa', year: 2026, month: 9, amount: 300 }],
      transactions: [{ id: 't1', amount: -450, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'dewa' }],
    });
    expect(screen.getByText(/Already.*over budget/i)).toBeTruthy();
  });
});

describe('Budget: single-budgeted-subcategory rollup fixes false "not started"', () => {
  it('shows the parent-posted spend on the one budgeted subcategory instead of "not started"', () => {
    renderBudget({
      budgets: [{ id: 'b1', category_id: 'dewa', year: 2026, month: 9, amount: 300 }],
      // Posted directly to the parent "Utilities", not the "DEWA" subcategory
      // -- exactly the real mis-categorisation this app already tolerates.
      transactions: [{ id: 't1', amount: -250, kind: 'expense', occurred_at: '2026-09-02', is_shared: true, category_id: 'util' }],
    });
    fireEvent.click(screen.getByText('Utilities'));
    expect(screen.queryByText('not started')).toBeNull();
    expect(screen.getAllByText(/250/).length).toBeGreaterThan(0);
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
