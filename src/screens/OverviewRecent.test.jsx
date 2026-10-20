// Recent activity on Overview is a glance: a few records and a way into
// Activity, where records are looked into properly (SHR-328).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

const transactions = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, amount: -(i + 1) * 10, kind: 'expense', occurred_at: `2026-10-${String(18 - i).padStart(2, '0')}`, is_shared: true, merchant: `Shop ${i + 1}` }));
vi.mock('./useOverviewData', async (importOriginal) => ({
  ...(await importOriginal()),
  useOverviewData: () => ({
    loading: false,
    accounts: [{ id: 'a1', name: 'Current account', type: 'current', currency: 'AED', balance: 20000, balance_aed: 20000, balance_as_of: '2026-10-20', is_shared: true, owner_member_id: null, archived_at: null }],
    transactions,
    categories: [],
    recurring: [
      { id: 'r1', name: 'Salary A', amount: 10000, cadence: 'monthly', next_due_date: '2026-10-25', is_shared: true, active: true },
      { id: 'r2', name: 'Salary B', amount: 8000, cadence: 'monthly', next_due_date: '2026-10-30', is_shared: true, active: true },
    ],
    netWorthSnapshots: [],
    holdings: [],
    backupRecords: [],
    errors: {},
    loadedAt: new Date(),
    reload: () => {},
  }),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('Overview: recent activity', () => {
  it('shows the five newest records and links to the rest in Activity', async () => {
    const { default: Overview } = await import('./Overview');
    renderScreen(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/money" element={<div>Activity page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const section = [...document.querySelectorAll('.ov-section-head')].find((h) => h.textContent.startsWith('Recent activity')).parentElement;
    expect([...section.querySelectorAll('.ov-list-row')].map((r) => r.querySelector('.ov-list-main div').textContent)).toEqual(['Shop 1', 'Shop 2', 'Shop 3', 'Shop 4', 'Shop 5']);
    fireEvent.click(screen.getByText('All records in Activity →'));
    expect(screen.getByText('Activity page')).toBeTruthy();
  });
});
