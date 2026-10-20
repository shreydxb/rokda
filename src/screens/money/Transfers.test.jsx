import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// Every transfer write goes through a database function that changes both
// sides together; these check the screens call the right one with the right
// sides, and refuse what the database would.
const rpcs = [];
const inserts = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      rpcs.push({ name, args });
      return Promise.resolve({ error: null });
    },
    from: (table) => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [] }) }) }),
      insert: (rows) => {
        inserts.push({ table, rows });
        return Promise.resolve({ error: null });
      },
    }),
  },
}));

const { default: TransferEditor } = await import('./TransferEditor');
const { default: TransactionEditor } = await import('./TransactionEditor');

const ACCOUNTS = [
  { id: 'current', name: 'Current account', type: 'checking', archived_at: null, is_shared: true },
  { id: 'card', name: 'Bank card', type: 'credit_card', archived_at: null, is_shared: true },
];

beforeEach(() => {
  rpcs.length = 0;
  inserts.length = 0;
});

describe('TransferEditor', () => {
  it('records a new transfer as both sides at once', async () => {
    const onSaved = vi.fn();
    renderScreen(<TransferEditor transfer={null} householdId="hh" accounts={ACCOUNTS} members={[]} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1200' } });
    fireEvent.change(screen.getByLabelText('To account'), { target: { value: 'card' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transfer' })));
    expect(rpcs).toEqual([
      {
        name: 'record_transfer',
        args: expect.objectContaining({ p_household_id: 'hh', p_from_account_id: 'current', p_to_account_id: 'card', p_amount: 1200, p_is_shared: true }),
      },
    ]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('refuses a transfer from an account to itself', async () => {
    renderScreen(<TransferEditor transfer={null} householdId="hh" accounts={ACCOUNTS} members={[]} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('To account'), { target: { value: 'current' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transfer' })));
    expect(screen.getByRole('alert').textContent).toBe('Choose two different accounts.');
    expect(rpcs).toEqual([]);
  });

  const existing = {
    link: { id: 'link-1' },
    out: { id: 'o', account_id: 'current', amount: -300, occurred_at: '2026-10-10', note: null, is_shared: true },
    in: { id: 'i', account_id: 'card', amount: 300, occurred_at: '2026-10-10', note: null, is_shared: true },
  };

  it('edits both sides of an existing transfer, and asks before unlinking or deleting', async () => {
    renderScreen(<TransferEditor transfer={existing} householdId="hh" accounts={ACCOUNTS} members={[]} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByLabelText('From account').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '320' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
    expect(rpcs[0]).toEqual({ name: 'update_transfer', args: { p_link_id: 'link-1', p_amount: 320, p_occurred_at: '2026-10-10', p_note: '' } });
    // The database function records nothing, so each side's history is written here.
    expect(inserts).toEqual([
      {
        table: 'transaction_edits',
        rows: [
          { transaction_id: existing.out.id, field: 'amount', old_value: '−300', new_value: '−320' },
          { transaction_id: existing.in.id, field: 'amount', old_value: '+300', new_value: '+320' },
        ],
      },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(rpcs).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Make two records?' })));
    expect(rpcs[1]).toEqual({ name: 'unlink_transfer', args: { p_link_id: 'link-1' } });
  });
});

describe('TransactionEditor and transfers', () => {
  it('offers to make a record and its other side one transfer, money-out first', async () => {
    const arrival = { id: 'i', account_id: 'card', amount: 1200, kind: 'income', occurred_at: '2026-10-11', merchant: 'Payment received' };
    const payment = { id: 'o', account_id: 'current', amount: -1200, kind: 'expense', occurred_at: '2026-10-10', merchant: 'Card payment', is_shared: true };
    const onSaved = vi.fn();
    renderScreen(
      <TransactionEditor tx={arrival} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[payment, arrival]} onClose={() => {}} onSaved={onSaved} />,
    );
    expect(screen.getByText('This looks like one side of a transfer')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Make these one transfer' })));
    expect(rpcs).toEqual([{ name: 'link_transfer', args: { p_out_transaction_id: 'o', p_in_transaction_id: 'i' } }]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('offers a switch to a transfer on a new record', () => {
    const onSwitch = vi.fn();
    renderScreen(
      <TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[]} onClose={() => {}} onSaved={() => {}} onSwitchToTransfer={onSwitch} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(onSwitch).toHaveBeenCalled();
  });
});
