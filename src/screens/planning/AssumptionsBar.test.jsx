import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

// Planning's tabs, and the assumptions bar the Life plan runs on, with the
// scenario and the money shown held while moving between tabs (SHR-325).
// Forecast and Drawdown went (Planning audit, 3.15).
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

describe('Planning tabs and the assumptions bar', () => {
  const tabNames = () => screen.getAllByRole('button').filter((b) => b.classList.contains('om-tab')).map((b) => b.textContent);

  it('has five tabs, and an old link to Forecast or Drawdown opens the Life plan', () => {
    for (const old of ['forecast', 'drawdown']) {
      const { unmount } = renderScreen(
        <MemoryRouter initialEntries={[`/planning?tab=${old}`]}>
          <Planning />
        </MemoryRouter>,
      );
      expect(tabNames()).toEqual(['Plan', 'Life plan', 'Goals', 'Debt payoff', 'Notes']);
      expect(tab('Life plan').getAttribute('aria-current')).toBe('page');
      expect([...bar().querySelectorAll('.dd-label')].map((l) => l.textContent)).toEqual(['Scenario', 'Show', 'Growth', 'Spending']);
      unmount();
    }
  });

  it('says the assumptions are defaults until saved, and a scenario is only a look for now', () => {
    open('life');
    // Nothing saved: the app's figures, and it says so (Planning audit, 1.3).
    expect(bar().textContent).toMatch(/Defaults, nothing saved: the app's figures until you save your own under Edit assumptions\. Return and inflation are edited with the rest of the plan, under Edit assumptions\./);
    expect(label('Growth').textContent).toMatch(/6\.0% return · 2\.5% inflation · 3\.4% after inflation · 5\.0% return after work stops/);
    fireEvent.click(label('Scenario').querySelector('button:nth-child(2)'));
    expect(bar().textContent).toMatch(/The Conservative scenario \(derived from baseline · not edited\), shown until you switch back\. It isn't saved\./);
  });

  it('keeps the scenario and the money shown when moving between the tabs', () => {
    open('life');
    fireEvent.click(screen.getByRole('button', { name: 'Optimistic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Future money' }));
    fireEvent.click(tab('Plan'));
    fireEvent.click(tab('Life plan'));
    expect(screen.getByRole('button', { name: 'Optimistic' }).dataset.active).toBe('true');
    expect(screen.getByRole('button', { name: 'Future money' }).dataset.active).toBe('true');
    expect(label('Growth').textContent).toMatch(/^Growth8\.0% return · 1\.5% inflation/);
  });

  // The chosen option showed only as a fill (Planning audit, 0b-F).
  it('tells a screen reader which tab, scenario and money are chosen', () => {
    open('life');
    expect(tab('Life plan').getAttribute('aria-current')).toBe('page');
    expect(tab('Plan').hasAttribute('aria-current')).toBe(false);
    const scenario = screen.getByRole('group', { name: 'Scenario' });
    fireEvent.click(within(scenario).getByRole('button', { name: 'Optimistic' }));
    expect(within(scenario).getByRole('button', { name: 'Optimistic', pressed: true })).toBeTruthy();
    expect(within(scenario).getByRole('button', { name: 'Baseline', pressed: false })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'Today’s money', pressed: true })).toBeTruthy();
  });

  // Plan's cards were divs that ignored Space and left focus nowhere once
  // the tab changed (Planning audit, 0b-F).
  it('opens a tab from one of Plan\'s cards and takes focus to it', () => {
    open('plan');
    const card = screen.getAllByRole('button').find((b) => b.classList.contains('pl-card') && /open Goals$/.test(b.getAttribute('aria-label')));
    expect(card.tagName).toBe('BUTTON');
    fireEvent.click(card);
    expect(tab('Goals').getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(tab('Goals'));
  });

  it('gives the spending the plan is built on in its place', () => {
    open('life');
    expect(label('Spending').textContent).toMatch(/Today's · 48K a year/);
  });
});
