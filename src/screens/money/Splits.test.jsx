import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// A split's amount and lines are written by the database function
// split_transaction, after the record itself, so the two always add up.
const calls = [];
// Database functions that fail once, as a dropped connection would.
const failing = new Set();
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      calls.push({ rpc: name, args });
      if (failing.delete(name)) return Promise.resolve({ error: { message: 'the connection dropped' } });
      return Promise.resolve({ error: null });
    },
    from: (table) => ({
      insert: (payload) => {
        calls.push({ insert: table, payload });
        const done = Promise.resolve({ data: null, error: null });
        return Object.assign(done, { select: () => ({ single: () => Promise.resolve({ data: { id: 'new-id' }, error: null }) }) });
      },
      update: (payload) => ({
        eq: () => {
          calls.push({ update: table, payload });
          const done = Promise.resolve({ error: null });
          // The editor reads back the row it changed.
          done.select = () => Promise.resolve({ data: [{ id: 'saved' }], error: null });
          return done;
        },
      }),
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [] }) }) }),
    }),
  },
}));

const { default: TransactionEditor } = await import('./TransactionEditor');

const ACCOUNTS = [{ id: 'card', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true }];
const CATEGORIES = [
  { id: 'groceries', name: 'Groceries', kind: 'expense', parent_id: null },
  { id: 'household', name: 'Household', kind: 'expense', parent_id: null },
];

function renderEditor(tx = null) {
  const onSaved = vi.fn();
  renderScreen(
    <TransactionEditor tx={tx} householdId="hh" accounts={ACCOUNTS} categories={CATEGORIES} members={[]} allTransactions={[]} onClose={() => {}} onSaved={onSaved} />,
  );
  return onSaved;
}

beforeEach(() => {
  calls.length = 0;
});

describe('splitting a record across categories', () => {
  it('saves a new record, then splits it with its lines', async () => {
    const onSaved = renderEditor();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'groceries' } });
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Category 2'), { target: { value: 'household' } });
    fireEvent.change(screen.getByLabelText('Amount 2'), { target: { value: '100' } });
    expect(screen.getByText('Adds up')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));

    expect(calls[0]).toMatchObject({ insert: 'transactions', payload: { amount: -500, category_id: null } });
    expect(calls[1]).toEqual({
      rpc: 'split_transaction',
      args: { p_transaction_id: 'new-id', p_lines: [{ category_id: 'groceries', amount: 400 }, { category_id: 'household', amount: 100 }], p_amount: 500 },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  // The outside review, E-02: the record is saved before its split, so a
  // retry after a failed split must only split it, never add it again.
  it('a split that fails after the record is saved is tried again on its own', async () => {
    const onSaved = renderEditor();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'groceries' } });
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Category 2'), { target: { value: 'household' } });
    fireEvent.change(screen.getByLabelText('Amount 2'), { target: { value: '100' } });
    failing.add('split_transaction');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(screen.getByText(/^Saved, but not split/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(calls.filter((c) => c.insert === 'transactions')).toHaveLength(1);
    expect(calls.filter((c) => c.rpc === 'split_transaction').map((c) => c.args.p_transaction_id)).toEqual(['new-id', 'new-id']);
    expect(onSaved).toHaveBeenCalled();
  });

  // The fresh review of group 4: what the member changed before pressing
  // again is saved too, not dropped while the editor closes as saved.
  it('a retry after a failed split saves what was changed since, then splits', async () => {
    const onSaved = renderEditor();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Merchant'), { target: { value: 'Corner Shpo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'groceries' } });
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Category 2'), { target: { value: 'household' } });
    fireEvent.change(screen.getByLabelText('Amount 2'), { target: { value: '100' } });
    failing.add('split_transaction');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(screen.getByText(/^Saved, but not split/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Merchant'), { target: { value: 'Corner Shop' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(calls.filter((c) => c.insert === 'transactions')).toHaveLength(1);
    expect(calls.filter((c) => c.update === 'transactions').map((c) => c.payload.merchant)).toEqual(['Corner Shop']);
    expect(calls.filter((c) => c.rpc === 'split_transaction')).toHaveLength(2);
    expect(onSaved).toHaveBeenCalled();
  });

  it('refuses lines that do not add up, before saving anything', async () => {
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split across categories' }));
    fireEvent.change(screen.getByLabelText('Category 1'), { target: { value: 'groceries' } });
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '400' } });
    fireEvent.change(screen.getByLabelText('Category 2'), { target: { value: 'household' } });
    fireEvent.change(screen.getByLabelText('Amount 2'), { target: { value: '50' } });
    expect(screen.getByText('50.00 left to allocate')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(screen.getByRole('alert').textContent).toBe('50.00 still to allocate.');
    expect(calls).toEqual([]);
  });

  it('turns a split record back into one category before saving the rest', async () => {
    const tx = {
      id: 't1', amount: -500, kind: 'expense', occurred_at: '2026-10-05', account_id: 'card', is_shared: true, category_id: null, is_split: true, merchant: 'Grocer',
      transaction_splits: [{ category_id: 'groceries', amount: -400 }, { category_id: 'household', amount: -100 }],
    };
    renderEditor(tx);
    expect(screen.getByLabelText('Amount 1').value).toBe('400');
    fireEvent.click(screen.getByRole('button', { name: 'One category instead' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
    expect(calls[0]).toEqual({ rpc: 'unsplit_transaction', args: { p_transaction_id: 't1', p_category_id: null } });
    expect(calls[1]).toMatchObject({ update: 'transactions', payload: { amount: -500 } });
  });

  it('changes an existing split’s total and lines in one call, not through the update', async () => {
    const tx = {
      id: 't1', amount: -500, kind: 'expense', occurred_at: '2026-10-05', account_id: 'card', is_shared: true, category_id: null, is_split: true, merchant: 'Grocer',
      transaction_splits: [{ category_id: 'groceries', amount: -400 }, { category_id: 'household', amount: -100 }],
    };
    renderEditor(tx);
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '520' } });
    fireEvent.change(screen.getByLabelText('Amount 1'), { target: { value: '420' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
    expect(calls[0].update).toBe('transactions');
    expect(calls[0].payload).not.toHaveProperty('amount');
    expect(calls[1]).toMatchObject({ rpc: 'split_transaction', args: { p_transaction_id: 't1', p_amount: 520 } });
  });
});
