// Overview, the cockpit (the revamp, phase 3): what each part does when used.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

const ACCOUNTS = [{ id: 'a1', name: 'Current account', type: 'checking', currency: 'AED', balance: 20000, balance_aed: 20000, balance_as_of: '2026-11-14', is_shared: true, owner_member_id: null, archived_at: null }];
const CATEGORIES = [
  { id: 'g', name: 'Groceries', kind: 'expense', parent_id: null },
  { id: 'd', name: 'Dining out', kind: 'expense', parent_id: null },
];
const TX = [
  { id: 't1', amount: -400, kind: 'expense', category_id: 'g', account_id: 'a1', occurred_at: '2026-11-10', is_shared: true, merchant: 'Supermarket' },
  { id: 't2', amount: -100, kind: 'expense', category_id: 'd', account_id: 'a1', occurred_at: '2026-11-11', is_shared: true, merchant: 'Cafe' },
];
// A bill due on the 5th that has not posted: To do offers Mark paid.
const BILL = { id: 'r1', name: 'Gym', amount: -250, cadence: 'monthly', interval_count: 1, next_due_date: '2026-11-05', active: true, autopay: false, is_shared: true, account_id: 'a1', category_id: 'd' };

vi.mock('./useOverviewData', async (importOriginal) => ({
  ...(await importOriginal()),
  useOverviewData: () => ({
    loading: false,
    accounts: ACCOUNTS,
    transactions: TX,
    categories: CATEGORIES,
    recurring: [BILL],
    budgets: [],
    netWorthSnapshots: [{ id: 's1', snapshot_date: '2026-10-01', assets: 20000, liabilities: 0 }],
    holdings: [],
    backupRecords: [{ id: 'b1', kind: 'export', result: 'passed', done_on: '2026-11-14', created_at: '2026-11-14T10:00:00Z' }],
    errors: {},
    loaded: {},
    loadedAt: new Date(),
    reload: async () => {},
  }),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 15, 12));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

async function open() {
  const { default: Overview } = await import('./Overview');
  return renderScreen(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Overview cockpit', () => {
  it('opens a new transaction in place from the header', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '+ Transaction' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it("opens Mark paid filled from the bill, as Recurring's does", async () => {
    await open();
    const todo = screen.getByRole('region', { name: 'To do' });
    expect(within(todo).getByText('Gym')).toBeTruthy();
    fireEvent.click(within(todo).getByRole('button', { name: 'Mark paid' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByDisplayValue('Gym')).toBeTruthy();
    expect(within(dialog).getByDisplayValue('250')).toBeTruthy();
  });

  it('opens the data checks in place from the chip beside the date', async () => {
    await open();
    const chip = screen.getByRole('button', { name: /^Data: / });
    expect(screen.queryByRole('region', { name: 'Data quality' })).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Data quality' })).toBeTruthy();
  });

  it("opens a category's transactions for the month from Where it went", async () => {
    await open();
    const where = screen.getByRole('region', { name: 'Where it went' });
    fireEvent.click(within(where).getByRole('button', { name: /Groceries/ }));
    const at = screen.getByTestId('where').textContent;
    expect(at).toMatch(/^\/money\?/);
    expect(at).toContain('cat=g');
    expect(at).toContain('from=2026-11-01');
  });

  it('opens each plan tile on its page', async () => {
    await open();
    const plan = screen.getByRole('region', { name: 'Plan' });
    const hrefs = within(plan)
      .getAllByRole('link')
      .map((l) => l.getAttribute('href'));
    expect(hrefs).toEqual(['/planning?tab=life', '/planning?tab=goals', '/planning?tab=debt', '/planning?tab=plan']);
  });

  it('counts To do in the title', async () => {
    await open();
    const n = screen.getByRole('region', { name: 'To do' }).querySelectorAll('.ov-todo-row').length;
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a decision`);
  });
});
