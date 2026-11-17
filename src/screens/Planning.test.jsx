import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
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
    goals: [],
    goalContributions: [],
    goalAllocations: [],
    debts: [],
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
