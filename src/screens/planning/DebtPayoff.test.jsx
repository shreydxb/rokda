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
