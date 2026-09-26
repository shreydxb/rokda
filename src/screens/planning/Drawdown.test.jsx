import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import Drawdown from './Drawdown';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const ACCOUNT = { id: 'a1', type: 'savings', currency: 'AED', balance: 200000, balance_aed: 200000, is_shared: true, archived_at: null };

// Three closed months spending 4,000 on 10,000 of income: 48,000 a year.
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

function renderDrawdown(props = {}) {
  return renderScreen(
    <Drawdown household={{ id: 'h' }} accounts={[ACCOUNT]} transactions={history()} holdings={[]} data={{ assumptions: null }} loading={false} {...props} />,
  );
}

afterEach(() => localStorage.clear());

describe('Drawdown: how long the money lasts', () => {
  it('starts from the independence target, which at 4% and 3.4% real lasts 51 years', () => {
    renderDrawdown();
    expect(screen.getByText('51 years')).toBeTruthy();
    expect(screen.getByText(/Spending AED 48,000 a year from AED 1,200,000/)).toBeTruthy();
  });

  it('switches to what is held today', () => {
    renderDrawdown();
    fireEvent.click(screen.getByText(/Stopping today/));
    // 200,000 at 48,000 a year runs out in the fifth year.
    expect(screen.getByText('4 years')).toBeTruthy();
  });

  it('a lower return shortens it', () => {
    renderDrawdown();
    fireEvent.click(screen.getByLabelText('Lower return'));
    expect(screen.queryByText('51 years')).toBeNull();
  });

  it('says there is nothing to draw on when net worth is not above zero', () => {
    renderDrawdown({ accounts: [{ ...ACCOUNT, balance: 0, balance_aed: 0 }] });
    fireEvent.click(screen.getByText(/Stopping today/));
    expect(screen.getByText('Nothing to draw on')).toBeTruthy();
  });

  it('shows a way back to Forecast when there is not enough history', () => {
    renderDrawdown({ transactions: [] });
    expect(screen.getByText('Not enough to project')).toBeTruthy();
  });
});

describe('Drawdown: other income once working stops', () => {
  const RENT = { id: 'r1', name: 'Flat rent', kind: 'yearly', amount: 24000, starts_after_years: 0, lasts_years: null, note: '' };
  const GRATUITY = { id: 'g1', name: 'Gratuity', kind: 'lump_sum', amount: 90000, starts_after_years: 0, lasts_years: null, note: '' };

  it('lists each source and says when it pays', () => {
    renderDrawdown({ data: { assumptions: null, independenceIncome: [RENT, GRATUITY] } });
    expect(screen.getByText('Flat rent')).toBeTruthy();
    expect(screen.getByText(/From the first year, for good · lowers the target/)).toBeTruthy();
    expect(screen.getByText(/One-off, in the first year of independence/)).toBeTruthy();
  });

  it('lowers the target by lasting income, the same as Forecast', () => {
    // 48,000 spend less 24,000 of lasting rent, at 4%: 600,000.
    renderDrawdown({ data: { assumptions: null, independenceIncome: [RENT] } });
    expect(screen.getByText(/from AED 600,000/)).toBeTruthy();
  });

  it('makes today’s pot last longer', () => {
    renderDrawdown({ data: { assumptions: null, independenceIncome: [RENT] } });
    fireEvent.click(screen.getByText(/Stopping today/));
    // 200,000 paying 24,000 a year (48,000 less rent) lasts far past the 4 years it does alone.
    expect(screen.queryByText('4 years')).toBeNull();
  });

  it('offers to add one when there are none', () => {
    renderDrawdown();
    expect(screen.getByText(/None added/)).toBeTruthy();
    fireEvent.click(screen.getByText('+ Income'));
    expect(screen.getByRole('dialog', { name: 'Add income' })).toBeTruthy();
  });
});
