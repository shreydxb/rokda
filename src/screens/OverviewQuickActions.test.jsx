// Overview's quick actions on a record that needs review: "Mark reviewed"
// and "Categorise…". The outside review (E-11) found they said they had
// worked when the write failed.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

// How the next transaction update goes: 'ok', 'error' (a failed write), or
// 'none' (it changed no row: the record was deleted elsewhere).
const write = vi.hoisted(() => ({ next: 'ok', updates: [] }));
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      update: (payload) => ({
        eq: () => {
          write.updates.push(payload);
          const outcome = write.next;
          return {
            select: async () =>
              outcome === 'error' ? { data: null, error: { message: 'the connection dropped' } } : { data: outcome === 'none' ? [] : [{ id: 't1' }], error: null },
          };
        },
      }),
    }),
  },
}));

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
    accounts: [{ id: 'a1', name: 'Current account', type: 'current', currency: 'AED', balance: 20000, balance_aed: 20000, balance_as_of: '2026-10-20', is_shared: true, owner_member_id: null, archived_at: null }],
    transactions: [{ id: 't1', amount: -40, kind: 'expense', occurred_at: '2026-10-18', is_shared: true, merchant: 'Corner Shop', needs_review: true, category_id: null }],
    categories: [{ id: 'c1', name: 'Groceries', kind: 'expense', parent_id: null }],
    recurring: [],
    netWorthSnapshots: [],
    holdings: [],
    backupRecords: [],
    errors: {},
    loadedAt: new Date(),
    reload: async () => {},
  }),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
  write.next = 'ok';
  write.updates.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

async function openOverview() {
  const { default: Overview } = await import('./Overview');
  renderScreen(
    <MemoryRouter initialEntries={['/']}>
      <Overview />
    </MemoryRouter>,
  );
}

describe('Overview: quick actions say what happened', () => {
  it('says so when marking a record reviewed failed, and offers no undo', async () => {
    await openOverview();
    write.next = 'error';
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' })));
    expect(screen.getByRole('status').textContent).toMatch(/^Couldn't mark "Corner Shop" reviewed/);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('says so when a categorised record was deleted elsewhere', async () => {
    await openOverview();
    write.next = 'none';
    await act(async () => fireEvent.change(screen.getByDisplayValue('Categorise…'), { target: { value: 'c1' } }));
    expect(screen.getByRole('status').textContent).toMatch(/^Couldn't categorise "Corner Shop"/);
  });

  it('still says it worked, with an undo, when it did', async () => {
    await openOverview();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' })));
    expect(screen.getByRole('status').textContent).toMatch(/^Marked "Corner Shop" reviewed/);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });
});
