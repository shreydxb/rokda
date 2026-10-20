// Overview's Income is what has been recorded so far this period. Pay lands
// late in the month, so before payday it read 0 with nothing to say why.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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

let transactions = [];
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

async function incomeKpi() {
  const { default: Overview } = await import('./Overview');
  const { container } = renderScreen(
    <MemoryRouter>
      <Overview />
    </MemoryRouter>,
  );
  return [...container.querySelectorAll('.ov-kpi-row > div')].find((k) => k.querySelector('.ov-kpi-label').textContent === 'Income');
}

describe('Overview: pay still to come this period', () => {
  it('says when pay is expected while none has been recorded', async () => {
    transactions = [{ id: 't1', amount: -500, kind: 'expense', occurred_at: '2026-10-10', is_shared: true, merchant: 'Groceries' }];
    const kpi = await incomeKpi();
    expect(kpi.querySelector('.ov-kpi-fig').textContent).toBe('0');
    expect(kpi.querySelector('.ov-kpi-hint').textContent).toBe('Pay expected 25 and 30 Oct · 18,000');
  });

  it('says "more pay" once one salary is in, and nothing once both are', async () => {
    transactions = [{ id: 't1', amount: 10000, kind: 'income', occurred_at: '2026-10-19', is_shared: true, merchant: 'Salary A' }];
    let kpi = await incomeKpi();
    expect(kpi.querySelector('.ov-kpi-hint').textContent).toBe('More pay expected 30 Oct · 8,000');

    transactions = [...transactions, { id: 't2', amount: 8000, kind: 'income', occurred_at: '2026-10-20', is_shared: true, merchant: 'Salary B' }];
    kpi = await incomeKpi();
    expect(kpi.querySelector('.ov-kpi-hint')).toBeNull();
  });
});
