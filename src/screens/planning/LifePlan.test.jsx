import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import LifePlan from './LifePlan';

// Every write the screen makes, by table.
const calls = vi.hoisted(() => ({ upserts: [], updates: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: async (row) => {
        calls.upserts.push({ table, row });
        return { error: null };
      },
      update: (patch) => ({
        eq: async (column, value) => {
          calls.updates.push({ table, patch, column, value });
          return { error: null };
        },
      }),
    }),
  },
}));

const ACCOUNT = { id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null };
const MEMBERS = [
  { id: 'm1', display_name: 'Shreyash' },
  { id: 'm2', display_name: 'Tarika' },
];
const AGES = [
  { member_id: 'm1', birth_year: 1994, life_expectancy: 80 },
  { member_id: 'm2', birth_year: 1994, life_expectancy: 85 },
];

// Three closed months spending 4,000 on 10,000 of income: 48,000 a year spent, 72,000 saved.
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

function renderPlan({ data = {}, ...props } = {}) {
  const reload = vi.fn();
  renderScreen(
    <LifePlan
      household={{ id: 'h', inr_per_aed: 25 }}
      members={MEMBERS}
      accounts={[ACCOUNT]}
      transactions={history()}
      holdings={[]}
      data={{ assumptions: null, goals: [], independenceIncome: [], memberLife: AGES, reload, ...data }}
      loading={false}
      {...props}
    />,
  );
  return { reload };
}

const hero = () => document.querySelector('.ov-hero').textContent;
const thisYear = new Date().getFullYear();

beforeEach(() => {
  calls.upserts.length = 0;
  calls.updates.length = 0;
});
afterEach(() => localStorage.clear());

describe('LifePlan: setting up', () => {
  it('asks who the plan is for before anything else', () => {
    renderPlan({ data: { memberLife: [] } });
    expect(screen.getByText('Set up your life plan')).toBeTruthy();
    fireEvent.click(screen.getByText('Set up the plan'));
    expect(screen.getByRole('dialog', { name: 'Life plan' })).toBeTruthy();
  });

  it('says what it needs when there is nothing to project from', () => {
    renderPlan({ transactions: [] });
    expect(screen.getByText('Not enough to project')).toBeTruthy();
  });
});

describe('LifePlan: the timeline', () => {
  it('plans to the last life expectancy, stopping work at 60 until a year is saved', () => {
    renderPlan();
    // 200,000 plus 72,000 a year at 3.4% real, spending 48,000 a year from 60: it lasts.
    expect(hero()).toBe('Lasts to 2079');
    expect(screen.getByText(/Stopping work in 2054 \(Shreyash 60 · Tarika 60\)/)).toBeTruthy();
    expect(screen.getByText(/the year Tarika turns 85/)).toBeTruthy();
    expect(screen.getByText(/not saved yet/)).toBeTruthy();
  });

  it('runs out when work stops too soon for the spending', () => {
    renderPlan({ data: { assumptions: { retirement_year: thisYear + 1, retirement_annual_spend: 150000 } } });
    expect(hero()).toMatch(/^Runs out in \d{4}$/);
    const take = document.querySelector('.fc-solve-answer').textContent;
    // Stopping later comes first: it is the lever that fits a plan short in retirement.
    expect(take).toMatch(/^To last to 2079: stop work in \d{4} \(Shreyash \d+ · Tarika \d+\) · or save AED [\d,]+ more a month until \d{4} · or spend at most AED [\d,]+ a year/);
  });

  it('falls short in a goal\'s year when the pot cannot pay it', () => {
    const goals = [{ id: 'g1', name: 'Villa', target_amount: '5000000', target_date: `${thisYear + 1}-06-01`, counts_in_life_plan: true }];
    renderPlan({ data: { goals } });
    expect(hero()).toBe(`Short in ${thisYear + 1}`);
    expect(screen.getByText(new RegExp(`^Villa in ${thisYear + 1} needs AED`))).toBeTruthy();
    expect(document.querySelector('.fc-solve-answer').textContent).toMatch(new RegExp(`^The pot is AED [\\d,]+ short for Villa in ${thisYear + 1}\\. Move it later or make it smaller`));
  });

  it('leaves a goal kept rather than spent off the timeline', () => {
    const goals = [{ id: 'g1', name: 'Emergency fund', target_amount: '5000000', target_date: `${thisYear + 1}-06-01`, counts_in_life_plan: false }];
    renderPlan({ data: { goals } });
    expect(hero()).toBe('Lasts to 2079');
    expect(screen.getByText('Kept, not spent: stays in the pot')).toBeTruthy();
  });

  it('shows the same figures grown with inflation as future money', () => {
    renderPlan();
    const atStop = () => document.querySelectorAll('.fc-kpi .fig')[0].textContent;
    const today = Number(atStop().replace(/[^0-9]/g, ''));
    fireEvent.click(screen.getByText('Future money'));
    const future = Number(atStop().replace(/[^0-9]/g, ''));
    // 28 years at 2.5% inflation.
    expect(future / today).toBeCloseTo(1.025 ** (2054 - thisYear), 3);
  });
});

describe('LifePlan: sums paid in a set year', () => {
  it('adds a policy maturity to the pot in its year, and says so', () => {
    const maturity = { id: 'l', name: 'LIC A maturity', kind: 'lump_sum', amount: 4350000, currency: 'INR', in_year: thisYear + 10, starts_after_years: 0 };
    renderPlan({ data: { independenceIncome: [maturity] } });
    expect(screen.getByText(new RegExp(`LIC A maturity \\(${thisYear + 10}\\) is added in its year, converted at today's rate`))).toBeTruthy();
    const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.startsWith(String(thisYear + 10)));
    // 174,000 AED paid then, in today's money at 2.5% inflation.
    expect(row.textContent).toContain((174000 / 1.025 ** 10).toLocaleString('en-US', { maximumFractionDigits: 0 }).slice(0, 5));
  });
});

describe('LifePlan: changing the plan', () => {
  it('saves a stop year tried on the screen as the plan', async () => {
    const { reload } = renderPlan();
    fireEvent.click(screen.getByLabelText('A year earlier'));
    expect(document.querySelector('.fc-solve-year .fig').textContent).toBe('2053');
    fireEvent.click(screen.getByText('Make this the plan'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.upserts).toEqual([
      { table: 'planning_assumptions', row: expect.objectContaining({ household_id: 'h', retirement_year: 2053 }) },
    ]);
  });

  it('marks a goal as kept rather than spent', async () => {
    const goals = [{ id: 'g1', name: 'Emergency fund', target_amount: '120000', target_date: `${thisYear + 1}-06-01`, counts_in_life_plan: true }];
    const { reload } = renderPlan({ data: { goals } });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.updates).toEqual([{ table: 'goals', patch: { counts_in_life_plan: false }, column: 'id', value: 'g1' }]);
  });
});
