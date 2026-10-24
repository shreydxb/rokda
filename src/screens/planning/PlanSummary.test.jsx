import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/dom';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { orderDebts, payoffMonthLabel, simulatePayoffPlan } from '../../lib/debt';
import PlanSummary from './PlanSummary';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const ACCOUNT = { id: 'a1', name: 'Savings', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, balance_as_of: '2026-10-01T09:00:00Z', is_shared: true, archived_at: null };
const MEMBERS = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
];
const AGES = [
  { member_id: 'm1', birth_year: 1994, life_expectancy: 80 },
  { member_id: 'm2', birth_year: 1994, life_expectancy: 85 },
];

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

function renderSummary(data = {}, sources, { accounts = [ACCOUNT], budgets = [], categories = [] } = {}) {
  const onOpenTab = vi.fn();
  const onRetry = vi.fn();
  renderScreen(
    <MemoryRouter>
      <PlanSummary
        sources={sources}
        onRetry={onRetry}
        members={MEMBERS}
        me={MEMBERS[0]}
        accounts={accounts}
        budgets={budgets}
        categories={categories}
        transactions={history()}
        holdings={[]}
        data={{ goals: [], goalContributions: [], goalAllocations: [], debts: [], assumptions: null, independenceIncome: [], memberLife: AGES, ...data }}
        loading={false}
        onOpenTab={onOpenTab}
      />
    </MemoryRouter>,
  );
  return { onOpenTab, onRetry };
}

afterEach(() => localStorage.clear());

const card = (label) => screen.getByRole('button', { name: `${label}: open ${label === 'Stop working' ? 'Life plan' : label}` });
const LOAN = { id: 'd1', name: 'Car loan', note: '', balance: 12000, apr_pct: 0, minimum_payment: 1000, is_shared: true, account_id: null };

