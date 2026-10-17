import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// A refund is linked to its purchase through link_refund(), after the refund
// is saved, and unlinked through unlink_refund(); these check the editor
// offers the right purchases and calls each with the right records.
const rpcs = [];
const updates = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      rpcs.push({ name, args });
      return Promise.resolve({ error: null });
    },
    from: () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [] }) }) }),
      insert: () => {
        const done = Promise.resolve({ error: null });
        done.select = () => ({ single: () => Promise.resolve({ data: { id: 'new-refund' }, error: null }) });
        return done;
      },
      update: (row) => ({
        eq: () => {
          updates.push(row);
          return Promise.resolve({ error: null });
        },
      }),
    }),
  },
}));

const { default: TransactionEditor } = await import('./TransactionEditor');

const ACCOUNTS = [
  { id: 'card', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true },
  { id: 'current', name: 'Current account', type: 'checking', archived_at: null, is_shared: true },
];
const today = new Date();
const daysAgo = (n) => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const purchase = { id: 'p', account_id: 'card', amount: -200, kind: 'expense', merchant: 'Shop', category_id: null, occurred_at: daysAgo(10), is_shared: true };
const elsewhere = { id: 'x', account_id: 'current', amount: -200, kind: 'expense', merchant: 'Cafe', category_id: null, occurred_at: daysAgo(5), is_shared: true };

function editor(props) {
  return renderScreen(
    <TransactionEditor householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[purchase, elsewhere]} onClose={() => {}} onSaved={() => {}} {...props} />,
  );
}

beforeEach(() => {
  rpcs.length = 0;
  updates.length = 0;
});

describe('refund linking in the editor', () => {
  it('offers purchases from the same shop or card, and links the chosen one once the refund is saved', async () => {
    editor({ tx: null, initial: { type: 'refund' } });
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50' } });
    fireEvent.change(screen.getByPlaceholderText('Type a merchant name'), { target: { value: 'SHOP' } });
    const group = screen.getByRole('group', { name: 'Refund for' });
    expect(within(group).queryByText('Cafe')).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: /Shop/ }));
    expect(within(group).getByRole('button', { name: /Shop/ }).getAttribute('aria-pressed')).toBe('true');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(rpcs).toEqual([{ name: 'link_refund', args: { p_purchase_id: 'p', p_refund_id: 'new-refund' } }]);
  });

  it('saves a refund without a purchase when none is chosen', async () => {
    editor({ tx: null, initial: { type: 'refund' } });
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(rpcs).toEqual([]);
  });

  const refund = { id: 'r', account_id: 'card', amount: 50, kind: 'refund', merchant: 'Shop', category_id: null, occurred_at: daysAgo(2), is_shared: true };
  const links = [{ id: 'link-1', kind: 'refund', from_transaction_id: 'p', to_transaction_id: 'r' }];

  it('shows a linked refund’s purchase, and unlinks it after asking', async () => {
    editor({ tx: refund, allTransactions: [purchase, refund], links });
    const group = screen.getByRole('group', { name: 'Refund for' });
    expect(within(group).getByText('Shop')).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'Unlink' }));
    expect(rpcs).toEqual([]);
    await act(async () => fireEvent.click(within(group).getByRole('button', { name: 'Unlink it?' })));
    expect(rpcs).toEqual([{ name: 'unlink_refund', args: { p_link_id: 'link-1' } }]);
  });

  it('files a linked refund under its purchase, and never sends a category of its own', async () => {
    editor({ tx: { ...refund, category_id: 'groceries' }, allTransactions: [purchase, refund], links, categories: [{ id: 'groceries', name: 'Groceries', kind: 'expense' }] });
    expect(screen.getByText('Follows the purchase it refunds. Unlink it to file it elsewhere.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Split across categories' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
    expect(updates[0]).not.toHaveProperty('category_id');
    expect(updates[0]).toMatchObject({ amount: 50, kind: 'refund' });
  });

  it('unlinks a refund first when it is changed to another type', async () => {
    editor({ tx: refund, allTransactions: [purchase, refund], links });
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
    expect(rpcs[0]).toEqual({ name: 'unlink_refund', args: { p_link_id: 'link-1' } });
  });

  it('lists a purchase’s refunds', () => {
    editor({ tx: purchase, allTransactions: [purchase, refund], links });
    const group = screen.getByRole('group', { name: 'Refunded' });
    expect(within(group).getByText('+50')).toBeTruthy();
  });
});
