import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/dom';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import Goals from './Goals';
import PlanSummary from './PlanSummary';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
const GOAL = { id: 'g1', name: 'Emergency fund', target_amount: 100000, target_date: '2027-12-31', is_shared: true, owner_member_id: null, note: '', funding_source: '' };
const ACCOUNTS = [{ id: 'a1', type: 'savings', currency: 'AED', balance: 50000, balance_aed: 50000, archived_at: null }];
const DATA = {
  goals: [GOAL],
  goalContributions: [{ id: 'c1', goal_id: 'g1', amount: 5000, occurred_at: '2026-09-01' }],
  goalAllocations: [{ id: 'l1', goal_id: 'g1', account_id: 'a1', holding_id: null, share_pct: 50 }],
  debts: [],
  assumptions: null,
  reload: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 24, 12));
});
afterEach(() => vi.useRealTimers());

describe('Plan summary agrees with the Goals tab', () => {
  it('counts linked accounts in saved, as the Goals tab does', () => {
    renderScreen(
      <MemoryRouter>
        <PlanSummary members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} transactions={[]} holdings={[]} data={DATA} loading={false} onOpenTab={() => {}} />
      </MemoryRouter>,
    );
    // Half of a 50,000 account. It used to read only what was logged; the
    // 5,000 logged is now its record, not added on top (Planning audit, 2.8).
    expect(screen.getByText('25,000')).toBeTruthy();
  });
});

