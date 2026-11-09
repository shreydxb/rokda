import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { renderScreen } from '../../test/renderScreen';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));
const { default: Recurring } = await import('./Recurring');

const NOW = new Date('2026-10-21T09:00:00');
const bill = (over) => ({ id: over.name, amount: -100, currency: 'AED', cadence: 'monthly', interval_count: 1, is_shared: true, active: true, autopay: false, is_fixed: true, ...over });

function renderRecurring(recurring) {
  renderScreen(<Recurring household={{ id: 'hh' }} members={[]} loading={false} data={{ recurring, accounts: [], categories: [], transactions: [], reload: vi.fn() }} />);
}
// The rows in a group's main list; ended ones sit in a folded list below it.
const names = (group) => within(screen.getByRole('region', { name: group }).querySelector(':scope > .rc-list')).getAllByTestId('recurring-row').map((r) => r.querySelector('.rc-name').textContent.trim());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

// The page once listed bills in the order they were added, each with its
// status on a line of its own and "Mark paid" stacked under the row only
// where it applied (layout audit, 21 Oct).
describe('Recurring: what needs marking comes first', () => {
  it('puts a late bill, then one due soon, before the upcoming ones, and folds an ended one away', () => {
    renderRecurring([
      bill({ name: 'Rent', next_due_date: '2026-10-28' }),
      bill({ name: 'Phone', next_due_date: '2026-10-23' }),
      bill({ name: 'School fees', next_due_date: '2026-09-05' }),
      bill({ name: 'Old gym', next_due_date: '2026-03-03', ends_on: '2026-06-03' }),
    ]);
    expect(names('Bills')).toEqual(['School fees', 'Phone', 'Rent']);
    expect(screen.getByText('2 to mark paid')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Mark paid' })).toHaveLength(2);
    expect(screen.getByText('Ended (1)').closest('details').open).toBe(false);
  });

  it('says when a late bill was due, not only when the next one is', () => {
    renderRecurring([bill({ name: 'School fees', next_due_date: '2026-09-05' })]);
    expect(document.querySelector('.rc-meta').textContent).toMatch(/Late monthly · was due 5 Oct, next 5 Nov/);
  });
});

// The fresh review of B-02: a bill is settled only by a payment on its own
// account, so "Mark paid" starts the payment on that account, not the first
// one listed.
describe('Recurring: Mark paid', () => {
  it('starts the payment on the bill\'s own account', () => {
    const accounts = [
      { id: 'a-first', name: 'First bank', type: 'checking', currency: 'AED', is_shared: true, archived_at: null },
      { id: 'a-bill', name: 'Bill bank', type: 'checking', currency: 'AED', is_shared: true, archived_at: null },
    ];
    renderScreen(
      <Recurring household={{ id: 'hh' }} members={[]} loading={false}
        data={{ recurring: [bill({ name: 'Phone', next_due_date: '2026-10-23', account_id: 'a-bill' })], accounts, categories: [], transactions: [], reload: vi.fn() }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    const account = [...document.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === 'a-bill'));
    expect(account.value).toBe('a-bill');
  });
});
