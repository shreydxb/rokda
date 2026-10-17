import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

// The review works out its checks from what is recorded; these check that the
// screen shows them, links each to where it is resolved, and joins a
// suggested transfer through the same database function the editor uses.
const rpcs = [];
const writes = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      rpcs.push({ name, args });
      return Promise.resolve({ error: null });
    },
    from: (table) => ({
      insert: (row) => {
        writes.push({ table, insert: row });
        return Promise.resolve({ error: null });
      },
      delete: () => ({
        eq: (column, value) => {
          writes.push({ table, delete: value });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  },
}));

const { default: Review } = await import('./Review');

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
// A day in the month just ended, which the review opens on.
const lastMonth = (day) => {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, day);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const thisMonthStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01T09:00:00Z`;

const account = (id, name, extra = {}) => ({ id, name, type: 'checking', created_at: '2020-01-01T00:00:00Z', archived_at: null, balance_as_of: thisMonthStamp, ...extra });
const tx = (id, extra = {}) => ({ id, account_id: 'current', amount: -100, kind: 'expense', category_id: 'groceries', is_split: false, needs_review: false, occurred_at: lastMonth(10), ...extra });

function data(overrides = {}) {
  return {
    accounts: [account('current', 'Current account'), account('card', 'Bank card')],
    transactions: [],
    statementReconciliations: [],
    netWorthSnapshots: [],
    budgets: [],
    categories: [],
    reload: vi.fn(),
    ...overrides,
  };
}

function renderReview(d) {
  return renderScreen(
    <MemoryRouter initialEntries={['/money?tab=review']}>
      <Review household={{ id: 'hh' }} data={d} loading={false} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  rpcs.length = 0;
  writes.length = 0;
});

describe('Review', () => {
  it('shows what is left and links each check to where it is done', () => {
    renderReview(
      data({
        transactions: [tx('flagged', { needs_review: true }), tx('bare', { category_id: null })],
        accounts: [account('current', 'Current account', { balance_as_of: null })],
      }),
    );
    expect(screen.getByText('1 of 5 done')).toBeTruthy();
    const flagged = screen.getByTestId('review-review');
    expect(within(flagged).getByText('1 record still marked for review.')).toBeTruthy();
    expect(within(flagged).getByRole('link', { name: 'Open the records' }).getAttribute('href')).toMatch(/^\/money\?tab=activity&who=both&review=1&from=/);
    expect(within(screen.getByTestId('review-categorise')).getByRole('link').getAttribute('href')).toMatch(/cat=none/);
    expect(within(screen.getByTestId('review-balances')).getByText(/Current account/)).toBeTruthy();
    expect(within(screen.getByTestId('review-close')).getByRole('link', { name: 'Close the month' }).getAttribute('href')).toBe('/wealth');
  });

  it('says so once the month is reviewed and closed', () => {
    const snapshot = `${lastMonth(1)}`;
    renderReview(data({ transactions: [tx('fine')], netWorthSnapshots: [{ snapshot_date: snapshot }] }));
    expect(screen.getByText(/is reviewed and closed\./)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open the records' })).toBeNull();
  });

  it('joins a suggested pair into one transfer', async () => {
    const d = data({
      transactions: [tx('out', { amount: -500, category_id: null }), tx('in', { account_id: 'card', amount: 500, kind: 'income', category_id: null, occurred_at: lastMonth(11) })],
    });
    renderReview(d);
    const check = screen.getByTestId('review-transfers');
    expect(within(check).getByText(/from Current account .* to Bank card/)).toBeTruthy();
    await act(async () => fireEvent.click(within(check).getByRole('button', { name: 'Make one transfer' })));
    expect(rpcs).toEqual([{ name: 'link_transfer', args: { p_out_transaction_id: 'out', p_in_transaction_id: 'in' } }]);
    expect(d.reload).toHaveBeenCalled();
  });

  it('remembers a pair as two real records, or deletes the later one after asking', async () => {
    const pair = [tx('a', { merchant: 'Cafe', created_at: '2026-01-01T08:00:00Z' }), tx('b', { merchant: 'Cafe', created_at: '2026-01-02T08:00:00Z' })];
    const d = data({ transactions: pair });
    renderReview(d);
    const check = screen.getByTestId('review-duplicates');
    await act(async () => fireEvent.click(within(check).getByRole('button', { name: 'Both are real' })));
    expect(writes).toEqual([{ table: 'transaction_links', insert: { household_id: 'hh', kind: 'duplicate_confirmed', from_transaction_id: 'a', to_transaction_id: 'b' } }]);
    expect(d.reload).toHaveBeenCalled();

    writes.length = 0;
    fireEvent.click(within(check).getByRole('button', { name: 'Delete one' }));
    expect(writes).toEqual([]);
    await act(async () => fireEvent.click(within(check).getByRole('button', { name: /^Delete the .* one\?$/ })));
    expect(writes).toEqual([{ table: 'transactions', delete: 'b' }]);
  });

  it('steps back a month, and not forward past the month just ended', () => {
    renderReview(data());
    expect(screen.getByRole('button', { name: 'Next →' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '← Prev' }));
    const before = new Date(now.getFullYear(), now.getMonth() - 2, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    expect(screen.getByRole('heading', { name: before })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next →' }).disabled).toBe(false);
  });
});