describe('Plan summary uses the same independence target as Forecast and Drawdown', () => {
  it('takes lasting other income off the target', () => {
    const now = new Date();
    const txns = [1, 2, 3].map((back, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 10);
      return { id: `s${i}`, amount: -4000, kind: 'expense', occurred_at: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`, is_shared: true };
    });
    const rent = { id: 'r1', kind: 'yearly', amount: 24000, starts_after_years: 0, lasts_years: null };
    renderScreen(
      <MemoryRouter>
        <PlanSummary
          members={MEMBERS}
          me={{ id: 'm1' }}
          accounts={ACCOUNTS}
          transactions={txns}
          holdings={[]}
          data={{ ...DATA, independenceIncome: [rent] }}
          loading={false}
          onOpenTab={() => {}}
        />
      </MemoryRouter>,
    );
    // 48,000 − 24,000 = 24,000 a year at 4%: 600,000.
    expect(screen.getByText(/of the way to 600,000/)).toBeTruthy();
  });
});

describe('Goals: goals that never loaded', () => {
  it('says so, rather than offering to add the first goal', () => {
    renderScreen(
      <Goals household={{ id: 'h' }} members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} holdings={[]} data={{ ...DATA, goals: [] }} sources={{ errors: { goals: { message: 'canceling statement due to statement timeout' } }, loaded: {} }} loading={false} />,
    );
    expect(screen.getByText('Couldn’t load goals.')).toBeTruthy();
    expect(screen.queryByText(/Add a goal to start/)).toBeNull();
  });

  it('waits for the assumptions too, rather than costing goals at the defaults', () => {
    renderScreen(
      <Goals household={{ id: 'h' }} members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} holdings={[]} data={DATA} sources={{ errors: { assumptions: { message: 'canceling statement due to statement timeout' } }, loaded: {} }} loading={false} />,
    );
    expect(screen.getByText('Couldn’t load planning assumptions.')).toBeTruthy();
  });
});

// Planning audit, 1.5: one status per goal from the rule for its kind, and one
// monthly figure, in plain cash.
const VILLA = { id: 'g2', name: 'Villa', target_amount: 1000000, target_date: '2044-09-01', is_shared: true, owner_member_id: null, note: '', funding_source: '', cost_today: true, inflation_pct: 8, priority: 1 };
const CAR = { id: 'g3', name: 'Car', target_amount: 10000, target_date: '2040-01-01', is_shared: true, owner_member_id: null, note: '', funding_source: '' };
const HOUSE = { id: 'g4', name: 'House', target_amount: 900000, target_date: null, is_shared: true, owner_member_id: null, note: '', funding_source: '' };
// Three ended months spending 4,000 on 10,000 of income, and ages, so the
// Life plan has a timeline.
function history() {
  return [1, 2, 3].flatMap((back) => {
    const d = new Date(2026, 8 - back, 10);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`;
    return [
      { id: `i${back}`, amount: 10000, kind: 'income', occurred_at: day, is_shared: true },
      { id: `s${back}`, amount: -4000, kind: 'expense', occurred_at: day, is_shared: true },
    ];
  });
}
const LIFE = { memberLife: [{ member_id: 'm1', birth_year: 1994, life_expectancy: 85 }], independenceIncome: [] };
function renderGoals(data, props = {}) {
  renderScreen(<Goals household={{ id: 'h' }} members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} holdings={[]} data={{ ...DATA, ...data }} loading={false} {...props} />);
}
const row = (name) => [...document.querySelectorAll('.mn-row')].find((r) => r.textContent.startsWith(name));

describe('Goals: due within 3 years, from cash', () => {
  it('counts only cash set aside, and gives the plain cash a month to its date', () => {
    renderGoals({});
    // Half of a 50,000 savings account, the 5,000 logged not added on top:
    // 75,000 over the 15 months to Dec 2027.
    expect(within(row('Emergency fund')).getByText('Due within 3 years, so paid from cash: 5,000 a month to Dec 2027.')).toBeTruthy();
    expect(within(row('Emergency fund')).getByText('Saving')).toBeTruthy();
    const summary = within(screen.getByRole('region', { name: 'Next 3 years' }));
    expect(summary.getByText(/set aside in cash/).textContent).toBe('25,000 of 100,000 set aside in cash');
    expect(summary.getByText(/a month in cash/).textContent).toBe('Needs 5,000 a month in cash until Dec 2027');
  });

  it('leaves a linked holding out: a goal due soon can\'t wait for a market', () => {
    const allocations = [{ id: 'l2', goal_id: 'g1', account_id: null, holding_id: 'h1', share_pct: 100 }];
    renderGoals({ goalAllocations: allocations }, { holdings: [{ id: 'h1', value_aed: 500000 }] });
    // Linked, so the 5,000 logged isn't counted either: 100,000 over 15 months.
    expect(within(row('Emergency fund')).getByText(/^Due within 3 years, so paid from cash: 6,667 a month to Dec 2027\.$/)).toBeTruthy();
  });

  it('holds kept money in cash, in its own section', () => {
    renderGoals({ goals: [{ ...GOAL, counts_in_life_plan: false }] });
    expect(screen.getByRole('region', { name: 'Kept, not spent' })).toBeTruthy();
    expect(within(row('Emergency fund')).getByText(/^Kept, not spent, so held in cash: /)).toBeTruthy();
  });
});

// Planning audit, 2.7: a planned monthly amount, and done.
describe('Goals: what you plan a month', () => {
  it('settles a goal whose plan covers it by its date, and says when a short plan gets there', () => {
    renderGoals({ goals: [{ ...GOAL, planned_monthly: 5000 }] });
    expect(within(row('Emergency fund')).getByText('Planned')).toBeTruthy();
    expect(within(row('Emergency fund')).getByText('Due within 3 years, so paid from cash: 5,000 a month to Dec 2027. You plan 5,000, which covers it.')).toBeTruthy();
    const summary = within(screen.getByRole('region', { name: 'Next 3 years' }));
    expect(summary.getByText(/a month in cash/).textContent).toBe('Needs 5,000 a month in cash until Dec 2027 · you plan 5,000');
  });

  it('marks a plan that falls short, with the month it would cover the goal by', () => {
    renderGoals({ goals: [{ ...GOAL, planned_monthly: 3000 }] });
    expect(within(row('Emergency fund')).getByText('Plan short')).toBeTruthy();
    // 75,000 at 3,000 a month: 25 months from Sep 2026.
    expect(within(row('Emergency fund')).getByText('Due within 3 years, so paid from cash: 5,000 a month to Dec 2027. At the 3,000 you plan, it is covered by Oct 2028.')).toBeTruthy();
  });
});

// Planning audit, 2.8: what has gone in lately, from the goal's one source.
describe('Goals: pace', () => {
  // The account linked at half: 30,000 when it was opened in June, 50,000 now.
  const opened = [{ id: 1, account_id: 'a1', old_balance: null, new_balance: 30000, recorded_at: '2026-06-01T08:00:00Z' }];

  it('reads a linked goal\'s pace from its account\'s recorded balance, beside its plan', () => {
    renderGoals({ goals: [{ ...GOAL, planned_monthly: 5000 }], balanceEvents: opened });
    // Half of 20,000 over the last 91 days.
    expect(within(row('Emergency fund')).getByText('Going in from its linked accounts: about 3,345 a month over the last 3 months, below the 5,000 you plan.')).toBeTruthy();
  });

  it('waits for a month of recorded changes, and gives none when they could not be read', () => {
    renderGoals({ balanceEvents: [] });
    expect(within(row('Emergency fund')).getByText('Its pace shows once its linked accounts have a month of recorded balance changes.')).toBeTruthy();
    document.body.innerHTML = '';
    renderGoals({ balanceEvents: [] }, { sources: { errors: { balanceEvents: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(row('Emergency fund').textContent).not.toMatch(/pace|Going in/);
  });

  it('reads a goal with nothing linked from what was logged to it', () => {
    renderGoals({ goalAllocations: [] });
    // 5,000 logged on 1 Sep, over the last 91 days.
    expect(within(row('Emergency fund')).getByText('Logged to it: about 1,672 a month over the last 3 months.')).toBeTruthy();
  });
});

describe('Goals: done goals', () => {
  it('lists a done goal apart, out of every plan, and opens it to reopen', () => {
    renderGoals({ goals: [GOAL, { ...HOUSE, done_at: '2026-09-01T08:00:00Z' }] });
    expect(document.querySelector('.mn-filters').textContent).toMatch(/^1 dated goal · 1 done/);
    expect(screen.queryByRole('region', { name: 'No date' })).toBeNull();
    const done = within(screen.getByRole('region', { name: 'Done' }));
    expect(done.getByText('House')).toBeTruthy();
    expect(done.getByText('Done Sep 2026')).toBeTruthy();
  });

  it('says every goal is done rather than that there are none', () => {
    renderGoals({ goals: [{ ...GOAL, done_at: '2026-09-01T08:00:00Z' }] });
    expect(screen.queryByText('No goals')).toBeNull();
    expect(screen.getByText('Every goal is done.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Next 3 years' })).toBeNull();
  });
});

describe('Goals: later goals, from the Life plan', () => {
  it('takes each one\'s state from the Life plan\'s timeline', () => {
    renderGoals({ ...LIFE, goals: [CAR, VILLA] }, { transactions: history() });
    expect(within(row('Car')).getByText('Paid in 2040')).toBeTruthy();
    expect(within(row('Car')).getByText('The Life plan pays it from your savings and investments in 2040.')).toBeTruthy();
    // About 4M by 2044, which the plan can't find.
    expect(within(row('Villa')).getByText('Short in 2044')).toBeTruthy();
    expect(within(row('Villa')).getByText(/^The Life plan runs short by [\d,]+ in 2044, the year it is due\.$/)).toBeTruthy();
  });

  it('says it is not checked without a Life plan to check it', () => {
    renderGoals({ goals: [CAR] });
    expect(within(row('Car')).getByText('Not checked')).toBeTruthy();
  });

  it('keeps the priority table for later goals only, closed, with what is left over', () => {
    renderGoals({ ...LIFE, goals: [GOAL, VILLA, CAR] }, { transactions: history() });
    const table = document.querySelector('details.gl-priority');
    expect(table.open).toBe(false);
    expect(within(table).getByText('If your investments paid for these')).toBeTruthy();
    const rows = [...table.querySelectorAll('tbody tr')].map((r) => r.textContent);
    expect(rows.map((r) => r.replace(/·.*/, '').trim())).toEqual(['1Villa', '—Car']);
  });
});

describe('Goals: undated goals', () => {
  it('are split out, and say no plan pays them', () => {
    renderGoals({ goals: [GOAL, HOUSE] });
    expect(document.querySelector('.mn-filters').textContent).toMatch(/^1 dated goal · 1 with no date/);
    expect(within(screen.getByRole('region', { name: 'No date' })).getByText('Not in any plan: set a date to plan for it.')).toBeTruthy();
    expect(within(row('House')).getByText('No date')).toBeTruthy();
  });
});

describe('Goals: today\'s costs', () => {
  it('shows what a today\'s cost comes to on its date', () => {
    renderGoals({ goals: [GOAL, VILLA] });
    // 1,000,000 at 8% for the 18 years to Sep 2044.
    expect(screen.getByText(/1,000,000 today, rising 8% a year · about 3,996,019 by 2044/)).toBeTruthy();
  });
});
