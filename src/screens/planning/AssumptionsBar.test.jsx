import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

// The assumptions every planning view runs on, in the same place and words on
// Forecast, Life plan and Drawdown, with the scenario and the money shown
// held across the three tabs (SHR-325).
vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const MEMBERS = [{ id: 'm1', display_name: 'Partner A' }];
vi.mock('../../lib/useHousehold', () => ({
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
vi.mock('../useOverviewData', () => ({
  usePlanningInputs: () => ({
    loading: false,
    accounts: [{ id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null }],
    transactions: history(),
    recurring: [],
    holdings: [],
    budgets: [],
    categories: [],
    errors: {},
    loadedAt: new Date(),
    reload: () => {},
  }),
}));
vi.mock('../usePlanningData', () => ({
  usePlanningData: () => ({
    loading: false,
    assumptions: null,
    goals: [],
    goalContributions: [],
    goalAllocations: [],
    debts: [],
    independenceIncome: [],
    memberLife: [{ member_id: 'm1', birth_year: 1995, life_expectancy: 85 }],
    notes: [],
    errors: {},
    loadedAt: new Date(),
    reload: () => {},
  }),
}));

const { default: Planning } = await import('../Planning');

afterEach(() => localStorage.clear());

function open(tab) {
  renderScreen(
    <MemoryRouter initialEntries={[`/planning?tab=${tab}`]}>
      <Planning />
    </MemoryRouter>,
  );
}
const bar = () => document.querySelector('.pl-assumptions');
const label = (row) => [...bar().querySelectorAll('.dd-control')].find((c) => c.querySelector('.dd-label').textContent === row);
const tab = (name) => screen.getAllByRole('button', { name }).find((b) => b.classList.contains('om-tab'));

describe('The assumptions bar', () => {
  it('is on Forecast, Life plan and Drawdown, in the same order', () => {
    open('forecast');
    for (const name of ['Forecast', 'Life plan', 'Drawdown']) {
      fireEvent.click(tab(name));
      expect([...bar().querySelectorAll('.dd-label')].map((l) => l.textContent)).toEqual(['Scenario', 'Show', 'Growth', 'Spending']);
    }
  });

  it('says the saved assumptions are shared, and a scenario is only a look for now', () => {
    open('forecast');
    expect(bar().textContent).toMatch(/Your saved assumptions\. Return, inflation and the withdrawal rate are shared by Forecast, Life plan and Drawdown/);
    expect(label('Growth').textContent).toMatch(/6\.0% return · 2\.5% inflation · 3\.4% after inflation · 4\.0% withdrawal rate/);
    fireEvent.click(label('Scenario').querySelector('button:nth-child(2)'));
    expect(bar().textContent).toMatch(/The Conservative scenario \(derived from baseline · not edited\), shown on every planning tab until you switch back\. It isn't saved\./);
  });

  it('keeps the scenario and the money shown when moving between the tabs', () => {
    open('forecast');
    fireEvent.click(screen.getByRole('button', { name: 'Optimistic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Future money' }));
    fireEvent.click(tab('Life plan'));
    expect(screen.getByRole('button', { name: 'Optimistic' }).dataset.active).toBe('true');
    expect(screen.getByRole('button', { name: 'Future money' }).dataset.active).toBe('true');
    expect(label('Growth').textContent).toMatch(/^Growth8\.0% return · 1\.5% inflation/);
    fireEvent.click(tab('Drawdown'));
    expect(screen.getByRole('button', { name: 'Optimistic' }).dataset.active).toBe('true');
    // Drawdown is in today's money only, and says so in the same place.
    expect(label('Show').textContent).toBe('ShowToday’s money');
  });

  it('puts each view\'s spending in the same place', () => {
    open('life');
    expect(label('Spending').textContent).toMatch(/Today's · 48K a year/);
    fireEvent.click(tab('Drawdown'));
    expect(label('Spending').textContent).toMatch(/Today's · 48K a year/);
    fireEvent.click(tab('Forecast'));
    expect(label('Spending').textContent).toMatch(/Today's: AED 48,000 a year/);
  });
});
