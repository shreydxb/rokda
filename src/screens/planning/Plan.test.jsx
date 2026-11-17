import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/dom';
import { cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import Plan from './Plan';

// Planning -> Plan, like the prototype (the revamp, phase 6): a strip with the
// basis and the scenario, then When can we stop?, What would it take? and
// What could go wrong? It was the Life plan; what it says is the Life plan's
// own sums (lib/lifePlan.js), now drawn from the kit.

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
    <MemoryRouter>
      <Plan
        household={{ id: 'h', inr_per_aed: 25 }}
        members={MEMBERS}
        accounts={[ACCOUNT]}
        transactions={history()}
        holdings={[]}
        data={{ assumptions: null, goals: [], independenceIncome: [], memberLife: AGES, reload, ...data }}
        loading={false}
        {...props}
      />
    </MemoryRouter>,
  );
  return { reload };
}

const stopYear = () => document.querySelector('.pl-stop-year').textContent;
const verdicts = () => [...document.querySelectorAll('.pl-verdicts .ds-chip')].map((c) => c.textContent);
// The four figures under the stop year, by label.
const figure = (label) => {
  const dt = [...document.querySelectorAll('.pl-figs dt')].find((d) => d.querySelector('span').textContent === label);
  return dt?.nextElementSibling.textContent ?? null;
};
const money = (text) => Number(text.replace(/[^0-9.]/g, ''));
const strip = () => document.querySelector('.pl-strip');
// What an (i) holds, once opened.
function about(name) {
  fireEvent.click(screen.getByRole('button', { name: `About ${name}` }));
  return screen.getByRole('note').textContent;
}
function openFold(name) {
  const details = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary').textContent === name);
  details.open = true;
  fireEvent(details, new Event('toggle'));
  return details;
}
const thisYear = new Date().getFullYear();

beforeEach(() => {
  calls.upserts.length = 0;
  calls.updates.length = 0;
});
afterEach(() => localStorage.clear());

