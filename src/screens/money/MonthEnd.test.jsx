import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

// Month end (the revamp, phase 4d; design/prototype meRunning, meSteps,
// meClosed). The checks and figures are lib/monthEnd.js's; these check that
// each page shows them and that its actions write what they should. The
// client is mocked so each write can be seen.
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
      upsert: (row) => ({
        select: () => {
          writes.push({ table, upsert: row });
          return Promise.resolve({ data: [row], error: null });
        },
      }),
      delete: () => ({
        eq: (column, value) => {
          writes.push({ table, delete: value });
          return Promise.resolve({ error: null });
        },
      }),
      update: (payload) => ({
        eq: (column, value) => ({
          is: () => ({
            select: () => {
              writes.push({ table, update: payload, id: value });
              return Promise.resolve({ data: [{ id: value }], error: null });
            },
          }),
          select: () => {
            writes.push({ table, update: payload, id: value });
            return Promise.resolve({ data: [{ id: value }], error: null });
          },
        }),
      }),
    }),
  },
}));

const { default: MonthEnd } = await import('./MonthEnd');

const ME = { id: 'm1', display_name: 'Alex' };
const account = (id, name, extra = {}) => ({ id, name, type: 'checking', created_at: '2026-01-01T00:00:00Z', archived_at: null, is_shared: true, currency: 'AED', balance: 5000, balance_as_of: '2026-11-02T09:00:00Z', ...extra });
const CURRENT = account('current', 'Current account');
const CARD = account('card', 'Bank card', { type: 'credit_card', statement_day: 28, due_day: 22, balance: 1000 });
const tx = (id, extra = {}) => ({ id, account_id: 'current', amount: -100, kind: 'expense', category_id: 'groceries', is_split: false, needs_review: false, is_shared: true, occurred_at: '2026-10-10', merchant: 'Shop', ...extra });
const confirmed = (date) => ({ id: `r-${date}`, account_id: 'card', statement_date: date, status: 'confirmed' });
// The card's statements before October's, all checked.
const OLDER = ['2026-09-28', '2026-08-28', '2026-07-28', '2026-06-28', '2026-05-28'].map(confirmed);
const categories = [
  { id: 'groceries', name: 'Groceries', kind: 'expense', parent_id: null },
  { id: 'salary', name: 'Salary', kind: 'income', parent_id: null },
];