describe('PlanSummary: when work can stop', () => {
  it('gives the Life plan year once ages are set, and opens the Life plan', () => {
    const { onOpenTab } = renderSummary();
    expect(screen.queryByText('Independence')).toBeNull();
    expect(screen.getByText('Stop working')).toBeTruthy();
    expect(screen.getByText(/^Alex \d+ · Sam \d+ · the money lasts to 2079 · spending AED 48,000 a year after work stops \(as today\)$/)).toBeTruthy();
    fireEvent.click(screen.getByText('Life plan →'));
    expect(onOpenTab).toHaveBeenCalledWith('life');
  });

  it('puts the answer first, ahead of goals and debt', () => {
    renderSummary();
    expect(document.querySelector('.ov-quality-grid .ov-kicker').textContent).toBe('Stop working');
  });

  it('says when the saved stop year does not last', () => {
    renderSummary({ assumptions: { retirement_year: new Date().getFullYear() + 1, retirement_annual_spend: 150000 } });
    expect(screen.getByText(/· not by your plan's \d{4}$/)).toBeTruthy();
  });

  it('falls back to the independence year while no ages are set', () => {
    const { onOpenTab } = renderSummary({ memberLife: [] });
    expect(screen.getByText('Independence')).toBeTruthy();
    expect(document.querySelector('.ov-quality-grid .ov-kicker').textContent).toBe('Goals');
    fireEvent.click(screen.getByText('Forecast →'));
    expect(onOpenTab).toHaveBeenCalledWith('forecast');
  });
});

describe('PlanSummary: records that never loaded are not read as none', () => {
  const failed = { message: 'canceling statement due to statement timeout' };

  it('says goals and debts did not load, works out no stop year, and does not say All clear', () => {
    const { onRetry } = renderSummary({}, { errors: { goals: failed, debts: failed }, loaded: { accounts: true, transactions: true } });
    expect(screen.queryByText(/All clear/)).toBeNull();
    expect(screen.queryByText('No goals yet')).toBeNull();
    expect(screen.queryByText('No debts on record')).toBeNull();
    expect(screen.getByText('Not all checked')).toBeTruthy();
    expect(screen.getByText('Couldn’t load goals and debts. What rests on them isn’t checked.')).toBeTruthy();
    expect(screen.getByText('Couldn’t load goals.')).toBeTruthy();
    expect(screen.getByText('Couldn’t load debts.')).toBeTruthy();
    // The stop year rests on the debts too: a loan paid out of spending is
    // counted there once (Planning audit, 2.10).
    expect(screen.getByText('Couldn’t load goals and debts. No year is worked out without them.')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('still shows what loaded before, when only a later read failed', () => {
    renderSummary({}, { errors: { goals: failed }, loaded: { goals: true, debts: true, accounts: true, transactions: true } });
    expect(screen.getByText('All clear — nothing here needs a decision.')).toBeTruthy();
    expect(screen.queryByText(/Couldn’t load/)).toBeNull();
  });

  it('with the household unread, says so rather than that there is nothing to plan', () => {
    renderSummary({}, { errors: { household: { message: 'canceling statement due to statement timeout' } }, loaded: { household: false } });
    expect(screen.queryByText('Nothing to plan yet')).toBeNull();
    expect(screen.getByText('Couldn’t load your household. What rests on them isn’t checked.')).toBeTruthy();
  });

  it('offers what it could check and names the rest once, when only the ages are unread', () => {
    renderSummary({ debts: [LOAN], memberLife: [] }, { errors: { memberLife: { message: 'canceling statement due to statement timeout' } }, loaded: { household: true, debts: true, assumptions: true } }, { accounts: [{ ...ACCOUNT, balance_as_of: null }] });
    expect(screen.getByText('1 open · not all checked')).toBeTruthy();
    expect(screen.getByText('Balance not entered: Savings. Every figure here counts it as 0.')).toBeTruthy();
    expect(screen.getByText('Couldn’t load ages for the life plan. What rests on them isn’t checked.')).toBeTruthy();
  });
});

// Planning audit, 1.1: every figure on Plan comes from a record or says it is
// assumed.
describe('PlanSummary: the debt card dates the debt', () => {
  const now = new Date();

  it('at the minimum payment, with no extra payment committed', () => {
    renderSummary({ debts: [LOAN] });
    expect(within(card('Debt payoff')).getByText(`Clears about ${payoffMonthLabel(12, now)} at the minimum payment · not all in net worth`)).toBeTruthy();
  });

  it('at the minimums for several debts, naming the last to clear', () => {
    const card2 = { ...LOAN, id: 'd2', name: 'Bank card', balance: 1000, minimum_payment: 500 };
    renderSummary({ debts: [LOAN, card2] });
    expect(within(card('Debt payoff')).getByText(`All clear about ${payoffMonthLabel(12, now)} at the minimums, Car loan last · not all in net worth`)).toBeTruthy();
  });

  it('with the extra payment once one is committed, for the household only', () => {
    const assumptions = { debt_extra_payment: 1000, debt_assume_no_new_card_spend: true };
    renderSummary({ debts: [LOAN], assumptions });
    expect(within(card('Debt payoff')).getByText(`Clears about ${payoffMonthLabel(6, now)} with the extra payment · not all in net worth`)).toBeTruthy();
  });

  it('in one partner\'s view, at the minimums: the extra payment is the household\'s', () => {
    localStorage.setItem('rokda.scope', 'me');
    renderSummary({ debts: [LOAN], assumptions: { debt_extra_payment: 1000, debt_assume_no_new_card_spend: true } });
    expect(within(card('Debt payoff')).getByText(`Clears about ${payoffMonthLabel(12, now)} at the minimum payment · not all in net worth`)).toBeTruthy();
  });

  it('says nothing is owed once every debt is paid off', () => {
    renderSummary({ debts: [{ ...LOAN, balance: 0 }] });
    expect(within(card('Debt payoff')).getByText('Nothing owed · not all in net worth')).toBeTruthy();
  });

  it('says when a minimum never clears the debt', () => {
    renderSummary({ debts: [{ ...LOAN, apr_pct: 24, minimum_payment: 100 }] });
    expect(within(card('Debt payoff')).getByText("No payoff date: the minimum on Car loan doesn't cover its interest · not all in net worth")).toBeTruthy();
  });
});

describe('PlanSummary: what needs a decision', () => {
  it('no longer counts goals behind a 90-day pace, or presses for an extra debt payment', () => {
    const goal = { id: 'g1', name: 'Trip', target_amount: 12000, target_date: '2030-01-01', is_shared: true, created_at: '2026-01-01T00:00:00Z' };
    renderSummary({ goals: [goal], debts: [LOAN] });
    expect(screen.queryByText(/behind pace/)).toBeNull();
    expect(screen.queryByText(/extra payment set/)).toBeNull();
    expect(screen.getByText('All clear — nothing here needs a decision.')).toBeTruthy();
  });

  it('names the balances not entered and links to them', () => {
    const accounts = [
      { ...ACCOUNT, balance_as_of: null },
      { ...ACCOUNT, id: 'a2', name: 'Current account', balance_as_of: null },
      { ...ACCOUNT, id: 'a3', name: 'Old account', balance_as_of: null, archived_at: '2026-01-01T00:00:00Z' },
    ];
    renderSummary({}, undefined, { accounts });
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(screen.getByText('Balances not entered: Savings and Current account. Every figure here counts them as 0.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Accounts' }).getAttribute('href')).toBe('/wealth?tab=accounts');
  });
});

describe('PlanSummary: what the stop year rests on', () => {
  it('calls a year nobody chose assumed, and whose 60th it is', () => {
    renderSummary();
    expect(within(card('Stop working')).getByText('2054 is assumed, the year Alex turns 60, until you choose a year on the Life plan.')).toBeTruthy();
  });

  it('says nothing is assumed once a year is saved', () => {
    renderSummary({ assumptions: { retirement_year: 2050 } });
    expect(within(card('Stop working')).queryByText(/is assumed/)).toBeNull();
  });

  it('is provisional while balances are not entered', () => {
    renderSummary({}, undefined, { accounts: [{ ...ACCOUNT, balance_as_of: null }] });
    expect(within(card('Stop working')).getByText('Provisional: 1 balance not entered, counted as 0.')).toBeTruthy();
  });

  it('names someone the plan leaves out', () => {
    renderSummary({ memberLife: AGES.slice(0, 1) });
    expect(within(card('Stop working')).getByText("Sam isn't in the plan: no birth year and age to plan to yet.")).toBeTruthy();
  });

  it('says the year is the household\'s in one partner\'s view', () => {
    renderSummary();
    expect(within(card('Stop working')).queryByText(/whoever is selected/)).toBeNull();
    localStorage.setItem('rokda.scope', 'partner');
    renderSummary();
    expect(screen.getAllByText("The household's year, whoever is selected.")).toHaveLength(1);
  });
});

// Planning audit, 1.2: once three months have ended the records take over, and
// the budget's answer stays beside them.
describe('PlanSummary: the budget beside the records', () => {
  const now = new Date();
  const categories = [
    { id: 'food', name: 'Groceries', kind: 'expense' },
    { id: 'save', name: 'Savings', kind: 'expense', is_savings: true },
  ];
  const budget = (category_id, amount) => ({ year: now.getFullYear(), month: now.getMonth() + 1, category_id, amount });

  it('gives the stop year on the budget\'s figures beside the recorded one', () => {
    renderSummary({}, undefined, { categories, budgets: [budget('food', 2000), budget('save', 8000)] });
    const recorded = Number(within(card('Stop working')).getByText(/^\d{4}$/).textContent);
    const line = within(card('Stop working')).getByText(/^On your budget's figures rather than the recorded months: \d{4}\.$/);
    // Spending less and saving more than recorded, the budget stops sooner.
    expect(Number(line.textContent.match(/\d{4}/)[0])).toBeLessThan(recorded);
  });

  it('says nothing more without a budget', () => {
    renderSummary();
    expect(within(card('Stop working')).queryByText(/On your budget/)).toBeNull();
  });
});

// Planning audit, 1.4: Plan always used avalanche, whatever was chosen.
describe('PlanSummary: the debt order chosen on Debt payoff', () => {
  it('projects the extra payment in that order', () => {
    const debts = [
      { ...LOAN, id: 'd1', name: 'Card', balance: 20000, apr_pct: 36, minimum_payment: 600 },
      { ...LOAN, id: 'd2', name: 'Loan', balance: 3000, apr_pct: 0, minimum_payment: 100 },
    ];
    const months = (order) => simulatePayoffPlan(orderDebts(debts, order), 300).months;
    // Snowball finishes later here, so the date says which order was used.
    expect(months('snowball')).toBeGreaterThan(months('avalanche'));
    renderSummary({ debts, assumptions: { debt_extra_payment: 300, debt_order: 'snowball' } });
    expect(within(card('Debt payoff')).getByText(`Clears about ${payoffMonthLabel(months('snowball'), new Date())} with the extra payment · not all in net worth`)).toBeTruthy();
  });
});

// Planning audit, 1.5: the goal checks are Goals' own rule.
describe('PlanSummary: goals that need a decision', () => {
  const soon = new Date(new Date().getFullYear(), new Date().getMonth() + 6, 1);
  const date = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-01`;

  it('names a goal due within 3 years that is short of cash', () => {
    const goal = { id: 'g1', name: 'Trip', target_amount: 12000, target_date: date, is_shared: true, created_at: '2026-01-01T00:00:00Z' };
    renderSummary({ goals: [goal] });
    expect(screen.getByText('Due within 3 years and short of cash, with no plan that covers it: Trip, 12,000 still to set aside (2,000 a month now).')).toBeTruthy();
  });

  // Planning audit, 2.7.
  it('raises a goal whose plan falls short, and not one whose plan covers it', () => {
    const goal = { id: 'g1', name: 'Trip', target_amount: 12000, target_date: date, is_shared: true, created_at: '2026-01-01T00:00:00Z' };
    renderSummary({ goals: [{ ...goal, planned_monthly: 1500 }] });
    expect(screen.getByText('Due within 3 years and short of cash, with no plan that covers it: Trip, 12,000 still to set aside (2,000 a month now, 1,500 planned).')).toBeTruthy();
    document.body.innerHTML = '';
    renderSummary({ goals: [{ ...goal, planned_monthly: 2000 }] });
    expect(screen.queryByText(/short of cash/)).toBeNull();
  });

  it('leaves a done goal out of the checks and the card', () => {
    const trip = { id: 'g1', name: 'Trip', target_amount: 12000, target_date: date, is_shared: true, created_at: '2026-01-01T00:00:00Z', done_at: '2026-01-02T00:00:00Z' };
    const house = { id: 'g2', name: 'House', target_amount: 900000, target_date: null, is_shared: true, created_at: '2026-01-01T00:00:00Z', done_at: '2026-01-02T00:00:00Z' };
    renderSummary({ goals: [trip, house] });
    expect(screen.queryByText(/short of cash/)).toBeNull();
    expect(screen.queryByText(/No date, so no plan pays/)).toBeNull();
    expect(within(card('Goals')).getByText('Every goal is done')).toBeTruthy();
  });

  it('leads the Goals card with the next 3 years in cash, and counts the rest by kind', () => {
    const trip = { id: 'g1', name: 'Trip', target_amount: 12000, target_date: date, is_shared: true, created_at: '2026-01-01T00:00:00Z' };
    const house = { id: 'g2', name: 'House', target_amount: 900000, target_date: null, is_shared: true, created_at: '2026-01-01T00:00:00Z' };
    renderSummary({ goals: [trip, house] });
    expect(within(card('Goals')).getByText('0')).toBeTruthy();
    expect(within(card('Goals')).getByText('of 12,000 in cash for the next 3 years · 1 with no date')).toBeTruthy();
  });

  it('names a goal with no date, which no plan pays for', () => {
    const goal = { id: 'g2', name: 'House', target_amount: 900000, target_date: null, is_shared: true, created_at: '2026-01-01T00:00:00Z' };
    renderSummary({ goals: [goal] });
    expect(screen.getByText('No date, so no plan pays for it: House (900,000).')).toBeTruthy();
  });
});
