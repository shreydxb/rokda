import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// A payment in rupees keeps the rupee amount beside the AED that counts: the
// AED debited when it is known, otherwise an estimate at the payment date's
// rate, marked as one (SHR-321).
const writes = [];
const rpcs = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      rpcs.push({ name, args });
      return Promise.resolve({ data: { transaction_id: 'tx-1' }, error: null });
    },
    from: (table) => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [] }) }) }),
      insert: (row) => {
        writes.push({ table, row });
        return Promise.resolve({ error: null });
      },
      update: (row) => ({
        eq: () => {
          writes.push({ table, update: row });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  },
}));

const { default: TransactionEditor } = await import('./TransactionEditor');
const { default: Inbox } = await import('./Inbox');

const ACCOUNTS = [{ id: 'acc', name: 'Current account', type: 'checking', archived_at: null, is_shared: true }];
const HOUSEHOLD = { id: 'hh', inr_per_aed: 25 };
const HISTORY = [{ base: 'AED', quote: 'INR', day: '2026-09-01', rate: 23 }];

beforeEach(() => {
  writes.length = 0;
  rpcs.length = 0;
});

function newPayment() {
  renderScreen(
    <TransactionEditor tx={null} household={HOUSEHOLD} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} fxHistory={HISTORY} onClose={() => {}} onSaved={() => {}} />,
  );
  fireEvent.change(screen.getByDisplayValue('AED'), { target: { value: 'INR' } });
  fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '23000' } });
  fireEvent.change(screen.getByDisplayValue(/^\d{4}-\d{2}-\d{2}$/), { target: { value: '2026-09-10' } });
}

describe('a payment in rupees, in the editor', () => {
  it("estimates the AED at the payment date's rate, and says so", async () => {
    newPayment();
    expect(screen.getByText(/Estimated at 1 AED = 23 INR, the rate on 1 Sept 2026/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(writes[0].row).toMatchObject({ amount: -1000, currency: 'INR', native_amount: -23000, aed_estimated: true });
  });

  it('records the AED debited when it is entered', async () => {
    newPayment();
    fireEvent.change(screen.getByLabelText('AED debited'), { target: { value: '1004.5' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add transaction' })));
    expect(writes[0].row).toMatchObject({ amount: -1004.5, currency: 'INR', native_amount: -23000, aed_estimated: false });
  });

  it('opens a saved rupee payment in rupees, with its AED debited', () => {
    const tx = { id: 't', account_id: 'acc', amount: -1004.5, currency: 'INR', native_amount: -23000, aed_estimated: false, kind: 'expense', occurred_at: '2026-09-10', is_shared: true, merchant: 'Home' };
    renderScreen(<TransactionEditor tx={tx} household={HOUSEHOLD} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} fxHistory={HISTORY} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByDisplayValue('INR')).toBeTruthy();
    expect(screen.getByDisplayValue('23000')).toBeTruthy();
    expect(screen.getByLabelText('AED debited').value).toBe('1004.5');
  });
});

describe('a payment in rupees, in the Inbox', () => {
  it('approves with both amounts, the AED estimated until it is entered', async () => {
    const item = { id: 'in-1', household_id: 'hh', status: 'pending', source: 'telegram', raw_text: 'sent 23000 INR home', parsed_amount: 23000, parsed_currency: 'INR', parsed_merchant: 'Home', parsed_date: '2026-09-10', parsed_account_id: 'acc', confidence: 0.9 };
    renderScreen(
      <Inbox household={HOUSEHOLD} members={[]} accounts={ACCOUNTS} categories={[]} loading={false} data={{ intake: [item], transactions: [], categoryRules: [], fxRateHistory: HISTORY, reload: vi.fn().mockResolvedValue(undefined) }} />,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    expect(screen.getByLabelText('Amount').value).toBe('23000');
    await act(async () => {
      screen.getByRole('button', { name: 'Approve' }).click();
    });
    expect(rpcs[0]).toMatchObject({ name: 'approve_intake', args: { p_amount: 1000, p_currency: 'INR', p_native_amount: 23000, p_aed_estimated: true } });
  });
});
