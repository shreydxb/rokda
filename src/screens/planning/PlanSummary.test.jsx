import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import PlanSummary from './PlanSummary';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const ACCOUNT = { id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null };
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

function renderSummary(data = {}, sources) {
  const onOpenTab = vi.fn();
  const onRetry = vi.fn();
  renderScreen(
    <PlanSummary
      sources={sources}
      onRetry={onRetry}
      members={MEMBERS}
      me={MEMBERS[0]}
      accounts={[ACCOUNT]}
      transactions={history()}
      holdings={[]}
      data={{ goals: [], goalContributions: [], goalAllocations: [], debts: [], assumptions: null, independenceIncome: [], memberLife: AGES, ...data }}
      loading={false}
      onOpenTab={onOpenTab}
    />,
  );
  return { onOpenTab, onRetry };
}

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
    expect(screen.getByText('Couldn’t load goals. No year is worked out without them.')).toBeTruthy();
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
    const debt = { id: 'd1', name: 'Car loan', note: '', balance: 40000, apr_pct: 3.5, minimum_payment: 2193, is_shared: true, account_id: null };
    renderSummary({ debts: [debt], memberLife: [] }, { errors: { memberLife: { message: 'canceling statement due to statement timeout' } }, loaded: { household: true, debts: true, assumptions: true } });
    expect(screen.getByText('1 open · not all checked')).toBeTruthy();
    expect(screen.getByText('No committed extra payment set, so debt has no payoff date')).toBeTruthy();
    expect(screen.getByText('Couldn’t load ages for the life plan. What rests on them isn’t checked.')).toBeTruthy();
  });
});
