import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// "Both are real" on a new record is remembered once the record is saved, as
// a confirmed pair, so the monthly review never asks about the two again.
const writes = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: () => Promise.resolve({ error: null }),
    from: (table) => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [] }) }) }),
      insert: (row) => {
        writes.push({ table, row });
        const done = Promise.resolve({ error: null });
        done.select = () => ({ single: () => Promise.resolve({ data: { id: 'new-record' }, error: null }) });
        return done;
      },
    }),
  },
}));

const { default: TransactionEditor } = await import('./TransactionEditor');

const ACCOUNTS = [{ id: 'card', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true }];
const today = new Date();
const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const earlier = { id: 'earlier', account_id: 'card', merchant: 'Cafe', amount: -25, kind: 'expense', occurred_at: iso, is_shared: true };

function editor() {
  return renderScreen(<TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[earlier]} onClose={() => {}} onSaved={() => {}} />);
}

beforeEach(() => {
  writes.length = 0;
});

describe('a new record like one already there', () => {
  it('remembers the pair when both are said to be real', async () => {
    editor();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '25' } });
    fireEvent.change(screen.getByPlaceholderText('Type a merchant name'), { target: { value: 'Cafe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Both are real' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(writes.map((w) => w.table)).toEqual(['transactions', 'transaction_links']);
    expect(writes[1].row).toEqual({ household_id: 'hh', kind: 'duplicate_confirmed', from_transaction_id: 'earlier', to_transaction_id: 'new-record' });
  });

  it('remembers nothing when the warning was left alone', async () => {
    editor();
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '25' } });
    fireEvent.change(screen.getByPlaceholderText('Type a merchant name'), { target: { value: 'Cafe' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(writes.map((w) => w.table)).toEqual(['transactions']);
  });
});
