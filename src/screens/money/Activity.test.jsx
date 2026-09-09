import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import Activity from './Activity';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];
const ACCOUNTS = [{ id: 'a1', name: 'ENBD', type: 'credit_card', archived_at: null, is_shared: true }];
const CATEGORIES = [{ id: 'c1', name: 'Groceries', kind: 'expense', parent_id: null }];

function renderActivity(transactions) {
  return renderScreen(
    <Activity
      household={{ id: 'h' }}
      members={MEMBERS}
      me={{ id: 'm1' }}
      loading={false}
      categoryFilter="all"
      setCategoryFilter={vi.fn()}
      data={{
        transactions,
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        reload: vi.fn().mockResolvedValue(undefined),
      }}
    />,
  );
}

describe('Activity summary line', () => {
  it('shows a count plus total out and total in, matching the design', () => {
    renderActivity([
      { id: 't1', amount: -100, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1' },
      { id: 't2', amount: 500, kind: 'income', occurred_at: '2026-09-04', is_shared: true },
    ]);
    const text = document.querySelector('.mn-count').textContent;
    expect(text).toMatch(/2 records/);
    expect(text).toMatch(/100.*out/);
    expect(text).toMatch(/500.*in/);
  });

  it('omits the out/in breakdown when there is nothing to show', () => {
    renderActivity([]);
    const text = document.querySelector('.mn-count').textContent;
    expect(text).toMatch(/0 records/);
    expect(text).not.toMatch(/out/);
  });
});

describe('Activity confidence badge', () => {
  it('flags a low-confidence transaction', () => {
    renderActivity([
      { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: 0.7, merchant: 'Carrefour' },
    ]);
    expect(screen.getByText(/low confidence/)).toBeTruthy();
  });

  it('flags a very-low-confidence transaction as needing attention', () => {
    renderActivity([
      { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: 0.4, merchant: 'Carrefour' },
    ]);
    expect(screen.getByText(/needs attention/)).toBeTruthy();
  });

  it('shows no badge for a confident or manually-entered transaction', () => {
    renderActivity([
      { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: 0.95, merchant: 'Carrefour' },
      { id: 't2', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: null, merchant: 'Manual entry' },
    ]);
    expect(screen.queryByText(/low confidence/)).toBeNull();
    expect(screen.queryByText(/needs attention/)).toBeNull();
  });

  it('prefers the needs_review flag over a confidence badge when both apply', () => {
    renderActivity([
      { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: 0.4, needs_review: true, merchant: 'Carrefour' },
    ]);
    expect(screen.getByText(/needs review/)).toBeTruthy();
    expect(screen.queryByText(/needs attention/)).toBeNull();
  });
});
