import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/dom';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { startingNetWorth } from '../overviewMath';
import Forecast from './Forecast';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const ACCOUNT = { id: 'a1', name: 'ADCB', type: 'savings', balance: 50_000, is_shared: true, archived_at: null };
const HOLDING = { id: 'h1', name: 'VWRA', asset_class: 'equity', value_aed: 20_000, is_shared: true, priced_at: '2026-06-01T00:00:00Z' };

// Three closed months of spend, which is what a forecast needs before it will
// project anything at all.
function closedMonthTransactions(now) {
  return [1, 2, 3].map((back, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 15);
    return {
      id: `t${i}`,
      amount: -1000,
      occurred_at: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`,
      is_shared: true,
    };
  });
}

function renderForecast(props) {
  return renderScreen(
    <MemoryRouter>
      <Forecast household={{ id: 'h' }} data={{ assumptions: null }} loading={false} {...props} />
    </MemoryRouter>,
  );
}

// QA-03 / SHR-244: Planning passed usePlanningData() as `data`, and Forecast
// read `data.holdings` — a field that hook never had. With no accounts this
// threw; with accounts it silently dropped holdings from net worth.
describe('QA-03: Forecast net-worth basis', () => {
  it('counts holdings as well as accounts', () => {
    expect(startingNetWorth([ACCOUNT], [HOLDING])).toBe(70_000);
  });

  it('works from holdings alone', () => {
    expect(startingNetWorth([], [HOLDING])).toBe(20_000);
  });

  it('works from accounts alone', () => {
    expect(startingNetWorth([ACCOUNT], [])).toBe(50_000);
  });

  it('still projects from a balance nobody has confirmed, and Forecast says it is provisional', () => {
    // QA pass 3, O4. An unconfirmed balance is unknown in the strict sense,
    // but withholding the whole projection would disagree with Overview, which
    // shows net worth over the same doubt and labels it. Shown and labelled,
    // not withheld.
    expect(startingNetWorth([ACCOUNT], [])).toBe(50_000);
  });

  it('refuses a foreign balance nobody has converted, which is unknown rather than unconfirmed', () => {
    // Different kind of doubt: not "is this figure current" but "what is this
    // figure, in dirhams". There is no number to label provisional (O3).
    const inr = { id: 'i1', type: 'savings', currency: 'INR', balance: 10_000, balance_aed: null, is_shared: true, archived_at: null };
    expect(startingNetWorth([inr], [])).toBeNull();
  });

  it('reports "nothing to start from" as null, not a confident zero', () => {
    expect(startingNetWorth([], [])).toBeNull();
  });

  it('ignores closed accounts, matching Overview and Wealth', () => {
    expect(startingNetWorth([{ ...ACCOUNT, archived_at: '2026-09-05T00:00:00Z' }], [HOLDING])).toBe(20_000);
  });
});

describe('QA-03: Forecast renders every input state', () => {
  const now = new Date();

  it('renders the loading state', () => {
    renderForecast({ accounts: [], transactions: [], holdings: [], loading: true });
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('renders with no accounts and no holdings instead of throwing', () => {
    // This is the exact case that threw "Cannot read properties of undefined
    // (reading 'length')" at 9bd6a59.
    renderForecast({ accounts: [], transactions: [], holdings: [] });
    expect(screen.getByText(/Not enough to project/i)).toBeTruthy();
    expect(screen.getByText(/needs one account valuation/i)).toBeTruthy();
  });

  it('renders holdings-only', () => {
    renderForecast({ accounts: [], transactions: [], holdings: [HOLDING] });
    // A valuation exists, so only the spend history is still missing.
    expect(screen.getByText(/needs three closed months/i)).toBeTruthy();
  });

  it('renders accounts plus holdings with enough history to project', () => {
    renderForecast({ accounts: [ACCOUNT], transactions: closedMonthTransactions(now), holdings: [HOLDING] });
    expect(screen.queryByText(/Not enough to project/i)).toBeNull();
  });

  it('marks the projection provisional while a contributing balance is unconfirmed', () => {
    // ACCOUNT has no balance_as_of, so the figure is the best available
    // picture rather than a settled one, and the screen has to say so.
    renderForecast({ accounts: [ACCOUNT], transactions: closedMonthTransactions(now), holdings: [HOLDING] });
    expect(screen.getByText(/provisional/i)).toBeTruthy();
  });

  it('drops the provisional note once the balance is confirmed', () => {
    const confirmed = { ...ACCOUNT, balance_as_of: '2026-09-01T00:00:00Z' };
    renderForecast({ accounts: [confirmed], transactions: closedMonthTransactions(now), holdings: [HOLDING] });
    expect(screen.queryByText(/provisional/i)).toBeNull();
  });

  // QA #4: the reproduction from that review. A confirmed foreign loan with
  // no AED conversion is skipped by startingNetWorth, and every existing check
  // on this screen passed -- the basis was not null, and nothing was
  // unconfirmed -- so a projection ran from a net worth with a debt missing
  // from it and said nothing.
  it('says the basis is incomplete when an account has no AED conversion', () => {
    const confirmed = { ...ACCOUNT, balance_as_of: '2026-09-01T00:00:00Z', balance_aed: 50_000, currency: 'AED' };
    const foreignLoan = {
      id: 'l1',
      name: 'India home loan',
      type: 'loan',
      currency: 'INR',
      balance: 500_000,
      balance_aed: null,
      balance_as_of: '2026-09-01T00:00:00Z',
      is_shared: true,
      archived_at: null,
    };
    renderForecast({ accounts: [confirmed, foreignLoan], transactions: closedMonthTransactions(now), holdings: [HOLDING] });
    expect(screen.getByText(/no AED conversion/i)).toBeTruthy();
    // And it is not merely relabelling the old warning: nothing here is
    // unconfirmed, so "provisional" would never have fired.
    expect(screen.queryByText(/balances not confirmed/i)).toBeNull();
  });

  it('drops the incomplete note once the conversion exists', () => {
    const confirmed = { ...ACCOUNT, balance_as_of: '2026-09-01T00:00:00Z', balance_aed: 50_000, currency: 'AED' };
    const converted = {
      id: 'l1',
      name: 'India home loan',
      type: 'loan',
      currency: 'INR',
      balance: 500_000,
      balance_aed: 21_000,
      balance_as_of: '2026-09-01T00:00:00Z',
      is_shared: true,
      archived_at: null,
    };
    renderForecast({ accounts: [confirmed, converted], transactions: closedMonthTransactions(now), holdings: [HOLDING] });
    expect(screen.queryByText(/no AED conversion/i)).toBeNull();
  });
});

describe('Forecast scenario picker', () => {
  const now = new Date();

  it('offers Baseline, Conservative, Optimistic and Custom, defaulting to Baseline', () => {
    renderForecast({
      accounts: [ACCOUNT],
      transactions: closedMonthTransactions(now),
      holdings: [HOLDING],
      data: { assumptions: { nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4 } },
    });
    for (const label of ['Baseline', 'Conservative', 'Optimistic', 'Custom']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Baseline' }).dataset.active).toBe('true');
  });

  it('switching to Conservative lowers the assumed return shown on the page', () => {
    renderForecast({
      accounts: [ACCOUNT],
      transactions: closedMonthTransactions(now),
      holdings: [HOLDING],
      data: { assumptions: { nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4 } },
    });
    expect(screen.getByText('6.0% nominal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Conservative' }));
    expect(screen.getByRole('button', { name: 'Conservative' }).dataset.active).toBe('true');
    expect(screen.getByText('4.0% nominal')).toBeTruthy();
  });

  it('Custom reads "not set" until it has its own saved assumptions', () => {
    renderForecast({
      accounts: [ACCOUNT],
      transactions: closedMonthTransactions(now),
      holdings: [HOLDING],
      data: { assumptions: { nominal_return_pct: 6, inflation_pct: 2.5, safe_withdrawal_pct: 4 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.getByText(/not set yet/i)).toBeTruthy();
  });
});
