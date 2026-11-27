// The review of the whole revamp: with the transactions and recurring bills
// never loaded, the cockpit said "All clear", Income 0 · Spent 0, "No
// recurring bills or income set up yet", "No spending this month" and "No
// transactions yet", and only the top banner said anything failed. What
// rests on a source that never loaded is withheld and says why.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({
    household: { id: 'hh', name: 'Test' },
    members: [{ id: 'm1', display_name: 'Partner A' }],
    me: { id: 'm1', display_name: 'Partner A' },
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
vi.mock('./usePlanningData', async () => {
  const { emptyPlanning } = await import('../test/planningStub');
  return { usePlanningData: () => emptyPlanning() };
});
vi.mock('./useOverviewData', async (importOriginal) => ({
  ...(await importOriginal()),
  useOverviewData: () => ({
    loading: false,
    accounts: [{ id: 'a1', household_id: 'hh', name: 'Bank', type: 'checking', currency: 'AED', balance: 5000, balance_aed: 5000, balance_as_of: '2026-10-19T08:00:00Z', is_shared: true, owner_member_id: null, archived_at: null }],
    transactions: [],
    categories: [],
    recurring: [],
    netWorthSnapshots: [],
    holdings: [],
    backupRecords: [],
    errors: { transactions: 'timeout', recurring: 'timeout' },
    loaded: { accounts: true, categories: true, holdings: true, netWorthSnapshots: true, backupRecords: true },
    loadedAt: null,
    reload: async () => {},
  }),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Overview: transactions and recurring bills that never loaded', () => {
  it('withholds what rests on them, and never says all clear', async () => {
    const { default: Overview } = await import('./Overview');
    renderScreen(
      <MemoryRouter initialEntries={['/']}>
        <Overview />
      </MemoryRouter>,
    );
    const text = document.body.textContent;
    expect(screen.queryByRole('heading', { name: 'All clear' })).toBeNull();
    expect(text).not.toContain('All clear');
    expect(text).not.toContain('No recurring bills or income set up yet.');
    expect(text).not.toContain('No spending this month.');
    expect(text).not.toContain('No transactions yet.');
    expect(text).not.toContain('0 transactions');
    expect(text).not.toContain('no transactions');
    const month = screen.getByRole('region', { name: 'This month' });
    expect(month.textContent).toContain('Couldn’t load transactions.');
    expect(month.textContent).not.toContain('Spent');
    expect(screen.getByRole('region', { name: 'Next 30 days' }).textContent).toContain('Couldn’t load recurring bills');
    // The Data chip's checks rest on the transactions too.
    expect(screen.queryByRole('button', { name: /to check/i })).toBeNull();
  });
});
