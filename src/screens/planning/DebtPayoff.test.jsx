import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import DebtPayoff from './DebtPayoff';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const LOAN = { id: 'loan', name: 'Car loan', type: 'loan', currency: 'AED', balance: 38000, balance_aed: 38000, is_shared: true, archived_at: null };
const debt = (over) => ({ id: 'd1', name: 'Car loan', note: '', balance: 40000, apr_pct: 3.5, minimum_payment: 2193, is_shared: true, account_id: 'loan', ...over });

function renderPayoff(debts) {
  renderScreen(<DebtPayoff household={{ id: 'h' }} members={[]} me={null} accounts={[LOAN]} data={{ debts, assumptions: null, reload: vi.fn() }} loading={false} />);
}

describe('DebtPayoff: debts and their accounts', () => {
  it('shows a linked debt at its account\'s balance, the one net worth counts', () => {
    renderPayoff([debt()]);
    expect(screen.getByText(/outstanding$/).textContent).toBe('38,000 outstanding');
    expect(document.querySelector('.debt-unlinked')).toBeNull();
    expect(screen.queryByText(/not in net worth/)).toBeNull();
  });

  it('says a debt with no account is not in net worth', () => {
    renderPayoff([debt({ account_id: null, name: 'Personal loan' })]);
    expect(screen.getByText('No account: not in net worth')).toBeTruthy();
    expect(document.querySelector('.debt-unlinked').textContent).toMatch(/^Personal loan is not in net worth\. Open it and link a loan/);
  });
});

// Each debt once ended in three bare numbers, the last of them the minimum
// payment with nothing to say so (layout audit, 21 Oct).
describe('DebtPayoff: figures and what a projection needs', () => {
  it('labels what is owed, the rate and the minimum', () => {
    renderPayoff([debt()]);
    const figures = [...document.querySelectorAll('.debt-figures > div')].map((d) => d.textContent);
    expect(figures).toEqual(['Owed−38,000', 'Rate3.5% a year', 'Minimum2,193 a month']);
  });

  it('names the one thing still missing for a payoff date', () => {
    renderScreen(<DebtPayoff household={{ id: 'h' }} members={[]} me={null} accounts={[LOAN]} data={{ debts: [debt()], assumptions: { debt_extra_payment: 0, debt_assume_no_new_card_spend: true }, reload: vi.fn() }} loading={false} />);
    expect(screen.getByText(/A committed extra payment is not set, so no date is shown/)).toBeTruthy();
    expect(screen.getByText('0 a month').className).toBe('ov-chip-warn');
  });
});