describe('Plan: what never loaded', () => {
  it('says the ages didn\'t load, rather than asking who the plan is for as if none were set', () => {
    renderPlan({ data: { memberLife: [] }, sources: { errors: { memberLife: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.getByText('Couldn’t load ages for the life plan.')).toBeTruthy();
    expect(screen.queryByText('Set up the plan')).toBeNull();
    expect(document.querySelector('.pl-stop-year')).toBeNull();
  });

  it('works the plan out without a budget once three months have closed', () => {
    renderPlan({ sources: { errors: { budgets: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.queryByText(/Couldn’t load/)).toBeNull();
    expect(stopYear()).toBe('2054');
  });
});

describe('Plan: setting up', () => {
  it('asks who the plan is for before anything else', () => {
    renderPlan({ data: { memberLife: [] } });
    expect(screen.getByText('Set up the plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add who it is for' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('says what it needs when there is nothing to project from', () => {
    renderPlan({ transactions: [] });
    expect(screen.getByText('Not enough to project')).toBeTruthy();
    const rows = [...document.querySelectorAll('.lp-need')].map((r) => r.textContent);
    expect(rows).toEqual(['Spending and savingneeds three ended months of records or a monthly budget · has 0', 'What you hold todayprovisional · 1 balance not entered, counted as 0']);
  });

  it('needs a valuation with nothing held', () => {
    renderPlan({ accounts: [] });
    expect([...document.querySelectorAll('.lp-need')][1].textContent).toBe('What you hold todayneeds one account valuation');
  });

  it('says so and asks for a later age once everyone has outlived the plan, rather than crashing', () => {
    const past = [
      { member_id: 'm1', birth_year: 1940, life_expectancy: 84 },
      { member_id: 'm2', birth_year: 1940, life_expectancy: 84 },
    ];
    renderPlan({ data: { memberLife: past } });
    expect(screen.getByText('The plan has run its course')).toBeTruthy();
    expect(screen.getByText(/It plans for Alex to 84 and Sam to 84, and everyone is past that age now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plan to a later age' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('Plan: the strip', () => {
  it('gives the basis and its figures, the scenario, the spending and the rates on one line', () => {
    renderPlan();
    expect(strip().textContent).toMatch(/Basisrecorded months · spending 4,000 · saving 6,000 a month/);
    expect(screen.getByRole('combobox', { name: 'Scenario' }).value).toBe('baseline');
    expect([...screen.getByRole('combobox', { name: 'Scenario' }).options].map((o) => o.textContent)).toEqual(['Baseline', 'Conservative', 'Optimistic']);
    expect(screen.getByRole('combobox', { name: 'Spending after work' }).selectedOptions[0].textContent).toBe("Today's · 48K a year");
    expect(strip().textContent).toMatch(/6\.0% return · 2\.5% inflation/);
    // Why that basis is behind its (i).
    expect(about('the basis')).toMatch(/The average of the last 3 ended months: spending AED 4,000 and saving AED 6,000 a month\./);
  });

  it('keeps what the plan assumes behind the rates\' (i)', () => {
    renderPlan();
    const text = about('the assumptions');
    expect(text).toMatch(/Baseline: 6\.0% a year before work stops and 5\.0% after, less 2\.5% inflation\./);
    expect(text).toMatch(/held in cash and deposits today stays cash at 3\.0% a year; the rest earns the return\./);
  });

  it('plans on the budget once it is chosen, and keeps a choice not in effect yet in view', () => {
    const now = new Date();
    const categories = [
      { id: 'food', name: 'Groceries', kind: 'expense' },
      { id: 'save', name: 'Savings', kind: 'expense', is_savings: true },
    ];
    const budget = (category_id, amount) => ({ year: now.getFullYear(), month: now.getMonth() + 1, category_id, amount });
    renderPlan({ categories, budgets: [budget('food', 2000), budget('save', 8000)], data: { assumptions: { planning_basis: 'budget' } } });
    expect(strip().textContent).toMatch(/Basisyour budget · spending 2,000 · saving 8,000 a month/);
    expect(screen.queryByText(/Your budget beside the records/)).toBeNull();
    cleanup();
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const from = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-01`;
    renderPlan({ categories, budgets: [budget('food', 2000), budget('save', 8000)], data: { assumptions: { planning_basis: 'recorded', records_from: from } } });
    expect(strip().textContent).toMatch(/Basisyour budget, for now/);
    expect(within(strip()).getByText('Recorded months: 1 of 3 ended')).toBeTruthy();
  });

  it('offers the spending that stops, with what it leaves', () => {
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
    // 48,000 a year spent, 36,000 of it rent: 12,000 left once work stops.
    expect(screen.getByRole('combobox', { name: 'Spending after work' }).selectedOptions[0].textContent).toBe('Less what stops · 12K a year');
  });

  it('switches the scenario the plan is shown on', () => {
    renderPlan();
    fireEvent.change(screen.getByRole('combobox', { name: 'Scenario' }), { target: { value: 'optimistic' } });
    expect(strip().textContent).toMatch(/8\.0% return · 1\.5% inflation/);
  });
});

describe('Plan: when can we stop?', () => {
  it('plans to the last life expectancy, stopping work at 60 until a year is saved', () => {
    renderPlan();
    // 200,000 plus 72,000 a year at 3.4% real, spending 48,000 a year from 60: it lasts.
    expect(stopYear()).toBe('2054');
    expect(screen.getByText('Alex 60 · Sam 60 · assumed: the year Alex turns 60')).toBeTruthy();
    expect(verdicts()).toEqual(['Baseline: lasts to 2079', 'Conservative: lasts to 2079']);
    expect(money(figure('Pot in 2054'))).toBeGreaterThan(0);
    expect(money(figure('Left in 2079'))).toBeGreaterThan(0);
    expect(figure('Short by')).toBeNull();
    // A year nobody chose can be made the plan.
    expect(screen.getByText('Not saved')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make this the plan' })).toBeTruthy();
  });

  it('runs out when work stops too soon, and is short by the gap between what is needed and what the pot holds then', () => {
    renderPlan({ data: { assumptions: { retirement_year: thisYear + 1, retirement_annual_spend: 150000 } } });
    expect(verdicts()[0]).toMatch(/^Baseline: runs out \d{4}$/);
    const need = money(figure(`Needed then`));
    const pot = money(figure(`Pot in ${thisYear + 1}`));
    expect(money(figure('Short by'))).toBeCloseTo(need - pot, -1);
    expect(figure('Left in 2079')).toBeNull();
  });

  it('steps the stop year, says it isn\'t saved, and puts it back', () => {
    renderPlan({ data: { assumptions: { retirement_year: 2054 } } });
    expect(screen.queryByText('Not saved')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous year' }));
    expect(stopYear()).toBe('2053');
    expect(screen.getByText(/trying it: your plan says 2054/)).toBeTruthy();
    expect(screen.getByText('Not saved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(stopYear()).toBe('2054');
    expect(screen.queryByText('Not saved')).toBeNull();
  });

  it('saves a stop year tried on the screen as the plan', async () => {
    const { reload } = renderPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Previous year' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make this the plan' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.upserts).toEqual([{ table: 'planning_assumptions', row: expect.objectContaining({ household_id: 'h', retirement_year: 2053 }) }]);
  });

  it('names a member left out for want of ages, and only then', () => {
    renderPlan({ data: { memberLife: AGES.slice(0, 1) } });
    expect(screen.getByText("Sam isn't in the plan: no birth year and age to plan to yet.")).toBeTruthy();
    cleanup();
    renderPlan();
    expect(screen.queryByText(/isn't in the plan/)).toBeNull();
  });

  it('says the start leaves out balances never entered, counted as 0', () => {
    const unentered = { id: 'a2', name: 'Current account', type: 'checking', currency: 'AED', balance: null, balance_aed: null, balance_as_of: null, is_shared: true, archived_at: null };
    const confirmed = { ...ACCOUNT, balance_as_of: '2026-10-01' };
    renderPlan({ accounts: [confirmed] });
    expect(screen.queryByText(/Provisional:/)).toBeNull();
    cleanup();
    renderPlan({ accounts: [confirmed, unentered] });
    expect(screen.getByText(/Provisional: 1 balance not entered, counted as 0\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Net worth' }).getAttribute('href')).toBe('/wealth');
  });

  it('names a rupee income it leaves out for want of a rate', () => {
    const pension = { id: 'p1', name: 'Pension in India', kind: 'yearly', amount: 600000, currency: 'INR', starts_after_years: 0, lasts_years: null };
    renderPlan({ household: { id: 'h', inr_per_aed: null }, data: { independenceIncome: [pension] } });
    expect(screen.getByText(/Pension in India is not counted: no AED\/INR rate is set yet\./)).toBeTruthy();
  });
});

describe('Plan: the pot, year by year', () => {
  it('draws the pot with its band, and leaves the plan alone on a step along the chart', () => {
    renderPlan();
    expect(document.querySelector('.ds-pb-band')).toBeTruthy();
    const before = solverRuns.earliest;
    expect(before).toBeGreaterThan(0);
    const readout = () => document.querySelector('.pl-readout .ds-fig').textContent;
    expect(readout()).toBe('2054');
    const chart = screen.getByRole('group', { name: /^The pot at the start of each year/ });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(readout()).toBe('2056');
    expect(solverRuns.earliest).toBe(before);
  });

  it('lists every fifth year and the stop year in Year by year', () => {
    renderPlan();
    const rows = [...openFold('Year by year').querySelectorAll('tbody tr')];
    const years = rows.map((r) => r.querySelector('td').textContent);
    expect(years[0]).toBe(String(thisYear));
    expect(years).toContain('2054');
    expect(rows.find((r) => r.querySelector('td').textContent === '2054').textContent).toContain('Work stops');
  });

  it('shows a loan larger than the accounts as owed rather than held', () => {
    const loan = { id: 'l1', type: 'loan', currency: 'AED', balance: 300000, balance_aed: 300000, is_shared: true, archived_at: null };
    renderPlan({ accounts: [ACCOUNT, loan] });
    const first = openFold('Year by year').querySelector('tbody tr');
    // 200,000 held less 300,000 owed.
    expect(first.textContent).toContain('−100,000');
  });

  it('lists the open goals on the timeline, each with how the plan pays it', () => {
    const goal = (id, name, extra = {}) => ({ id, name, target_amount: 30000, target_date: `${thisYear + 5}-06-01`, counts_in_life_plan: true, ...extra });
    renderPlan({ data: { goals: [goal('g1', 'Car'), goal('g2', 'Boat', { done_at: '2026-01-02T00:00:00Z' }), goal('g3', 'Emergency fund', { counts_in_life_plan: false })] } });
    const fold = openFold('Goals on the timeline');
    const rows = [...fold.querySelectorAll('.pl-goal')].map((r) => r.textContent);
    expect(rows).toEqual([`Car30,000Paid ${thisYear + 5}`, 'Emergency fund30,000Kept']);
    expect(within(fold).getByRole('link', { name: /^Car/ }).getAttribute('href')).toBe('/planning?tab=goals&goal=g1');
  });
});

describe('Plan: what would it take?', () => {
  it('gives three ways to make the money last, each tried in one press', () => {
    renderPlan({ data: { assumptions: { retirement_year: thisYear + 1, retirement_annual_spend: 150000 } } });
    const levers = document.querySelector('.pl-levers');
    const labels = [...levers.querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toEqual(['Stop in', 'or save', 'or spend at most']);
    expect(levers.textContent).toMatch(/more a month/);
    const earliest = levers.querySelector('.ds-kpi-value .ds-fig').textContent;
    fireEvent.click(within(levers).getByRole('button', { name: 'Try' }));
    expect(stopYear()).toBe(earliest);
  });

  it('says nothing more is needed when the money lasts, and how early work could stop', () => {
    renderPlan();
    const levers = document.querySelector('.pl-levers');
    expect(levers.textContent).toMatch(/Lasts to 2079Nothing more is needed on Baseline\./);
    expect(levers.textContent).toMatch(/Could stop as early as \d{4}/);
  });

  it('names the goal the pot can\'t pay while still working', () => {
    const goals = [{ id: 'g1', name: 'Villa', target_amount: '5000000', target_date: `${thisYear + 1}-06-01`, counts_in_life_plan: true }];
    renderPlan({ data: { goals } });
    expect(verdicts()[0]).toBe(`Baseline: short ${thisYear + 1}`);
    expect(document.querySelector('.pl-levers').textContent).toMatch(new RegExp(`^The pot is [\\d,]+ short for Villa in ${thisYear + 1}\\. Move it later or make it smaller`));
  });
});

describe('Plan: what could go wrong?', () => {
  it('puts the plan through a market fall the year work stops, on Baseline, against the steady plan', () => {
    renderPlan();
    const card = screen.getByRole('region', { name: 'If markets fall' });
    expect(card.textContent).toMatch(/A two-year fall from 2054 · steady plan lasts to 2079/);
    expect(card.textContent).not.toMatch(/ten years in/);
    fireEvent.change(screen.getByRole('combobox', { name: 'Scenario' }), { target: { value: 'conservative' } });
    expect(about('If markets fall')).toMatch(/Always on Baseline, so caution is not counted twice\./);
    const details = [...card.querySelectorAll('details')][0];
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(within(card).getByRole('group', { name: /^With a market fall in 2054, against the steady plan/ })).toBeTruthy();
  });

  it('shows no rupee case with nothing in rupees', () => {
    renderPlan();
    expect(screen.queryByRole('region', { name: 'If the rupee weakens' })).toBeNull();
  });

  it('puts a policy paid in rupees through a weakening rupee', () => {
    const policy = { id: 'p1', name: 'Policy maturity', kind: 'lump_sum', in_year: thisYear + 15, amount: 2500000, currency: 'INR' };
    renderPlan({ data: { independenceIncome: [policy] } });
    const card = screen.getByRole('region', { name: 'If the rupee weakens' });
    expect(card.textContent).toMatch(/Rupees lose 3% a year against the dirham · steady plan (lasts to 2079|runs out \d{4})/);
    expect(about('If the rupee weakens')).toMatch(/The plan counts 1 source of income in rupees: income in rupees is worth less\./);
  });
});

describe('Plan: what the plan assumes', () => {
  it('says the instalment is in spending until the loan clears, and starts before what it owes', () => {
    const loanAccount = { id: 'la', type: 'loan', currency: 'AED', balance: 12000, balance_aed: 12000, is_shared: true, archived_at: null };
    const debts = [{ id: 'd1', name: 'Car loan', balance: 12000, apr_pct: 0, minimum_payment: 1000, account_id: 'la', is_shared: true }];
    renderPlan({ accounts: [ACCOUNT, loanAccount], data: { debts } });
    expect(about('the assumptions')).toMatch(/Car loan's AED 1,000 a month is in today's spending until it clears about \w{3} \d{4}/);
  });

  it('says what the costs after work are', () => {
    const cover = { id: 'c1', name: 'Health cover', amount: 8000, currency: 'AED', per_person: true, rise_pct: 0, starts_after_years: 0, lasts_years: null };
    renderPlan({ data: { afterWorkCosts: [cover] } });
    expect(about('the assumptions')).toMatch(/Costs that start when work stops, on top of the spending: Health cover AED 8,000 a year for each person\./);
  });

  it('adds a sum paid in a set year to the pot in its year, and says so', () => {
    const maturity = { id: 'l', name: 'LIC A maturity', kind: 'lump_sum', amount: 4350000, currency: 'INR', in_year: thisYear + 10, starts_after_years: 0 };
    renderPlan({ data: { independenceIncome: [maturity] } });
    expect(about('the assumptions')).toMatch(new RegExp(`LIC A maturity \\(${thisYear + 10}\\) is added in its year, converted at today's rate`));
  });
});

describe('Plan: changing the plan', () => {
  // Which spending stops is kept on the categories, which the plan's own
  // reload doesn't read (Planning audit, 0b-C).
  it('reads the categories again after the editor marks one as stopping', async () => {
    const onReload = vi.fn();
    const categories = [{ id: 'rent', name: 'Rent', kind: 'expense' }];
    const { reload } = renderPlan({ categories, onReload });
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Rent/ }));
    fireEvent.click(screen.getByText('Save plan'));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    expect(reload).toHaveBeenCalled();
    expect(calls.updates).toEqual([{ table: 'categories', patch: { stops_after_work: true }, column: 'id', value: 'rent' }]);
  });
});