function data(overrides = {}) {
  return {
    accounts: [CURRENT, CARD],
    transactions: [tx('a')],
    statementReconciliations: [...OLDER, confirmed('2026-10-28')],
    netWorthSnapshots: [],
    budgets: [],
    categories,
    holdings: [],
    transactionLinks: [],
    reload: vi.fn(async () => {}),
    ...overrides,
  };
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderAt(entry, d) {
  return renderScreen(
    <MemoryRouter initialEntries={[entry]}>
      <Where />
      <MonthEnd household={{ id: 'hh' }} members={[ME]} me={ME} data={d} loading={false} />
    </MemoryRouter>,
  );
}
const OCTOBER = '/money?tab=monthend&month=2026-10';
const kpi = (label) => screen.getByText(label, { selector: 'dt' }).closest('.ds-kpi');
const stepButton = (title) => screen.getAllByRole('button').find((b) => b.querySelector('.me-step-t')?.textContent === title);
async function click(el) {
  await act(async () => {
    fireEvent.click(el);
  });
}

beforeEach(() => {
  rpcs.length = 0;
  writes.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T12:00:00'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Month end: the running month', () => {
  it('shows its strip, the statements still open, and the month just ended to close', () => {
    renderAt(
      '/money?tab=monthend',
      data({
        accounts: [CURRENT, CARD, account('savings', 'Savings', { balance_as_of: null })],
        transactions: [tx('n1', { category_id: null, occurred_at: '2026-11-03' })],
        statementReconciliations: OLDER,
      }),
    );
    expect(screen.getByRole('heading', { name: 'November is still running' })).toBeTruthy();
    expect(screen.getByText('Closes after 30 Nov')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Close October' }).getAttribute('href')).toBe('/money?tab=monthend&month=2026-10');
    expect(within(kpi('Uncategorised so far')).getByText('1')).toBeTruthy();
    const categorise = within(kpi('Uncategorised so far')).getByRole('link', { name: 'Categorise →' }).getAttribute('href');
    expect(categorise).toMatch(/cat=none/);
    expect(categorise).toMatch(/from=2026-11-01&to=2026-11-30/);
    expect(within(kpi('Statements to check')).getByText('1')).toBeTruthy();
    expect(within(kpi('Balances not confirmed')).getByText('1')).toBeTruthy();
    expect(within(kpi('Balances not confirmed')).getByRole('link', { name: 'Accounts →' }).getAttribute('href')).toBe('/wealth?tab=accounts');
    const statements = screen.getByRole('region', { name: 'Card statements' });
    const row = within(statements).getByText('29 Sep – 28 Oct').closest('tr');
    expect(within(row).getByRole('button', { name: 'Mark done' })).toBeTruthy();
  });

  it('offers no close once the month just ended is closed, and says what is clear', () => {
    renderAt('/money?tab=monthend', data({ netWorthSnapshots: [{ snapshot_date: '2026-10-01', assets: 1, liabilities: 0 }] }));
    expect(screen.queryByRole('link', { name: 'Close October' })).toBeNull();
    expect(within(kpi('Uncategorised so far')).getByText('All clear')).toBeTruthy();
    expect(within(kpi('Statements to check')).getByText('All clear')).toBeTruthy();
    expect(screen.getByText('Every statement here has been checked.')).toBeTruthy();
  });

  it('says one statement doesn’t match', () => {
    renderAt('/money?tab=monthend', data({ statementReconciliations: [...OLDER, { id: 'm', account_id: 'card', statement_date: '2026-10-28', status: 'mismatch', statement_spend: 5 }] }));
    expect(within(kpi('Statements to check')).getByText('1 doesn’t match')).toBeTruthy();
  });

  it('says how to start when no card has a statement day', () => {
    renderAt('/money?tab=monthend', data({ accounts: [CURRENT, { ...CARD, statement_day: null }] }));
    expect(screen.getByText('No card statements yet')).toBeTruthy();
  });

  // Round 2 of the outside review, E2-3: a statement is not checked against
  // records that never loaded.
  it('shows nothing worked out from records that never loaded, and offers to try again', () => {
    const d = data({ transactions: [], errors: { transactions: 'network' }, loaded: {} });
    renderAt('/money?tab=monthend', d);
    expect(screen.getByText('Couldn’t load transactions.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Card statements' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(d.reload).toHaveBeenCalled();
  });

  it('steps back through the months, and not past the running one', async () => {
    renderAt('/money?tab=monthend', data());
    expect(screen.getByRole('button', { name: 'Next month' }).disabled).toBe(true);
    await click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByTestId('where').textContent).toBe('/money?tab=monthend&month=2026-10');
    expect(screen.getByRole('heading', { name: 'Close October' })).toBeTruthy();
  });
});

describe('Month end: closing the month just ended', () => {
  it('opens on the first step still open, and says how many of the three are done', () => {
    renderAt(OCTOBER, data({ transactions: [tx('bare', { category_id: null })] }));
    expect(screen.getByRole('heading', { name: 'Close October' })).toBeTruthy();
    expect(screen.getByText('1 of 3 steps done')).toBeTruthy();
    expect(screen.getByText('Household')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Budget for Oct →' }).getAttribute('href')).toBe('/money?tab=budget&month=2026-10');
    expect(stepButton('Tidy transactions').getAttribute('aria-expanded')).toBe('true');
    expect(stepButton('Tidy transactions').textContent).toMatch(/1 uncategorised/);
    expect(stepButton('Check statements and balances').getAttribute('aria-expanded')).toBe('false');
    expect(stepButton('Check statements and balances').textContent).toMatch(/All clear/);
    expect(stepButton('Close').textContent).toMatch(/Puts October into history/);
    expect(screen.getByText('Uncategorised · 1')).toBeTruthy();
    // The checks that are clear fold away, with a tick each.
    const fold = screen.getByText('Nothing to do (4)').closest('details');
    expect(within(fold).getByText('Flagged records')).toBeTruthy();
    expect(within(fold).getByText('Possible duplicates')).toBeTruthy();
  });

  it('files a record with no category from the step', async () => {
    const d = data({ transactions: [tx('bare', { category_id: null })] });
    renderAt(OCTOBER, d);
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Category for Shop' }), { target: { value: 'groceries' } });
    });
    expect(writes[0]).toEqual({ table: 'transactions', update: { category_id: 'groceries' }, id: 'bare' });
    expect(writes[1]).toMatchObject({ table: 'transaction_edits' });
    expect(d.reload).toHaveBeenCalled();
  });

  it('keeps both of a possible duplicate, or deletes the later one after asking', async () => {
    const pair = [tx('a', { merchant: 'Cafe', created_at: '2026-10-10T08:00:00Z' }), tx('b', { merchant: 'Cafe', occurred_at: '2026-10-11', created_at: '2026-10-11T08:00:00Z' })];
    const d = data({ transactions: pair });
    renderAt(OCTOBER, d);
    expect(screen.getByText('Possible duplicates · 1')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Both are real' }));
    expect(writes).toEqual([{ table: 'transaction_links', insert: { household_id: 'hh', kind: 'duplicate_confirmed', from_transaction_id: 'a', to_transaction_id: 'b' } }]);
    expect(d.reload).toHaveBeenCalled();
    writes.length = 0;
    await click(screen.getByRole('button', { name: 'Delete one' }));
    expect(writes).toEqual([]);
    await click(screen.getByRole('button', { name: 'Delete the 11 Oct one?' }));
    expect(writes).toEqual([{ table: 'transactions', delete: 'b' }]);
  });

  it('joins a suggested pair into one transfer', async () => {
    const d = data({ transactions: [tx('out', { amount: -500, category_id: null }), tx('in', { account_id: 'card', amount: 500, kind: 'income', category_id: null, occurred_at: '2026-10-11' })] });
    renderAt(OCTOBER, d);
    expect(screen.getByText(/from Current account .* to Bank card/)).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Make one transfer' }));
    expect(rpcs).toEqual([{ name: 'link_transfer', args: { p_out_transaction_id: 'out', p_in_transaction_id: 'in' } }]);
    expect(d.reload).toHaveBeenCalled();
  });

  it('links flagged records and refunds to where they are done, with the way back', () => {
    renderAt(OCTOBER, data({ transactions: [tx('f', { needs_review: true }), tx('r', { kind: 'refund', amount: 40 })] }));
    const flagged = screen.getByText('Flagged · 1').nextElementSibling;
    const href = within(flagged).getByRole('link', { name: 'Open the records' }).getAttribute('href');
    expect(href).toMatch(/review=1/);
    expect(href).toMatch(/reviewing=2026-10$/);
    const refunds = screen.getByText('Refunds · 1').nextElementSibling;
    expect(within(refunds).getByRole('link', { name: 'Open the records' }).getAttribute('href')).toMatch(/kind=refund/);
  });

  it('checks the statements that closed in the month and the balances not confirmed since', async () => {
    renderAt(OCTOBER, data({ accounts: [account('current', 'Current account', { balance_as_of: '2026-10-02T09:00:00Z' }), CARD], statementReconciliations: OLDER }));
    const step = stepButton('Check statements and balances');
    expect(step.textContent).toMatch(/1 statement to check · 1 balance not confirmed/);
    expect(step.getAttribute('aria-expanded')).toBe('true');
    const row = screen.getByText('29 Sep – 28 Oct').closest('tr');
    expect(within(row).getByText('To check')).toBeTruthy();
    const balance = screen.getByText('Current account', { selector: '.me-rw-t' }).closest('.me-rw');
    expect(within(balance).getByRole('link', { name: 'Confirm balance' }).getAttribute('href')).toBe('/wealth?tab=accounts&reviewing=2026-10');
    // Ticking a statement offers to mark it done beside the step's name.
    await click(within(row).getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Mark 1 done' }).closest('.me-step-h')).not.toBeNull();
  });

  it('opens the step a link names', () => {
    renderAt(`${OCTOBER}&step=2`, data({ transactions: [tx('bare', { category_id: null })] }));
    expect(stepButton('Tidy transactions').getAttribute('aria-expanded')).toBe('false');
    expect(stepButton('Check statements and balances').getAttribute('aria-expanded')).toBe('true');
  });

  it('opens another step on a click, and closes it on another', async () => {
    renderAt(OCTOBER, data({ transactions: [tx('bare', { category_id: null })] }));
    await click(stepButton('Close'));
    expect(stepButton('Close').getAttribute('aria-expanded')).toBe('true');
    expect(stepButton('Tidy transactions').getAttribute('aria-expanded')).toBe('false');
    await click(stepButton('Close'));
    expect(stepButton('Close').getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the month with the steps still open named rather than in the way', async () => {
    const d = data({ transactions: [tx('f', { needs_review: true })] });
    renderAt(OCTOBER, d);
    await click(stepButton('Close'));
    expect(kpi('Income')).toBeTruthy();
    expect(kpi('Saved')).toBeTruthy();
    expect(kpi('Net worth')).toBeTruthy();
    expect(screen.getByText('Step 1 is still open. You can close now and finish after.')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Close October' }));
    expect(screen.getByLabelText('Assets (AED)').value).toBe('5000');
    expect(screen.getByLabelText('Liabilities (AED)').value).toBe('1000');
    await click(screen.getByRole('button', { name: /Confirm & close/ }));
    expect(writes).toEqual([{ table: 'net_worth_snapshots', upsert: { household_id: 'hh', snapshot_date: '2026-10-01', assets: 5000, liabilities: 1000 } }]);
    expect(d.reload).toHaveBeenCalled();
  });

  it('says a balance not confirmed since the month ended goes into the close as it stands', async () => {
    renderAt(OCTOBER, data({ accounts: [account('current', 'Current account', { balance_as_of: null }), CARD] }));
    await click(stepButton('Close'));
    await click(screen.getByRole('button', { name: 'Close October' }));
    const note = screen.getByText(/isn’t confirmed since the month ended/);
    expect(note.textContent).toMatch(/Current account/);
    expect(note.textContent).toMatch(/can’t be changed afterwards/);
  });

  // A close is kept for good, and nothing can change it afterwards. The
  // accounts are read before anything here shows; the holdings only the
  // close needs.
  it('offers no close while the holdings never loaded', () => {
    renderAt(OCTOBER, data({ holdings: [], errors: { holdings: 'network' }, loaded: {} }));
    // Every other step is clear, so the close is the step shown open.
    expect(stepButton('Close').getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Close October' })).toBeNull();
    expect(screen.getByText('Couldn’t load investments. October can’t be closed until they load: its totals would leave them out.')).toBeTruthy();
  });

  // A closed month read as open would be offered for closing again.
  it('shows nothing while the closes never loaded', () => {
    renderAt(OCTOBER, data({ netWorthSnapshots: [], errors: { netWorthSnapshots: 'network' }, loaded: {} }));
    expect(screen.getByText('Couldn’t load net-worth history.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Close October' })).toBeNull();
  });
});

describe('Month end: an earlier month never closed', () => {
  it('has the first two steps, and says it can’t be closed now', () => {
    renderAt('/money?tab=monthend&month=2026-08', data({ transactions: [tx('a', { occurred_at: '2026-08-10' })] }));
    expect(screen.getByRole('heading', { name: 'August 2026' })).toBeTruthy();
    expect(screen.getByText(/can’t be closed now/)).toBeTruthy();
    expect(screen.getByText('2 of 2 steps done')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Close/ })).toBeNull();
  });

  it('says so for a month before the records start', () => {
    renderAt('/money?tab=monthend&month=2025-03', data());
    expect(screen.getByText('No records in March 2025')).toBeTruthy();
  });
});

describe('Month end: a closed month on a page', () => {
  const income = (id, amount, occurred_at) => tx(id, { kind: 'income', amount, category_id: 'salary', occurred_at });
  const spend = (id, amount, occurred_at) => tx(id, { amount: -amount, occurred_at });
  const closedData = (extra = {}) =>
    data({
      transactions: [income('i10', 10000, '2026-10-01'), spend('s10', 6000, '2026-10-05'), income('i9', 9000, '2026-09-01'), spend('s9', 7000, '2026-09-05')],
      netWorthSnapshots: [
        { snapshot_date: '2026-10-01', assets: 100000, liabilities: 20000 },
        { snapshot_date: '2026-08-01', assets: 80000, liabilities: 5000 },
      ],
      budgets: [{ id: 'b', year: 2026, month: 10, category_id: 'groceries', amount: 5000 }],
      ...extra,
    });

  it('gives the month’s figures with what changed, its biggest changes and how it did against budget', () => {
    renderAt(OCTOBER, closedData());
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeTruthy();
    expect(screen.getByText('The month on a page')).toBeTruthy();
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Transactions →' }).getAttribute('href')).toMatch(/from=2026-10-01&to=2026-10-31/);
    expect(kpi('Income').textContent).toMatch(/10,000.*▲ 1,000 on Sep/);
    expect(kpi('Spent').textContent).toMatch(/6,000.*▼ 1,000 on Sep/);
    expect(kpi('Saved').textContent).toMatch(/4,000.*40% of income/);
    expect(kpi('Net worth at close').textContent).toMatch(/80,000.*▲ 5,000 on Aug/);
    const changes = screen.getByRole('region', { name: 'Biggest changes' });
    expect(within(changes).getByText('Groceries')).toBeTruthy();
    expect(within(changes).getByText(/−1,000 vs usual/)).toBeTruthy();
    const budget = screen.getByRole('region', { name: 'Against budget' });
    expect(within(budget).getByText('Groceries over by 1,000')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Close/ })).toBeNull();
  });

  it('opens a category’s records for the month from its change', async () => {
    renderAt(OCTOBER, closedData());
    await click(within(screen.getByRole('region', { name: 'Biggest changes' })).getByRole('button', { name: /Groceries/ }));
    expect(screen.getByTestId('where').textContent).toMatch(/^\/money\?tab=activity.*cat=groceries.*from=2026-10-01&to=2026-10-31/);
  });

  it('says when nothing went over, or no budget was set', () => {
    renderAt(OCTOBER, closedData({ budgets: [{ id: 'b', year: 2026, month: 10, category_id: 'groceries', amount: 9000 }] }));
    expect(within(screen.getByRole('region', { name: 'Against budget' })).getByText('No category over')).toBeTruthy();
  });

  it('says no budget was set for a month without one', () => {
    renderAt(OCTOBER, closedData({ budgets: [] }));
    expect(within(screen.getByRole('region', { name: 'Against budget' })).getByText('No budget was set for October.')).toBeTruthy();
  });
});
