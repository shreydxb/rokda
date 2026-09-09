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
