import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/dom';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { minimumOnlyPayoff, payoffMonthLabel } from '../../lib/debt';
import { renderHook } from '@testing-library/react';
import { ScopeProvider } from '../../lib/ScopeContext';
import GoalsDebts from './GoalsDebts';
import { usePlanFigures } from './usePlanFigures';

// Planning -> Goals & debts, like the prototype (the revamp, phase 6b): a
// table card a group of goals, Done folded, then the debts with their order,
// three figures, a table and Extra a month typed in place. A goal or a debt
// opens through its address (GoalDrawer, DebtDrawer).

const calls = vi.hoisted(() => ({ upserts: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: async (row, options) => {
        calls.upserts.push({ table, row, options });
        return { error: null };
      },
    }),
  },
}));

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
const CAR = { id: 'g3', name: 'Car', target_amount: 10000, target_date: '2040-01-01', is_shared: true, owner_member_id: null, note: '', funding_source: '' };
const VILLA = { id: 'g2', name: 'Villa', target_amount: 1000000, target_date: '2044-09-01', is_shared: true, owner_member_id: null, note: '', funding_source: '', cost_today: true, inflation_pct: 8, priority: 1 };
const HOUSE = { id: 'g4', name: 'House', target_amount: 900000, target_date: null, is_shared: true, owner_member_id: null, note: '', funding_source: '' };
// Three ended months spending 4,000 on 10,000 of income, and ages, so the
// plan has a timeline.
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

// Where the screen sent the address, for the rows and buttons that open a
// goal or a debt.
function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}
function renderScreenAt(data, props = {}) {
  renderScreen(
    <MemoryRouter initialEntries={['/planning?tab=goals']}>
      <GoalsDebts household={{ id: 'h' }} members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} holdings={[]} data={{ ...DATA, ...data }} loading={false} {...props} />
      <Where />
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId('where').textContent;
const goalRow = (name) => [...document.querySelectorAll('.gd-goals tbody tr')].find((r) => r.querySelector('.gd-name')?.textContent === name);
const cells = (tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent);
const card = (title) => screen.getByRole('region', { name: title });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 24, 12));
  calls.upserts.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

// Overview's Plan strip reads usePlanFigures, so it agrees with the table.
describe('Overview\'s Plan strip agrees with Goals & debts', () => {
  it('counts linked accounts in saved, as the table does', () => {
    const { result } = renderHook(() => usePlanFigures({ members: MEMBERS, me: { id: 'm1' }, accounts: ACCOUNTS, transactions: [], holdings: [], data: DATA, sources: { errors: {}, loaded: {} } }), {
      wrapper: ({ children }) => <ScopeProvider>{children}</ScopeProvider>,
    });
    // Half of a 50,000 account; the 5,000 logged is its record, not added on top.
    expect(result.current.nearCash).toBe(25000);
  });
});

