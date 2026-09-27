import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import PlanSummary from './PlanSummary';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const ACCOUNT = { id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null };
const MEMBERS = [
  { id: 'm1', display_name: 'Shreyash' },
  { id: 'm2', display_name: 'Tarika' },
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

function renderSummary(data = {}) {
  const onOpenTab = vi.fn();
  renderScreen(
    <PlanSummary
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
  return { onOpenTab };
}

describe('PlanSummary: when work can stop', () => {
  it('gives the Life plan year once ages are set, and opens the Life plan', () => {
    const { onOpenTab } = renderSummary();
    expect(screen.queryByText('Independence')).toBeNull();
    expect(screen.getByText('Stop working')).toBeTruthy();
    expect(screen.getByText(/^Shreyash \d+ · Tarika \d+ · the money lasts to 2079$/)).toBeTruthy();
    fireEvent.click(screen.getByText('Life plan →'));
    expect(onOpenTab).toHaveBeenCalledWith('life');
  });

  it('says when the saved stop year does not last', () => {
    renderSummary({ assumptions: { retirement_year: new Date().getFullYear() + 1, retirement_annual_spend: 150000 } });
    expect(screen.getByText(/· not by your plan's \d{4}$/)).toBeTruthy();
  });

  it('falls back to the independence year while no ages are set', () => {
    const { onOpenTab } = renderSummary({ memberLife: [] });
    expect(screen.getByText('Independence')).toBeTruthy();
    fireEvent.click(screen.getByText('Forecast →'));
    expect(onOpenTab).toHaveBeenCalledWith('forecast');
  });
});
