import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

// Category changes made in place, from the list.
const writes = vi.hoisted(() => ({ updates: [], edits: [], changed: 1 }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      update: (row) => ({
        eq: (col, id) => ({
          is: (col2, value) => ({
            select: () => {
              writes.updates.push({ table, row, id, guard: [col2, value] });
              return Promise.resolve({ data: Array.from({ length: writes.changed }, () => ({ id })), error: null });
            },
          }),
        }),
      }),
      insert: (rows) => {
        writes.edits.push({ table, rows });
        return Promise.resolve({ error: null });
      },
    }),
  },
}));

// The sidebar scope, set per test: Both, or one member's view.
const scopeState = vi.hoisted(() => ({ scope: 'both' }));
vi.mock('../../lib/ScopeContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useScope: () => ({ scope: scopeState.scope, setScope: () => {} }),
}));

const { default: Activity } = await import('./Activity');

beforeEach(() => {
  scopeState.scope = 'both';
  writes.updates.length = 0;
  writes.edits.length = 0;
  writes.changed = 1;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 15, 12));
});
afterEach(() => {
  vi.useRealTimers();
});

const MEMBERS = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
];
const ACCOUNTS = [{ id: 'a1', name: 'ENBD', type: 'credit_card', archived_at: null, is_shared: true }];
const CATEGORIES = [{ id: 'c1', name: 'Groceries', kind: 'expense', parent_id: null }];

// The address Activity is showing, to check what its filters wrote there.
function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}
const currentSearch = () => screen.getByTestId('location').textContent;

function renderActivity(transactions, { url = '/money', categories = CATEGORIES, accounts = ACCOUNTS, links = [], reload = vi.fn().mockResolvedValue(undefined) } = {}) {
  return renderScreen(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <Activity
        household={{ id: 'h' }}
        members={MEMBERS}
        me={{ id: 'm1' }}
        loading={false}
        data={{ transactions, accounts, categories, transactionLinks: links, reload }}
      />
    </MemoryRouter>,
  );
}

// The table card's figures: "Spent 100Income 500".
const summary = () => document.querySelector('.mn-summary').textContent;
const merchants = () => [...document.querySelectorAll('.om-tx-row .mn-open')].map((b) => b.textContent);

