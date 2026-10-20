import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderScreen } from '../../test/renderScreen';

// A refund's history shows the purchase's edits beside its own, so "why did
// this refund's category move?" is answered without opening the purchase.
const EDITS = [
  { id: 'e1', transaction_id: 'p', field: 'category', old_value: 'Groceries', new_value: 'Dining out', edited_at: '2026-10-15T10:00:00Z', edited_by: 'm1' },
  { id: 'e2', transaction_id: 'r', field: 'category', old_value: 'Groceries', new_value: 'Dining out (follows the purchase it refunds)', edited_at: '2026-10-15T10:00:01Z', edited_by: 'm1' },
];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: (column, id) => ({ order: () => Promise.resolve({ data: EDITS.filter((e) => e[column] === id) }) }),
      }),
    }),
  },
}));

const { default: TransactionEditor } = await import('./TransactionEditor');

const MEMBERS = [{ id: 'm1', display_name: 'Partner A' }];
const purchase = { id: 'p', kind: 'expense', amount: -200, merchant: 'Corner Shop', occurred_at: '2026-10-03', account_id: 'a1', is_shared: true };
const refund = { id: 'r', kind: 'refund', amount: 50, merchant: 'Corner Shop', occurred_at: '2026-10-12', account_id: 'a1', is_shared: true };
const links = [{ id: 'l1', kind: 'refund', from_transaction_id: 'p', to_transaction_id: 'r' }];

describe('A refund\'s history, with its purchase', () => {
  it('shows the purchase\'s change and the refund following it as one save', async () => {
    renderScreen(
      <TransactionEditor
        tx={refund}
        householdId="hh"
        accounts={[{ id: 'a1', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true }]}
        categories={[]}
        members={MEMBERS}
        allTransactions={[purchase, refund]}
        links={links}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByText('History, with linked records')).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.te-history-line')).toHaveLength(2));
    const lines = [...document.querySelectorAll('.te-history-line')].map((l) => l.textContent);
    expect(lines).toEqual([
      'This refund: Category Groceries → Dining out (follows the purchase it refunds)',
      'The purchase · Corner Shop · 3 Oct: Category Groceries → Dining out',
    ]);
    expect(document.querySelector('.te-history .mn-row').textContent).toMatch(/^15 Oct · Partner A/);
  });
});
