// The outside review, E-03: after a failed read of the accounts, Overview
// says it could not load them, not "No accounts yet."
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
// Overview also reads Planning's records, for its Plan strip.
vi.mock('./usePlanningData', async () => {
  const { emptyPlanning } = await import('../test/planningStub');
  return { usePlanningData: () => emptyPlanning() };
});
vi.mock('./useOverviewData', async (importOriginal) => ({
  ...(await importOriginal()),
  useOverviewData: () => ({
    loading: false,
    accounts: [],
    transactions: [],
    categories: [],
    recurring: [],
    netWorthSnapshots: [],
    holdings: [],
    backupRecords: [],
    errors: { accounts: 'timeout' },
    loaded: {},
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

describe('Overview: accounts that failed to load', () => {
  // The revamp (phase 3): the Accounts list left Overview for Wealth; the
  // failure is named at the top, and net worth is withheld rather than
  // worked out without them.
  it('says so, and withholds net worth', async () => {
    const { default: Overview } = await import('./Overview');
    renderScreen(
      <MemoryRouter initialEntries={['/']}>
        <Overview />
      </MemoryRouter>,
    );
    // Not a new household: the empty welcome is only for one with nothing
    // recorded, not one whose records did not arrive.
    expect(screen.queryByText('Nothing recorded yet.')).toBeNull();
    expect(screen.queryByText('No accounts yet.')).toBeNull();
    expect(document.body.textContent).toContain('Couldn’t load accounts.');
    const card = screen.getByRole('region', { name: 'Net worth' });
    expect(card.textContent).toContain('Not available');
  });
});
