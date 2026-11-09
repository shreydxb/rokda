// The outside review, E-03: Overview's Accounts list after a failed read
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
  it('says so in the Accounts list', async () => {
    const { default: Overview } = await import('./Overview');
    renderScreen(
      <MemoryRouter initialEntries={['/']}>
        <Overview />
      </MemoryRouter>,
    );
    // Not a new household: the "Day one" welcome is only for one with nothing
    // recorded, not one whose records did not arrive.
    expect(screen.queryByText('Day one')).toBeNull();
    expect(screen.queryByText('No accounts yet.')).toBeNull();
    const list = [...document.querySelectorAll('.ov-section-head')].find((h) => h.textContent.startsWith('Accounts')).parentElement;
    expect(list.textContent).toContain('Couldn’t load accounts.');
  });
});