describe('Activity: the summary on the table', () => {
  it('names the count, and gives Spent and Income', () => {
    renderActivity([
      { id: 't1', amount: -100, kind: 'expense', occurred_at: '2026-10-05', is_shared: true, category_id: 'c1', merchant: 'Grocer' },
      { id: 't2', amount: 500, kind: 'income', occurred_at: '2026-10-04', is_shared: true, merchant: 'Employer' },
    ]);
    expect(screen.getByRole('region', { name: '2 transactions' })).toBeTruthy();
    expect(summary()).toMatch(/Spent\s*100/);
    expect(summary()).toMatch(/Income\s*500/);
  });

  it('says nothing matches when the month is empty', () => {
    renderActivity([{ id: 't1', amount: -100, kind: 'expense', occurred_at: '2026-10-05', is_shared: true, merchant: 'Grocer' }], { url: '/money?q=nothing' });
    expect(screen.getByText('Nothing matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(currentSearch()).toBe('');
  });

  // The reviewer's case: a shared expense of 100 and a shared refund of 20.
  const SHARED_PAIR = [
    { id: 't1', amount: -100, kind: 'expense', occurred_at: '2026-10-10', is_shared: true, category_id: 'c1', merchant: 'Grocer' },
    { id: 't2', amount: 20, kind: 'refund', occurred_at: '2026-10-10', is_shared: true, category_id: 'c1', merchant: 'Grocer' },
  ];

  it('nets a refund against spend and, under Me, counts half of each shared record', () => {
    scopeState.scope = 'me';
    renderActivity(SHARED_PAIR);
    expect(summary()).toMatch(/Spent\s*40/);
    expect(summary()).toMatch(/Income\s*0/);
    fireEvent.click(screen.getByRole('button', { name: 'About these totals' }));
    const note = screen.getByRole('note').textContent;
    expect(note).toMatch(/purchases 50 less refunds 10/);
    expect(note).toMatch(/Shared records count half/);
  });

  // In one person's view the amount is their part, so the column adds up to
  // the totals; the whole amount is beneath it (design/prototype).
  it("shows a shared row's part, with the whole amount beneath", () => {
    scopeState.scope = 'partner';
    renderActivity(SHARED_PAIR.slice(0, 1));
    const amount = document.querySelector('.om-tx-row .mn-amt').textContent;
    expect(amount).toMatch(/^−50/);
    expect(amount).toMatch(/half of −100/);
  });

  it('gives the calendar the same figures as the summary', () => {
    scopeState.scope = 'me';
    renderActivity(SHARED_PAIR);
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    const day = [...document.querySelectorAll('.cal-cell')].find((c) => c.querySelector('.cal-daynum')?.textContent === '10');
    expect(day.querySelector('.cal-spend').textContent).toBe('−40');
    expect(day.querySelector('.cal-income')).toBeNull();
  });
});

describe('Activity: posted and scheduled records', () => {
  const ROWS = [
    { id: 'past', amount: -100, kind: 'expense', occurred_at: '2026-10-15', is_shared: true, merchant: 'Today' },
    { id: 'next', amount: -300, kind: 'expense', occurred_at: '2026-10-20', is_shared: true, merchant: 'Next week' },
  ];

  it('counts posted records by default and says how many scheduled ones it left out', () => {
    renderActivity(ROWS);
    expect(screen.getByRole('region', { name: '1 transaction' })).toBeTruthy();
    expect(summary()).toMatch(/Spent\s*100/);
    expect(screen.queryByText('Next week')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1 scheduled not counted' }));
    expect(currentSearch()).toBe('?dates=all');
    expect(summary()).toMatch(/Spent\s*400/);
    const row = screen.getByText('Next week').closest('tr');
    expect(within(row).getByText('Scheduled')).toBeTruthy();
  });

  it('shows only scheduled records when asked, from More', () => {
    renderActivity(ROWS);
    fireEvent.click(screen.getByRole('button', { name: /^More/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Which dates' })).getByRole('button', { name: 'Scheduled' }));
    expect(screen.getByText('Next week')).toBeTruthy();
    expect(screen.queryByText('Today')).toBeNull();
  });
});

describe('Activity: what a row says about itself', () => {
  const row = (extra) => ({ id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-10-05', is_shared: true, category_id: 'c1', merchant: 'Carrefour', ...extra });

  it('flags a low-confidence reading, and a very low one as needing attention', () => {
    renderActivity([row({ confidence: 0.7 }), row({ id: 't2', merchant: 'Other', confidence: 0.4 })]);
    expect(screen.getByText('Low confidence')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
  });

  it('shows no flag for a confident or hand-entered record', () => {
    renderActivity([row({ confidence: 0.95 }), row({ id: 't2', merchant: 'Manual entry', confidence: null })]);
    expect(screen.queryByText('Low confidence')).toBeNull();
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  it('prefers Needs review over a confidence flag', () => {
    renderActivity([row({ confidence: 0.4, needs_review: true })]);
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  // The pairs Month end asks about (lib/duplicates.js), marked where they are
  // listed too.
  it('marks a possible duplicate, and not a pair said to be real', () => {
    const pair = [row(), row({ id: 't2', occurred_at: '2026-10-06', account_id: 'a1' })].map((t) => ({ ...t, account_id: 'a1' }));
    const { unmount } = renderActivity(pair);
    expect(screen.getAllByText('Possible duplicate')).toHaveLength(2);
    unmount();
    renderActivity(pair, { links: [{ id: 'l', kind: 'duplicate_confirmed', from_transaction_id: 't1', to_transaction_id: 't2' }] });
    expect(screen.queryByText('Possible duplicate')).toBeNull();
  });

  it("puts the owner's initial beside the account", () => {
    renderActivity([row({ is_shared: false, owner_member_id: 'm2', account_id: 'a1' })]);
    const account = document.querySelector('.om-tx-row .mn-acct');
    expect(within(account).getByRole('img', { name: 'Sam' }).textContent).toBe('S');
    expect(account.textContent).toMatch(/ENBD/);
  });
});

describe('Activity: a category chosen in the list', () => {
  const CATS = [
    { id: 'food', name: 'Food', kind: 'expense', parent_id: null },
    { id: 'c1', name: 'Groceries', kind: 'expense', parent_id: 'food' },
    { id: 'pay', name: 'Salary', kind: 'income', parent_id: null },
  ];
  const BARE = { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-10-05', is_shared: true, category_id: null, merchant: 'Shop' };

  it('offers the categories an expense can be filed under, and saves the one chosen with its history', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    renderActivity([BARE], { categories: CATS, reload });
    const select = screen.getByRole('combobox', { name: 'Category for Shop' });
    expect([...select.options].map((o) => o.textContent)).toEqual(['Uncategorised', 'Food › Groceries']);
    await act(async () => fireEvent.change(select, { target: { value: 'c1' } }));
    expect(writes.updates).toEqual([{ table: 'transactions', row: { category_id: 'c1' }, id: 't1', guard: ['category_id', null] }]);
    expect(writes.edits).toEqual([{ table: 'transaction_edits', rows: [{ transaction_id: 't1', field: 'category', old_value: 'Uncategorised', new_value: 'Groceries' }] }]);
    expect(reload).toHaveBeenCalled();
  });

  it('says so when the record was changed elsewhere first', async () => {
    writes.changed = 0;
    renderActivity([BARE], { categories: CATS });
    await act(async () => fireEvent.change(screen.getByRole('combobox', { name: 'Category for Shop' }), { target: { value: 'c1' } }));
    expect(screen.getByRole('alert').textContent).toMatch(/changed elsewhere/);
    expect(writes.edits).toEqual([]);
  });

  it('names the category of a record that has one, and leaves transfers and splits alone', () => {
    renderActivity([{ ...BARE, category_id: 'c1' }], { categories: CATS });
    expect(screen.queryByRole('combobox', { name: 'Category for Shop' })).toBeNull();
    expect(document.querySelector('.om-tx-row .mn-cat').textContent).toBe('Groceries');
  });
});

describe('Activity: dates', () => {
  const ROWS = [
    { id: 'a', amount: -40, kind: 'expense', occurred_at: '2026-08-10', is_shared: true, account_id: 'a1', merchant: 'August shop' },
    { id: 'b', amount: -60, kind: 'expense', occurred_at: '2026-10-12', is_shared: true, account_id: 'a1', merchant: 'October shop' },
  ];

  it('shows this month by default, and steps a month at a time', () => {
    renderActivity(ROWS);
    expect(merchants()).toEqual(['October shop']);
    expect(screen.getByRole('combobox', { name: 'Dates' }).value).toBe('month');
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(currentSearch()).toBe('?month=2026-08');
    expect(merchants()).toEqual(['August shop']);
  });

  it('shows every date, and offers a range of its own', () => {
    renderActivity(ROWS);
    fireEvent.change(screen.getByRole('combobox', { name: 'Dates' }), { target: { value: 'all' } });
    expect(currentSearch()).toBe('?range=all');
    expect(merchants()).toEqual(['October shop', 'August shop']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Dates' }), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-20' } });
    expect(currentSearch()).toBe('?from=2026-08-01&to=2026-08-20');
    expect(merchants()).toEqual(['August shop']);
  });

  it("opens on a link's month, a group including its subcategories", () => {
    const cats = [
      { id: 'g', name: 'Transport', kind: 'expense', parent_id: null },
      { id: 'fuel', name: 'Fuel', kind: 'expense', parent_id: 'g' },
    ];
    renderActivity(
      [
        { id: 'p', amount: -40, kind: 'expense', occurred_at: '2026-09-10', is_shared: true, category_id: 'fuel', merchant: 'Pump' },
        { id: 't', amount: -60, kind: 'expense', occurred_at: '2026-09-12', is_shared: true, category_id: 'g', merchant: 'Taxi' },
        { id: 'o', amount: -70, kind: 'expense', occurred_at: '2026-10-02', is_shared: true, category_id: 'fuel', merchant: 'Pump October' },
      ],
      { url: '/money?tab=activity&cat=g&from=2026-09-01&to=2026-09-30', categories: cats },
    );
    expect(document.querySelector('.ds-stepper-label').textContent).toBe('Sep 2026');
    expect(merchants()).toEqual(['Taxi', 'Pump']);
    expect(screen.getByRole('combobox', { name: 'Category' }).value).toBe('g');
    expect(summary()).toMatch(/Spent\s*100/);
  });

  it('says a range that is not a whole month by its ends', () => {
    renderActivity(ROWS, { url: '/money?from=2026-10-01&to=2026-10-15' });
    const dates = screen.getByRole('combobox', { name: 'Dates' });
    expect(dates.options[dates.selectedIndex].textContent).toBe('1 Oct – 15 Oct 2026');
    expect(screen.getByLabelText('From').value).toBe('2026-10-01');
  });

  it('offers a way back from a month before the records start', () => {
    renderActivity(ROWS, { url: '/money?month=2026-03' });
    expect(screen.getByText('No transactions in March 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Oct 2026' }));
    expect(currentSearch()).toBe('');
  });
});

describe('Activity: filters', () => {
  const ROWS = [
    { id: 'a', amount: -40, kind: 'expense', occurred_at: '2026-10-10', is_shared: true, account_id: 'a1', merchant: 'Bank shop' },
    { id: 'b', amount: -60, kind: 'expense', occurred_at: '2026-10-12', is_shared: true, account_id: 'a2', merchant: 'Card shop' },
    { id: 'c', amount: 25, kind: 'refund', occurred_at: '2026-10-13', is_shared: true, account_id: 'a2', merchant: 'Card refund' },
  ];
  const TWO_ACCOUNTS = [...ACCOUNTS, { id: 'a2', name: 'Debit card', type: 'checking', archived_at: null, is_shared: true }];

  it('narrows by account and, from More, by type; names each, and clears them', () => {
    renderActivity(ROWS, { accounts: TWO_ACCOUNTS });
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: 'a2' } });
    fireEvent.click(screen.getByRole('button', { name: /^More/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), { target: { value: 'refund' } });
    expect(merchants()).toEqual(['Card refund']);
    expect(screen.getByRole('button', { name: 'More, 1 set' })).toBeTruthy();
    const chips = screen.getByRole('list', { name: 'Filters' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Remove Refunds' }));
    expect(currentSearch()).toBe('?acct=a2');
    fireEvent.click(within(chips).getByRole('button', { name: 'Clear' }));
    expect(currentSearch()).toBe('');
    expect(merchants()).toHaveLength(3);
  });

  it('writes the category and Needs review to the address', () => {
    renderActivity(ROWS);
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: /^More/ }));
    fireEvent.click(screen.getByRole('switch', { name: 'Needs review only' }));
    expect(currentSearch()).toBe('?cat=c1&review=1');
  });

  it('sorts by date or amount from the column headings', () => {
    renderActivity(ROWS);
    expect(merchants()).toEqual(['Card refund', 'Card shop', 'Bank shop']);
    fireEvent.click(screen.getByRole('button', { name: 'Amount' }));
    expect(merchants()).toEqual(['Card shop', 'Bank shop', 'Card refund']);
    expect(screen.getByRole('columnheader', { name: 'Amount' }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(screen.getByRole('button', { name: 'Amount' }));
    expect(merchants()).toEqual(['Card refund', 'Bank shop', 'Card shop']);
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    expect(currentSearch()).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    expect(currentSearch()).toBe('?sort=oldest');
    expect(merchants()).toEqual(['Bank shop', 'Card shop', 'Card refund']);
  });
});

describe('Activity: transfers', () => {
  it('labels each side by where the money went and leaves both out of the totals', () => {
    const accounts = [...ACCOUNTS, { id: 'a2', name: 'Savings', type: 'savings', archived_at: null, is_shared: true }];
    const rows = [
      { id: 'e', amount: -100, kind: 'expense', occurred_at: '2026-10-05', is_shared: true, account_id: 'a1', merchant: 'Grocer', category_id: 'c1' },
      { id: 'o', amount: -500, kind: 'transfer', occurred_at: '2026-10-06', is_shared: true, account_id: 'a1' },
      { id: 'i', amount: 500, kind: 'transfer', occurred_at: '2026-10-06', is_shared: true, account_id: 'a2' },
    ];
    renderActivity(rows, { accounts, links: [{ id: 'l', kind: 'transfer', from_transaction_id: 'o', to_transaction_id: 'i' }] });
    expect(screen.getByText('To Savings')).toBeTruthy();
    expect(screen.getByText('From ENBD')).toBeTruthy();
    expect(summary()).toMatch(/Spent\s*100/);
    expect(summary()).toMatch(/Income\s*0/);
    fireEvent.click(screen.getByRole('button', { name: 'About these totals' }));
    expect(screen.getByRole('note').textContent).toMatch(/2 transfers between your own accounts count as neither/);
  });
});
