import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

// Planning's frame (the revamp, phase 6): Plan, Goals & debts and Notes, as
// the prototype has them. The Plan summary went, Overview's Plan strip having
// taken its place; the Life plan is Plan now, and the debts sit under the
// goals. Old links land where their content went.
vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));

const MEMBERS = [{ id: 'm1', display_name: 'Partner A' }];
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({ household: { id: 'hh' }, members: MEMBERS, me: MEMBERS[0], loading: false, error: null, reload: () => {} }),
}));

// Three closed months spending 4,000 on 10,000 of income.
function history() {
  const now = new Date();
  return [1, 2, 3].flatMap((back) => {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 10);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`;
    return [
      { id: `i${back}`, amount: 10000, kind: 'income', occurred_at: day, is_shared: true },
      { id: `s${back}`, amount: -4000, kind: 'expense', occurred_at: day, is_shared: true },
    ];
  });
}
vi.mock('./useOverviewData', () => ({
  usePlanningInputs: () => ({
    loading: false,
    accounts: [{ id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null }],
    transactions: history(),
    recurring: [],
    holdings: [],
    budgets: [],
    categories: [],
    errors: {},
    loaded: {},
    loadedAt: new Date(),
    reload: () => {},
  }),
}));
vi.mock('./usePlanningData', () => ({
  usePlanningData: () => ({
    loading: false,
    assumptions: null,
    goals: [{ id: 'g1', name: 'Car', target_amount: 30000, target_date: '2029-06-30', is_shared: true, owner_member_id: null, counts_in_life_plan: true, priority: null, note: '', funding_source: '' }],
    goalContributions: [],
    goalAllocations: [],
    debts: [{ id: 'd1', name: 'Car loan', balance: 20000, apr_pct: 6, minimum_payment: 600, account_id: null, is_shared: true, owner_member_id: null, original_amount: null, note: '' }],
    independenceIncome: [],
    afterWorkCosts: [],
    memberLife: [{ member_id: 'm1', birth_year: 1995, life_expectancy: 85 }],
    notes: [],
    errors: {},
    loaded: {},
    loadedAt: new Date(),
    reload: () => {},
  }),
}));

const { default: Planning } = await import('./Planning');

function open(path) {
  renderScreen(
    <MemoryRouter initialEntries={[path]}>
      <Planning />
    </MemoryRouter>,
  );
}
const tabNames = () => screen.getAllByRole('button').filter((b) => b.classList.contains('om-tab')).map((b) => b.textContent);
const current = () => screen.getAllByRole('button').find((b) => b.classList.contains('om-tab') && b.getAttribute('aria-current') === 'page')?.textContent;

describe('Planning: the frame', () => {
  it('has three tabs, opening on Plan', () => {
    open('/planning');
    expect(tabNames()).toEqual(['Plan', 'Goals & debts', 'Notes']);
    expect(current()).toBe('Plan');
  });

  it('opens Plan from an old link to the Life plan, Forecast or Drawdown', () => {
    for (const old of ['life', 'forecast', 'drawdown']) {
      open(`/planning?tab=${old}`);
      expect(current()).toBe('Plan');
      document.body.innerHTML = '';
    }
  });

  it('opens Goals & debts from an old link to Debt payoff, with the goals and the debts on it', () => {
    open('/planning?tab=debt');
    expect(current()).toBe('Goals & debts');
    expect(screen.getByRole('button', { name: '+ Goal' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Debt' })).toBeTruthy();
  });

  it('no longer has the Plan summary', () => {
    open('/planning');
    expect(screen.queryByText('What needs a decision')).toBeNull();
    expect(screen.queryByText('Monthly check')).toBeNull();
  });
});

// A goal has an address, as an account and a holding do (the revamp, phase
// 6b): its drawer opens over whichever Planning tab is open.
describe('Planning: a goal\'s address', () => {
  it('opens the goal named in the address, on Goals & debts or over Plan', () => {
    open('/planning?tab=goals&goal=g1');
    expect(screen.getByRole('dialog', { name: 'Car' })).toBeTruthy();
    document.body.innerHTML = '';
    open('/planning?goal=g1');
    expect(current()).toBe('Plan');
    expect(screen.getByRole('dialog', { name: 'Car' })).toBeTruthy();
  });

  it('opens on the tab the address names, and adds a goal from ?goal=new', () => {
    open('/planning?tab=goals&goal=g1&view=contributions');
    expect(screen.getByRole('tab', { name: 'Contributions' }).getAttribute('aria-selected')).toBe('true');
    document.body.innerHTML = '';
    open('/planning?tab=goals&goal=new');
    expect(screen.getByRole('dialog', { name: 'Add a goal' })).toBeTruthy();
  });

  it('closes by taking the goal out of the address', () => {
    open('/planning?tab=goals&goal=g1');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens nothing for a goal that isn\'t there', () => {
    open('/planning?tab=goals&goal=nope');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// A debt has an address too (the revamp, phase 6b).
describe('Planning: a debt\'s address', () => {
  it('opens the debt named in the address, and adds one from ?debt=new', () => {
    open('/planning?tab=goals&debt=d1');
    expect(screen.getByRole('dialog', { name: 'Car loan' })).toBeTruthy();
    expect(screen.getByText('Not in net worth until an account is linked.')).toBeTruthy();
    document.body.innerHTML = '';
    open('/planning?tab=goals&debt=new');
    expect(screen.getByRole('dialog', { name: 'Add a debt' })).toBeTruthy();
  });

  it('closes by taking the debt out of the address', () => {
    open('/planning?tab=goals&debt=d1');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
