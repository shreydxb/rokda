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

// Counts the solver's runs, to show a step along the chart reruns none of them.
const solverRuns = vi.hoisted(() => ({ earliest: 0 }));
vi.mock('../../lib/lifePlan', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    earliestStop: (args) => {
      solverRuns.earliest += 1;
      return actual.earliestStop(args);
    },
  };
});

const ACCOUNT = { id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null };
const MEMBERS = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
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
// The year-by-year table is built once it is opened.
function openTable() {
  const details = document.querySelector('details.ch-table');
  details.open = true;
  fireEvent(details, new Event('toggle'));
}
const thisYear = new Date().getFullYear();

beforeEach(() => {
  calls.upserts.length = 0;
  calls.updates.length = 0;
});
afterEach(() => localStorage.clear());

describe('LifePlan: ages that never loaded', () => {
  it('says so, rather than asking who the plan is for as if none were set', () => {
    renderPlan({ data: { memberLife: [] }, sources: { errors: { memberLife: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.getByText('Couldn’t load ages for the life plan.')).toBeTruthy();
    expect(screen.queryByText(/Set up your life plan/)).toBeNull();
    expect(document.querySelector('.ov-hero')).toBeNull();
  });

  it('works the plan out without a budget once three months have closed', () => {
    renderPlan({ sources: { errors: { budgets: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.queryByText(/Couldn’t load/)).toBeNull();
    expect(document.querySelector('.ov-hero')).not.toBeNull();
  });
});

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
    expect(screen.getByText(/Stopping work in 2054 \(Alex 60 · Sam 60\)/)).toBeTruthy();
    expect(screen.getByText(/the year Sam turns 85/)).toBeTruthy();
    expect(screen.getByText(/not saved yet/)).toBeTruthy();
  });

  it('runs out when work stops too soon for the spending', () => {
    renderPlan({ data: { assumptions: { retirement_year: thisYear + 1, retirement_annual_spend: 150000 } } });
    expect(hero()).toMatch(/^Runs out in \d{4}$/);
    const take = document.querySelector('.fc-solve-answer').textContent;
    // Stopping later comes first: it is the lever that fits a plan short in retirement.
    expect(take).toMatch(/^To last to 2079: stop work in \d{4} \(Alex \d+ · Sam \d+\) · or save AED [\d,]+ more a month until \d{4} · or spend at most AED [\d,]+ a year/);
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

describe('LifePlan: spending that stops', () => {
  it('leaves out spending marked as stopping, and names it', () => {
    const categories = [
      { id: 'rent', name: 'Rent', kind: 'expense', stops_after_work: true },
      { id: 'food', name: 'Groceries', kind: 'expense' },
    ];
    const tx = history().map((t) => (t.kind === 'expense' ? { ...t, amount: -1000, category_id: 'food' } : t));
    const rent = [1, 2, 3].map((back) => {
      const d = new Date(new Date().getFullYear(), new Date().getMonth() - back, 5);
      return { id: `rent${back}`, amount: -3000, kind: 'expense', category_id: 'rent', is_shared: true, occurred_at: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-05` };
    });
    renderPlan({ transactions: [...tx, ...rent], categories });
    // The spending choice, beside the scenario and the money shown.
    const active = [...document.querySelectorAll('.om-seg[data-active="true"]')].map((b) => b.textContent).find((t) => t.endsWith('a year'));
    // 48,000 a year spent, 36,000 of it rent: 12,000 left once work stops.
    expect(active).toBe('Less what stops · 12K a year');
    expect(document.querySelector('.lp-stops').textContent).toMatch(/^Leaves out Rent 36K a year, expected to have stopped by then\./);
  });
});

// A loan larger than the accounts was booked as a shortfall this year and then
// forgiven (Planning audit, 0b-D).
// With everyone past their plan-to age the page threw and took the whole app
// with it (Planning audit, 0b-D).
// Built while closed, the table's rows were most of the work on every chart
// step (Planning audit, 0b-E).
describe('LifePlan: the year-by-year table', () => {
  it('leaves the plan alone on a step along the chart', () => {
    renderPlan();
    const before = solverRuns.earliest;
    expect(before).toBeGreaterThan(0);
    const readout = () => document.querySelector('.ov-chart-readout .fig').textContent;
    const year = readout();
    const chart = screen.getByRole('group', { name: /^The pot at the start of each year/ });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(readout()).toBe(String(Number(year) + 2));
    expect(solverRuns.earliest).toBe(before);
  });

  it('is built only once it is opened', () => {
    renderPlan();
    expect(document.querySelectorAll('.ch-table tbody tr')).toHaveLength(0);
    openTable();
    expect(document.querySelectorAll('.ch-table tbody tr').length).toBeGreaterThan(50);
  });
});

describe('LifePlan: other income with no rate', () => {
  it('names a rupee income it leaves out for want of a rate', () => {
    const pension = { id: 'p1', name: 'Pension in India', kind: 'yearly', amount: 600000, currency: 'INR', starts_after_years: 0, lasts_years: null };
    renderPlan({ household: { id: 'h', inr_per_aed: null }, data: { independenceIncome: [pension] } });
    expect(document.body.textContent).toMatch(/Pension in India is not counted: no AED\/INR rate is set yet \(Settings → Household\)\./);
  });
});

describe('LifePlan: a plan everyone has outlived', () => {
  it('says so and asks for a later age, rather than crashing', () => {
    const past = [
      { member_id: 'm1', birth_year: 1940, life_expectancy: 84 },
      { member_id: 'm2', birth_year: 1940, life_expectancy: 84 },
    ];
    renderPlan({ data: { memberLife: past } });
    expect(screen.getByText('The plan has run its course')).toBeTruthy();
    expect(screen.getByText(/It plans for Alex to 84 and Sam to 84, and everyone is past that age now/)).toBeTruthy();
    fireEvent.click(screen.getByText('Plan to a later age'));
    expect(screen.getByRole('dialog', { name: 'Life plan' })).toBeTruthy();
  });
});

describe('LifePlan: a loan larger than the accounts', () => {
  it('is repaid from saving, and shown as owed rather than held', () => {
    const loan = { id: 'l1', type: 'loan', currency: 'AED', balance: 300000, balance_aed: 300000, is_shared: true, archived_at: null };
    renderPlan({ accounts: [ACCOUNT, loan] });
    expect(hero()).not.toMatch(/^Short in/);
    openTable();
    const firstRow = [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.startsWith(String(thisYear)));
    // 200,000 held less 300,000 owed.
    expect([...firstRow.querySelectorAll('td')].map((td) => td.textContent)).toContain('−100,000');
  });
});

describe('LifePlan: sums paid in a set year', () => {
  it('adds a policy maturity to the pot in its year, and says so', () => {
    const maturity = { id: 'l', name: 'LIC A maturity', kind: 'lump_sum', amount: 4350000, currency: 'INR', in_year: thisYear + 10, starts_after_years: 0 };
    renderPlan({ data: { independenceIncome: [maturity] } });
    openTable();
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

  // Which spending stops is kept on the categories, which the plan's own
  // reload doesn't read, so a tick showed only after a later refresh
  // (Planning audit, 0b-C).
  it('reads the categories again after the editor marks one as stopping', async () => {
    const onReload = vi.fn();
    const categories = [{ id: 'rent', name: 'Rent', kind: 'expense' }];
    const { reload } = renderPlan({ categories, onReload });
    fireEvent.click(screen.getByText('Edit plan'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Rent/ }));
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    expect(reload).toHaveBeenCalled();
    expect(calls.updates).toEqual([{ table: 'categories', patch: { stops_after_work: true }, column: 'id', value: 'rent' }]);
  });
});

describe('LifePlan: who the plan covers', () => {
  it('names a member left out for want of ages, and only then', () => {
    renderPlan({ data: { memberLife: AGES.slice(0, 1) } });
    expect(screen.getByText(`${MEMBERS[1].display_name} isn't in the plan: no birth year and age to plan to yet. Add them under Edit plan.`)).toBeTruthy();
  });

  it('says nothing when everyone is planned for', () => {
    renderPlan();
    expect(screen.queryByText(/isn't in the plan/)).toBeNull();
  });
});

// Planning audit, 1.2: once three months have ended the records take over,
// and the budget's answer stays beside theirs.
describe('LifePlan: the budget beside the records', () => {
  const now = new Date();
  const categories = [
    { id: 'food', name: 'Groceries', kind: 'expense' },
    { id: 'save', name: 'Savings', kind: 'expense', is_savings: true },
  ];
  const budget = (category_id, amount) => ({ year: now.getFullYear(), month: now.getMonth() + 1, category_id, amount });

  it('gives what the budget plans and the year it gives, beside the months', () => {
    renderPlan({ categories, budgets: [budget('food', 2000), budget('save', 8000)] });
    const note = screen.getByText(/^Your budget beside the records\./).closest('div').textContent;
    expect(note).toMatch(/The last 3 ended months average spending AED 4,000 and saving AED 6,000 a month; your budget plans spending AED 2,000 and saving AED 8,000\./);
    const [, months, onBudget] = note.match(/The earliest year work can stop is (\d{4}) on the months and (\d{4}) on the budget\./);
    expect(Number(onBudget)).toBeLessThan(Number(months));
    expect(note).toMatch(/Stopping in \d{4}, the money (lasts|runs short in \d{4}) on the budget\. Everything below uses the recorded months\.$/);
  });

  it('says nothing more without a budget', () => {
    renderPlan();
    expect(screen.queryByText(/Your budget beside the records/)).toBeNull();
  });
});
