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
