import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import { amortizeMinimumOnly, payoffMonthLabel } from '../../lib/debt';
import DebtPayoff from './DebtPayoff';

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

const LOAN = { id: 'loan', name: 'Car loan', type: 'loan', currency: 'AED', balance: 38000, balance_aed: 38000, is_shared: true, archived_at: null };
const debt = (over) => ({ id: 'd1', name: 'Car loan', note: '', balance: 40000, apr_pct: 3.5, minimum_payment: 2193, is_shared: true, account_id: 'loan', ...over });
const now = new Date();
const atMinimum = (balance, apr, minimum) => payoffMonthLabel(amortizeMinimumOnly(balance, apr, minimum), now);

function renderPayoff(debts, { assumptions = null, sources, accounts = [LOAN], reload = vi.fn() } = {}) {
  renderScreen(<DebtPayoff household={{ id: 'h' }} members={[{ id: 'm1' }]} me={{ id: 'm1' }} accounts={accounts} data={{ debts, assumptions, reload }} sources={sources} loading={false} />);
  return { reload };
}

beforeEach(() => {
  calls.upserts.length = 0;
});
afterEach(() => localStorage.clear());

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

// Planning audit, 1.4: no date showed until an extra payment and a card-usage
// answer were entered, though every loan clears on its own minimum.
describe('DebtPayoff: the date the debts are on', () => {
  it('leads with the date at the minimum and the interest still to pay', () => {
    renderPayoff([debt()]);
    expect(document.querySelector('.debt-lead-date').textContent).toBe(`Clears about ${atMinimum(38000, 3.5, 2193)} at the minimum payment`);
    expect(document.querySelector('.debt-lead .ov-muted').textContent).toMatch(/^AED [\d,]+ of interest still to pay, paying only the minimums\.$/);
  });

  it('labels what is owed, the rate, the minimum and when each debt clears', () => {
    renderPayoff([debt()]);
    const figures = [...document.querySelectorAll('.debt-figures > div')].map((d) => d.textContent);
    expect(figures).toEqual(['Owed−38,000', 'Rate3.5% a year', 'Minimum2,193 a month', `Clears${atMinimum(38000, 3.5, 2193)}`]);
  });

  it('names debts with a 0 rate or minimum for checking, since the dates rest on them', () => {
    renderPayoff([debt(), debt({ id: 'd2', name: 'Card', account_id: null, apr_pct: 0, minimum_payment: 0, balance: 500 })]);
    expect(document.querySelector('.debt-check').textContent).toMatch(/^Check the rate and minimum on Card: a 0 is real for some loans/);
    const card = [...document.querySelectorAll('.debt-row')].find((r) => r.textContent.includes('Card'));
    expect(within(card).getByText('Never')).toBeTruthy();
  });
});

describe('DebtPayoff: an extra payment, as a what-if', () => {
  it('offers one when none is set, with the rule beside it', () => {
    renderPayoff([debt()]);
    expect(screen.getByText('No extra payment set')).toBeTruthy();
    expect(screen.getByText(/fill the cash reserve before paying extra on a loan at a low rate/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try an extra payment' })).toBeTruthy();
  });

  it('gives its date and interest against the minimums once one is set', () => {
    renderPayoff([debt()], { assumptions: { debt_extra_payment: 2000 } });
    expect(screen.getByText(/^With 2,000 extra a month: clears about \w{3} \d{4}$/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`^Against ${atMinimum(38000, 3.5, 2193)} at the minimums\\. Interest along the way: [\\d,]+, against [\\d,]+\\.`))).toBeTruthy();
  });

  it('is the household\'s: one partner\'s view sends you to Both', () => {
    localStorage.setItem('rokda.scope', 'me');
    renderPayoff([debt()], { assumptions: { debt_extra_payment: 2000 } });
    expect(screen.getByText(/An extra payment is the household’s, not a per-person number/)).toBeTruthy();
    // The date at the minimum still shows.
    expect(document.querySelector('.debt-lead-date').textContent).toMatch(/^Clears about/);
  });
});

describe('DebtPayoff: the payoff order', () => {
  const two = [debt(), debt({ id: 'd2', name: 'Bank card', account_id: null, balance: 3000, apr_pct: 30, minimum_payment: 300 })];

  it('is not offered while one debt is owed, since it changes nothing', () => {
    renderPayoff([debt()]);
    expect(screen.queryByRole('group', { name: 'Payoff order' })).toBeNull();
  });

  it('offers avalanche and snowball, not a custom order nothing can set', () => {
    renderPayoff(two);
    const order = screen.getByRole('group', { name: 'Payoff order' });
    expect(within(order).getAllByRole('button').map((b) => b.textContent)).toEqual(['Avalanche', 'Snowball']);
  });

  it('saves the order chosen, for both partners and for Plan', async () => {
    const { reload } = renderPayoff(two);
    fireEvent.click(screen.getByRole('button', { name: 'Snowball' }));
    expect(screen.getByRole('button', { name: 'Snowball' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.upserts).toEqual([{ table: 'planning_assumptions', row: expect.objectContaining({ household_id: 'h', debt_order: 'snowball' }), options: { onConflict: 'household_id' } }]);
  });

  it('opens on the order saved', () => {
    renderPayoff(two, { assumptions: { debt_order: 'snowball' } });
    expect(screen.getByRole('button', { name: 'Snowball' }).getAttribute('aria-pressed')).toBe('true');
    expect([...document.querySelectorAll('.debt-name')].map((n) => n.textContent)).toEqual(['Bank card', 'Car loan']);
  });
});

describe('DebtPayoff: a card in credit', () => {
  it('says it is in credit rather than owing what it holds', () => {
    const card = { id: 'card', name: 'Bank card', type: 'credit_card', currency: 'AED', balance: -1500, balance_aed: -1500, is_shared: true, archived_at: null };
    renderPayoff([debt({ name: 'Bank card', account_id: 'card' })], { accounts: [card] });
    const figures = [...document.querySelectorAll('.debt-figures > div')].map((d) => d.textContent);
    expect(figures[0]).toBe('OwedIn credit');
    expect(figures[3]).toBe('Clears—');
    expect(screen.getByText(/outstanding$/).textContent).toBe('0 outstanding');
    // Paying the minimum on nothing owed is not "clears in 1 mo".
    expect(document.querySelector('.debt-lead-date').textContent).toBe('Nothing owed');
  });
});

describe('DebtPayoff: debts that never loaded', () => {
  it('says so, rather than showing no debts', () => {
    renderPayoff([], { sources: { errors: { debts: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.getByText('Couldn’t load debts.')).toBeTruthy();
    expect(screen.queryByText('No debts')).toBeNull();
  });

  it('with only the assumptions unread, dates the debts but leaves out the what-if, and no editor to save over it', () => {
    renderPayoff([debt()], { sources: { errors: { assumptions: { message: 'canceling statement due to statement timeout' } }, loaded: {} } });
    expect(screen.getByText('Car loan')).toBeTruthy();
    expect(document.querySelector('.debt-lead-date').textContent).toMatch(/^Clears about/);
    expect(screen.getByText(/^Couldn’t load planning assumptions\. The extra payment and the order you chose aren’t shown\.$/)).toBeTruthy();
    expect(screen.queryByText('Try an extra payment')).toBeNull();
  });
});