describe('Goals & debts: what never loaded', () => {
  it('says the goals didn\'t load, rather than offering to add the first goal', () => {
    renderScreenAt({ goals: [] }, { sources: { errors: { goals: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.getByText('Couldn’t load goals.')).toBeTruthy();
    expect(screen.queryByText('No goals yet')).toBeNull();
  });

  it('waits for the assumptions too, rather than costing goals at the defaults', () => {
    renderScreenAt({}, { sources: { errors: { assumptions: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.getAllByText(/Couldn’t load planning assumptions\./).length).toBeGreaterThan(0);
    expect(document.querySelector('.gd-goals')).toBeNull();
  });
});

describe('Goals & debts: goals due within 3 years, from cash', () => {
  it('gives each its target and date, the cash set aside, the share and what it needs a month', () => {
    renderScreenAt({});
    // Half of a 50,000 savings account, the 5,000 logged not added on top:
    // 75,000 over the 15 months to Dec 2027.
    expect(within(card('Next 3 years · from cash')).getByText('25,000 of 100,000 · needs 5,000 a month')).toBeTruthy();
    const row = goalRow('Emergency fund');
    expect(cells(row)).toEqual(expect.arrayContaining(['100,000by Dec 2027', '25,000', '5,000', 'Saving']));
    expect(row.textContent).toContain('25%');
    expect(within(row).getByText('Saving').getAttribute('title')).toBe('Due within 3 years, so paid from cash: 5,000 a month to Dec 2027.');
  });

  it('leaves a linked holding out: a goal due soon can\'t wait for a market', () => {
    const allocations = [{ id: 'l2', goal_id: 'g1', account_id: null, holding_id: 'h1', share_pct: 100 }];
    renderScreenAt({ goalAllocations: allocations }, { holdings: [{ id: 'h1', value_aed: 500000 }] });
    expect(cells(goalRow('Emergency fund'))).toContain('6,667');
  });

  it('holds kept money in its own card, with the cash reserve', () => {
    renderScreenAt({ goals: [{ ...GOAL, counts_in_life_plan: false }] });
    const kept = card('Kept, not spent · in cash');
    expect(within(kept).getByText('Emergency fund')).toBeTruthy();
    expect(kept.querySelector('.gd-reserve').textContent).toMatch(/^Cash reserve50,000 in current, savings and cash accounts/);
    expect(within(kept).getByText('Short of kept goals')).toBeTruthy();
  });

  it('settles a goal whose plan covers it, and marks a plan that falls short', () => {
    renderScreenAt({ goals: [{ ...GOAL, planned_monthly: 5000 }] });
    expect(within(goalRow('Emergency fund')).getByText('Planned')).toBeTruthy();
    document.body.innerHTML = '';
    renderScreenAt({ goals: [{ ...GOAL, planned_monthly: 3000 }] });
    const chip = within(goalRow('Emergency fund')).getByText('Plan short');
    // 75,000 at 3,000 a month: 25 months from Sep 2026.
    expect(chip.getAttribute('title')).toMatch(/At the 3,000 you plan, it is covered by Oct 2028\.$/);
  });

  it('orders a group by priority, then by date', () => {
    const trip = { ...GOAL, id: 'g5', name: 'Trip', target_date: '2027-03-31', priority: 1 };
    const sofa = { ...GOAL, id: 'g6', name: 'Sofa', target_date: '2027-01-31' };
    renderScreenAt({ goals: [GOAL, sofa, trip], goalAllocations: [] });
    expect([...card('Next 3 years · from cash').querySelectorAll('.gd-name')].map((n) => n.textContent)).toEqual(['Trip', 'Sofa', 'Emergency fund']);
  });

  it('gives a goal\'s note under its name', () => {
    renderScreenAt({ goals: [{ ...GOAL, note: 'Six months of spending' }] });
    expect(within(goalRow('Emergency fund')).getByText('Six months of spending')).toBeTruthy();
  });
});

// Planning audit, 2.8: what has gone in lately, from the goal's one source.
describe('Goals & debts: pace', () => {
  const opened = [{ id: 1, account_id: 'a1', old_balance: null, new_balance: 30000, recorded_at: '2026-06-01T08:00:00Z' }];

  it('reads a linked goal\'s pace from its account, marked low below its plan', () => {
    renderScreenAt({ goals: [{ ...GOAL, planned_monthly: 5000 }], balanceEvents: opened });
    // Half of 20,000 over the last 91 days.
    const pace = goalRow('Emergency fund').querySelector('.gd-pace');
    expect(pace.textContent).toBe('3,345');
    expect(pace.classList.contains('gd-low')).toBe(true);
  });

  // The fresh review of 6b: money coming out read as going in.
  it('keeps the minus on a pace that is falling', () => {
    const fell = [{ id: 1, account_id: 'a1', old_balance: null, new_balance: 70000, recorded_at: '2026-06-01T08:00:00Z' }];
    renderScreenAt({ balanceEvents: fell });
    expect(goalRow('Emergency fund').querySelector('.gd-pace').textContent).toBe('−3,345');
  });

  it('gives none until a month of changes is recorded, or when they could not be read', () => {
    renderScreenAt({ balanceEvents: [] });
    expect(goalRow('Emergency fund').querySelector('.gd-pace').textContent).toBe('');
  });

  it('reads a goal with nothing linked from what was logged to it', () => {
    renderScreenAt({ goalAllocations: [] });
    expect(goalRow('Emergency fund').querySelector('.gd-pace').textContent).toBe('1,672');
  });
});

describe('Goals & debts: later and undated goals', () => {
  it('takes a later goal\'s state from the plan\'s timeline', () => {
    renderScreenAt({ ...LIFE, goals: [CAR, VILLA] }, { transactions: history() });
    expect(within(goalRow('Car')).getByText('Paid in 2040').getAttribute('title')).toBe('The plan pays it from your savings and investments in 2040.');
    expect(within(goalRow('Villa')).getByText('Short in 2044')).toBeTruthy();
  });

  it('says a goal dated after the plan ends is beyond it, and one with no plan to check it is not checked', () => {
    renderScreenAt({ ...LIFE, goals: [{ ...CAR, id: 'g9', name: 'Far', target_date: '2081-01-01' }] }, { transactions: history() });
    expect(within(goalRow('Far')).getByText('Beyond the plan')).toBeTruthy();
    document.body.innerHTML = '';
    renderScreenAt({ goals: [CAR] });
    expect(within(goalRow('Car')).getByText('Not checked')).toBeTruthy();
  });

  it('puts a goal with no date in its own card, in no plan', () => {
    renderScreenAt({ goals: [GOAL, HOUSE] });
    expect(within(card('No date')).getByText('House')).toBeTruthy();
    expect(within(goalRow('House')).getByText('No date').getAttribute('title')).toBe('Not in any plan: set a date to plan for it.');
  });

  it('no longer has the priority what-if', () => {
    renderScreenAt({ ...LIFE, goals: [GOAL, VILLA, CAR] }, { transactions: history() });
    expect(screen.queryByText('If your investments paid for these')).toBeNull();
  });
});

describe('Goals & debts: done goals, and none', () => {
  it('folds the done goals, each with when it was done', () => {
    renderScreenAt({ goals: [GOAL, { ...HOUSE, done_at: '2026-09-01T08:00:00Z' }] });
    const fold = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary').textContent === 'Done (1)');
    expect(within(fold).getByText('House')).toBeTruthy();
    expect(within(fold).getByText('Done Sep 2026')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'No date' })).toBeNull();
  });

  it('says every goal is done rather than that there are none', () => {
    renderScreenAt({ goals: [{ ...GOAL, done_at: '2026-09-01T08:00:00Z' }] });
    expect(screen.queryByText('No goals yet')).toBeNull();
    expect(screen.getByText('Every goal is done.')).toBeTruthy();
  });

  it('offers the first goal when there are none', () => {
    renderScreenAt({ goals: [] });
    expect(screen.getByText('No goals yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a goal' }));
    expect(where()).toBe('/planning?tab=goals&goal=new');
  });
});

describe('Goals & debts: opening a goal or a debt', () => {
  it('opens a goal through its address, and adds one or a debt from the header', () => {
    renderScreenAt({});
    fireEvent.click(within(goalRow('Emergency fund')).getByRole('button', { name: 'Emergency fund' }));
    expect(where()).toBe('/planning?tab=goals&goal=g1');
    fireEvent.click(screen.getByRole('button', { name: '+ Goal' }));
    expect(where()).toBe('/planning?tab=goals&goal=new');
    fireEvent.click(screen.getByRole('button', { name: '+ Debt' }));
    expect(where()).toBe('/planning?tab=goals&debt=new');
  });
});

// The debts (Planning audit, 1.4 and the revamp, phase 6b).
const LOAN = { id: 'loan', name: 'Car loan', type: 'loan', currency: 'AED', balance: 38000, balance_aed: 38000, is_shared: true, archived_at: null };
const debt = (over) => ({ id: 'd1', name: 'Car loan', note: '', balance: 40000, apr_pct: 3.5, minimum_payment: 2193, is_shared: true, account_id: 'loan', ...over });
const atMinimum = (balance, apr, minimum) => payoffMonthLabel(minimumOnlyPayoff([{ balance, apr_pct: apr, minimum_payment: minimum }]).months, new Date());
function renderDebts(debts, { assumptions = null, sources, accounts = [LOAN], reload = vi.fn() } = {}) {
  renderScreenAt({ goals: [], debts, assumptions, reload }, { accounts, sources });
  return { reload };
}
const kpi = (label) => [...document.querySelectorAll('.gd-debts .ds-kpi')].find((k) => k.querySelector('dt').textContent === label);
const debtRow = (name) => [...document.querySelectorAll('.gd-debts tbody tr')].find((r) => r.querySelector('.gd-name')?.textContent === name);

describe('Goals & debts: the debts', () => {
  it('owes a linked debt at its account\'s balance, the one net worth counts', () => {
    renderDebts([debt()]);
    expect(kpi('Owed').querySelector('dd').textContent).toBe('38,000');
    expect(screen.queryByText('Not in net worth')).toBeNull();
  });

  it('says a debt with no account is not in net worth, and links one from its row', () => {
    renderDebts([debt({ account_id: null, name: 'Personal loan' })]);
    const row = debtRow('Personal loan');
    expect(within(row).getByText('Not in net worth')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Link account' }));
    expect(where()).toBe('/planning?tab=goals&debt=d1');
  });

  it('gives when the debts clear at the minimums and the interest still to pay', () => {
    renderDebts([debt()]);
    expect(kpi('Clears').querySelector('dd').textContent).toBe(`${atMinimum(38000, 3.5, 2193)}at the minimum payments`);
    expect(kpi('Interest still to pay').querySelector('dd').textContent).toMatch(/^[\d,]+$/);
    expect(cells(debtRow('Car loan'))).toEqual(expect.arrayContaining(['−38,000', '3.5%', '2,193', atMinimum(38000, 3.5, 2193)]));
  });

  it('names debts with a 0 rate or minimum for checking, since the dates rest on them', () => {
    renderDebts([debt(), debt({ id: 'd2', name: 'Card', account_id: null, apr_pct: 0, minimum_payment: 0, balance: 500 })]);
    expect(screen.getByText(/^Check the rate and minimum on Card: a 0 is real for some loans/)).toBeTruthy();
    expect(cells(debtRow('Card'))).toContain('Never');
  });

  // The fresh review of 6b: a debt its minimum never clears gave the band
  // the other debts' date.
  it('gives no date when a debt never clears at its minimum', () => {
    renderDebts([debt({ id: 'card', name: 'Card', account_id: null, balance: 10000, apr_pct: 30, minimum_payment: 100 }), debt({ account_id: null, balance: 12000, apr_pct: 5, minimum_payment: 1000 })]);
    expect(kpi('Clears').querySelector('dd').textContent).toMatch(/^—No payoff date: the minimum on Card doesn't cover its interest/);
    expect(kpi('Interest still to pay').querySelector('dd').textContent).toBe('—');
    fireEvent.change(screen.getByLabelText('Extra a month'), { target: { value: '500' } });
    expect(document.querySelector('.gd-extra').textContent).toMatch(/against no date at the minimums/);
  });

  it('says a card in credit owes nothing', () => {
    const cardAccount = { id: 'card', name: 'Bank card', type: 'credit_card', currency: 'AED', balance: -1500, balance_aed: -1500, is_shared: true, archived_at: null };
    renderDebts([debt({ name: 'Bank card', account_id: 'card' })], { accounts: [cardAccount] });
    expect(cells(debtRow('Bank card'))).toContain('In credit');
    expect(kpi('Clears').querySelector('dd').textContent).toBe('Nothing owed');
  });
});

describe('Goals & debts: the payoff order', () => {
  const two = [debt(), debt({ id: 'd2', name: 'Bank card', account_id: null, balance: 3000, apr_pct: 30, minimum_payment: 300 })];

  it('is not offered while one debt is owed, since it changes nothing', () => {
    renderDebts([debt()]);
    expect(screen.queryByRole('group', { name: 'Payoff order' })).toBeNull();
  });

  it('saves the order chosen, for both partners, and lists the debts in it', async () => {
    const { reload } = renderDebts(two);
    expect([...document.querySelectorAll('.gd-debts .gd-name')].map((n) => n.textContent)).toEqual(['Bank card', 'Car loan']);
    fireEvent.click(screen.getByRole('button', { name: 'Snowball' }));
    expect(screen.getByRole('button', { name: 'Snowball' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.upserts).toEqual([{ table: 'planning_assumptions', row: expect.objectContaining({ household_id: 'h', debt_order: 'snowball' }), options: { onConflict: 'household_id' } }]);
  });
});

// Decision 4 of the phase 6 design: typed in place as a what-if, shown at
// once, and saved with Make this the plan, as the stop year is.
describe('Goals & debts: Extra a month', () => {
  const extra = () => screen.getByLabelText('Extra a month');

  it('shows at once how much sooner the debts clear and what it saves, and saves it as the plan', async () => {
    const { reload } = renderDebts([debt()]);
    expect(screen.getByText('Try an amount to see how much sooner the debts clear.')).toBeTruthy();
    fireEvent.change(extra(), { target: { value: '2000' } });
    const effect = document.querySelector('.gd-extra').textContent;
    expect(effect).toMatch(new RegExp(`Clears \\w{3} \\d{4} · saves [\\d,]+ in interest, against ${atMinimum(38000, 3.5, 2193)} at the minimums`));
    expect(kpi('Clears').querySelector('dd').textContent).toMatch(/with 2,000 extra a month$/);
    expect(screen.getByText('Not saved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make this the plan' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.upserts).toEqual([{ table: 'planning_assumptions', row: expect.objectContaining({ household_id: 'h', debt_extra_payment: 2000 }), options: { onConflict: 'household_id' } }]);
  });

  it('opens on the extra saved, and puts a change back with Reset', () => {
    renderDebts([debt()], { assumptions: { debt_extra_payment: 2000 } });
    expect(extra().value).toBe('2000');
    expect(screen.queryByText('Not saved')).toBeNull();
    fireEvent.change(extra(), { target: { value: '500' } });
    expect(screen.getByText('Not saved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(extra().value).toBe('2000');
  });

  it('refuses an amount below nothing', () => {
    renderDebts([debt()]);
    fireEvent.change(extra(), { target: { value: '-5' } });
    expect(screen.getByText('An extra payment of 0 or more.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make this the plan' })).toBeNull();
  });

  it('is the household\'s: one partner\'s view only reads it', () => {
    localStorage.setItem('rokda.scope', 'me');
    renderDebts([debt()], { assumptions: { debt_extra_payment: 2000 } });
    expect(extra().disabled).toBe(true);
    expect(screen.getByText(/The extra payment is the household’s/)).toBeTruthy();
  });

  it('isn\'t offered when the saved plan didn\'t load, with no way to save over it', () => {
    renderDebts([debt()], { sources: { errors: { assumptions: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.queryByLabelText('Extra a month')).toBeNull();
  });
});

describe('Goals & debts: debts that never loaded', () => {
  it('says so, rather than showing no debts', () => {
    renderDebts([], { sources: { errors: { debts: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.getByText('Couldn’t load debts.')).toBeTruthy();
  });
});
