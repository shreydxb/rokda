import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/dom';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// The Supabase client is mocked at module level: this test is about which
// mutation the screen issues, not about talking to a database.
const calls = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from(table) {
      return {
        delete: () => ({
          eq: (col, value) => {
            calls.push({ op: 'delete', table, col, value });
            return Promise.resolve({ error: null });
          },
        }),
        update: (payload) => ({
          eq: (col, value) => {
            calls.push({ op: 'update', table, col, value, payload });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  },
}));

const { default: Accounts } = await import('./Accounts');

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];
const CARD = {
  id: 'card-1',
  name: 'ENBD Noon',
  type: 'credit_card',
  balance: 0,
  is_shared: true,
  archived_at: null,
  statement_day: null,
  due_day: null,
  credit_limit: null,
};
const THREE_TX = [
  { id: 't1', account_id: 'card-1', amount: -100, occurred_at: '2026-06-01', is_shared: true },
  { id: 't2', account_id: 'card-1', amount: -50, occurred_at: '2026-07-01', is_shared: true },
  { id: 't3', account_id: 'card-1', amount: -25, occurred_at: '2026-08-01', is_shared: true },
];

function renderAccounts({ accounts, transactions }) {
  const reload = vi.fn().mockResolvedValue(undefined);
  renderScreen(
    <Accounts
      household={{ id: 'h1' }}
      members={MEMBERS}
      me={MEMBERS[0]}
      loading={false}
      data={{ accounts, transactions, reload }}
    />,
  );
  return { reload };
}

async function click(el) {
  await act(async () => {
    el.click();
  });
}

describe('QA-01: removing a card must not erase its transactions', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('archives instead of deleting, and says what happens to the history', async () => {
    renderAccounts({ accounts: [CARD], transactions: THREE_TX });

    await click(screen.getByRole('button', { name: 'Remove' }));

    // The confirmation has to state the consequence before it is accepted.
    expect(screen.getByText(/Close this account\?/)).toBeTruthy();
    expect(screen.getByText(/3 transactions stay in your history/)).toBeTruthy();

    await click(screen.getByRole('button', { name: 'Close account' }));

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('update');
    expect(calls[0].table).toBe('accounts');
    expect(calls[0].value).toBe('card-1');
    expect(calls[0].payload.archived_at).toBeTruthy();
    expect(calls.some((c) => c.op === 'delete')).toBe(false);
  });

  it('deletes outright only when the account has no transactions', async () => {
    renderAccounts({ accounts: [CARD], transactions: [] });

    await click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/Delete this account\?/)).toBeTruthy();
    expect(screen.getByText(/no transactions, so nothing is lost/)).toBeTruthy();

    await click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls).toEqual([{ op: 'delete', table: 'accounts', col: 'id', value: 'card-1' }]);
  });

  it('keeps a closed account out of the open list but reachable and reopenable', async () => {
    const closed = { ...CARD, archived_at: '2026-09-05T10:00:00Z' };
    renderAccounts({ accounts: [closed], transactions: THREE_TX });

    // Not shown among open accounts…
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

    // …but reachable behind an explicit toggle.
    await click(screen.getByRole('button', { name: /Show closed \(1\)/ }));
    const section = screen.getByText('Closed accounts').parentElement;
    expect(within(section).getByText(/stay in your history and reports/)).toBeTruthy();

    await click(screen.getByRole('button', { name: 'Reopen' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('update');
    expect(calls[0].payload.archived_at).toBeNull();
  });
});

describe('Credit card "of limit used" reflects real transactions, not just a manual balance', () => {
  it('shows real billing-cycle spend even when the balance was never manually confirmed', () => {
    const card = { ...CARD, statement_day: 25, credit_limit: 31000, balance: 0 };
    const now = new Date(2026, 8, 10); // 10 Sept, inside the 25 Aug - 25 Sept cycle
    const transactions = [
      { id: 't1', account_id: 'card-1', amount: -12000, occurred_at: '2026-09-03', is_shared: true },
      { id: 't2', account_id: 'card-1', amount: -3000, occurred_at: '2026-09-05', is_shared: true },
    ];
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      renderAccounts({ accounts: [card], transactions });
      const text = document.querySelector('.wl-card').textContent;
      expect(text).toMatch(/48%|15,000/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the manual balance snapshot when there is no statement day to compute a cycle from', () => {
    const card = { ...CARD, statement_day: null, credit_limit: 10000, balance: 2500 };
    renderAccounts({ accounts: [card], transactions: [] });
    const text = document.querySelector('.wl-card').textContent;
    expect(text).toMatch(/25%/);
  });
});

describe('Accounts: group by type / by owner toggle', () => {
  const SAVINGS = { id: 'sv1', name: 'Emirates NBD Savings', type: 'savings', balance: 5000, balance_as_of: '2026-09-01', is_shared: true, archived_at: null, owner_member_id: null };
  const PERSONAL = { id: 'ch1', name: "Shreyash's checking", type: 'checking', balance: 3000, balance_as_of: '2026-09-01', is_shared: false, archived_at: null, owner_member_id: 'm1' };

  it('defaults to grouping by type', () => {
    renderAccounts({ accounts: [SAVINGS, PERSONAL], transactions: [] });
    expect(screen.getByRole('button', { name: 'By type' }).dataset.active).toBe('true');
    expect(screen.getByText('Savings')).toBeTruthy();
    expect(screen.getByText('Checking')).toBeTruthy();
  });

  it('switches to grouping by owner, with Joint first', () => {
    renderAccounts({ accounts: [SAVINGS, PERSONAL], transactions: [] });
    fireEvent.click(screen.getByRole('button', { name: 'By owner' }));
    expect(screen.getByText('Joint')).toBeTruthy();
    expect(screen.getByText('Shreyash')).toBeTruthy();
  });
});
