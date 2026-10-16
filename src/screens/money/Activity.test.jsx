import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import Activity from './Activity';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

// The sidebar scope, set per test: Both, or one member's view.
const scopeState = vi.hoisted(() => ({ scope: 'both' }));
vi.mock('../../lib/ScopeContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useScope: () => ({ scope: scopeState.scope, setScope: () => {} }),
}));

beforeEach(() => {
  scopeState.scope = 'both';
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

function renderActivity(transactions, { url = '/money', categories = CATEGORIES } = {}) {
  return renderScreen(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <Activity
        household={{ id: 'h' }}
        members={MEMBERS}
        me={{ id: 'm1' }}
        loading={false}
        data={{
          transactions,
          accounts: ACCOUNTS,
          categories,
          reload: vi.fn().mockResolvedValue(undefined),
        }}
      />
    </MemoryRouter>,
  );
}

describe('Activity summary line', () => {
  it('shows a count with net spend and income, labelled in AED', () => {
    renderActivity([
      { id: 't1', amount: -100, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1' },
      { id: 't2', amount: 500, kind: 'income', occurred_at: '2026-09-04', is_shared: true },
    ]);
    const text = document.querySelector('.mn-count').textContent;
    expect(text).toMatch(/2 posted records/);
    expect(text).toMatch(/Net spend AED 100 · Income AED 500/);
  });

  it('omits the breakdown when there is nothing to show', () => {
    renderActivity([]);
    const text = document.querySelector('.mn-count').textContent;
    expect(text).toMatch(/0 posted records/);
    expect(text).not.toMatch(/Net spend/);
  });

  // The reviewer's case: a shared expense of 100 and a shared refund of 20.
  const SHARED_PAIR = [
    { id: 't1', amount: -100, kind: 'expense', occurred_at: '2026-10-10', is_shared: true, category_id: 'c1', merchant: 'Grocer' },
    { id: 't2', amount: 20, kind: 'refund', occurred_at: '2026-10-10', is_shared: true, category_id: 'c1', merchant: 'Grocer' },
  ];

  it('nets a refund against spend and, under Me, counts half of each shared record', () => {
    scopeState.scope = 'me';
    renderActivity(SHARED_PAIR);
    const text = document.querySelector('.mn-count').textContent;
    expect(text).toMatch(/Net spend AED 40 \(purchases 50 less refunds 10\)/);
    expect(text).toMatch(/Income AED 0/);
    expect(text).toMatch(/Your share: shared records count half/);
  });

  it('shows the share beside the full amount on a shared row', () => {
    scopeState.scope = 'partner';
    renderActivity(SHARED_PAIR.slice(0, 1));
    const amount = document.querySelector('.om-tx-row .om-tx-amt').textContent;
    expect(amount).toMatch(/−100/);
    expect(amount).toMatch(/sam's share −50/);
  });

  it('gives the calendar the same figures as the summary line', () => {
    scopeState.scope = 'me';
    renderActivity(SHARED_PAIR);
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    const day = [...document.querySelectorAll('.cal-cell')].find((c) => c.querySelector('.cal-daynum')?.textContent === '10');
    expect(day.querySelector('.cal-spend').textContent).toBe('−40');
    expect(day.querySelector('.cal-income')).toBeNull();
  });
});

describe('Activity posted and scheduled records', () => {
  const ROWS = [
    { id: 'past', amount: -100, kind: 'expense', occurred_at: '2026-10-15', is_shared: true, merchant: 'Today' },
    { id: 'next', amount: -300, kind: 'expense', occurred_at: '2026-10-20', is_shared: true, merchant: 'Next week' },
  ];

  it('counts posted records by default and says how many scheduled ones it left out', () => {
    renderActivity(ROWS);
    const text = document.querySelector('.mn-count').textContent;
    expect(text).toMatch(/1 posted record/);
    expect(text).toMatch(/Net spend AED 100 /);
    expect(text).toMatch(/1 scheduled not counted/);
    expect(screen.queryByText('Next week')).toBeNull();
  });

  it('shows scheduled records, labelled, under Scheduled and All', () => {
    renderActivity(ROWS);
    fireEvent.click(screen.getByRole('button', { name: '1 scheduled not counted' }));
    expect(document.querySelector('.mn-count').textContent).toMatch(/2 records · Net spend AED 400/);
    expect(screen.getByText('Next week').parentElement.textContent).toMatch(/scheduled/);
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled' }));
    expect(document.querySelector('.mn-count').textContent).toMatch(/1 scheduled record · Net spend AED 300/);
    expect(screen.queryByText('Today')).toBeNull();
  });
});

describe('Activity confidence badge', () => {
  it('flags a low-confidence transaction', () => {
    renderActivity([
      { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: 0.7, merchant: 'Carrefour' },
    ]);
    expect(screen.getByText(/low confidence/)).toBeTruthy();
  });

  it('flags a very-low-confidence transaction as needing attention', () => {
    renderActivity([
      { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: 0.4, merchant: 'Carrefour' },
    ]);
    expect(screen.getByText(/needs attention/)).toBeTruthy();
  });

  it('shows no badge for a confident or manually-entered transaction', () => {
    renderActivity([
      { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: 0.95, merchant: 'Carrefour' },
      { id: 't2', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: null, merchant: 'Manual entry' },
    ]);
    expect(screen.queryByText(/low confidence/)).toBeNull();
    expect(screen.queryByText(/needs attention/)).toBeNull();
  });

  it('prefers the needs_review flag over a confidence badge when both apply', () => {
    renderActivity([
      { id: 't1', amount: -50, kind: 'expense', occurred_at: '2026-09-05', is_shared: true, category_id: 'c1', confidence: 0.4, needs_review: true, merchant: 'Carrefour' },
    ]);
    expect(screen.getByText(/needs review/)).toBeTruthy();
    expect(screen.queryByText(/needs attention/)).toBeNull();
  });
});

describe('Activity filters in the address', () => {
  const CATS = [
    { id: 'g', name: 'Transport', kind: 'expense', parent_id: null },
    { id: 'fuel', name: 'Fuel', kind: 'expense', parent_id: 'g' },
    { id: 'c1', name: 'Groceries', kind: 'expense', parent_id: null },
  ];
  const ROWS = [
    { id: 'a', amount: -40, kind: 'expense', occurred_at: '2026-09-10', is_shared: true, category_id: 'fuel', merchant: 'Pump' },
    { id: 'b', amount: -60, kind: 'expense', occurred_at: '2026-09-12', is_shared: true, category_id: 'g', merchant: 'Taxi' },
    { id: 'c', amount: -70, kind: 'expense', occurred_at: '2026-10-02', is_shared: true, category_id: 'fuel', merchant: 'Pump October' },
    { id: 'd', amount: -90, kind: 'expense', occurred_at: '2026-09-15', is_shared: true, category_id: 'c1', merchant: 'Grocer' },
  ];

  it('opens on the month and category a link names, a group including its subcategories', () => {
    renderActivity(ROWS, { url: '/money?tab=activity&cat=g&from=2026-09-01&to=2026-09-30', categories: CATS });
    expect(document.querySelector('.mn-count').textContent).toMatch(/2 posted records · September 2026 · Net spend AED 100/);
    expect(screen.getByText('Pump')).toBeTruthy();
    expect(screen.getByText('Taxi')).toBeTruthy();
    expect(screen.queryByText('Pump October')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Category' }).value).toBe('g');
  });

  it('shows the date range in the date select, which clears it', () => {
    renderActivity(ROWS, { url: '/money?tab=activity&cat=g&from=2026-09-01&to=2026-09-30', categories: CATS });
    const dates = screen.getByRole('combobox', { name: 'Dates' });
    expect(dates.value).toBe('last-month');
    fireEvent.change(dates, { target: { value: 'all' } });
    expect(currentSearch()).toBe('?tab=activity&cat=g');
    expect(screen.getByText('Pump October')).toBeTruthy();
  });

  it('writes a changed filter back to the address', () => {
    renderActivity(ROWS, { url: '/money?tab=activity', categories: CATS });
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'c1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Needs review' }));
    expect(currentSearch()).toBe('?tab=activity&cat=c1&review=1');
  });
});

describe('Activity date select and other filters', () => {
  const ROWS = [
    { id: 'a', amount: -40, kind: 'expense', occurred_at: '2026-08-10', is_shared: true, account_id: 'a1', merchant: 'August shop' },
    { id: 'b', amount: -60, kind: 'expense', occurred_at: '2026-10-12', is_shared: true, account_id: 'a2', merchant: 'Card shop' },
    { id: 'c', amount: 25, kind: 'refund', occurred_at: '2026-10-13', is_shared: true, account_id: 'a2', merchant: 'Card refund' },
  ];
  const TWO_ACCOUNTS = [...ACCOUNTS, { id: 'a2', name: 'Debit card', type: 'checking', archived_at: null, is_shared: true }];

  function renderWith(url) {
    return renderScreen(
      <MemoryRouter initialEntries={[url]}>
        <LocationProbe />
        <Activity household={{ id: 'h' }} members={MEMBERS} me={{ id: 'm1' }} loading={false} data={{ transactions: ROWS, accounts: TWO_ACCOUNTS, categories: CATEGORIES, reload: vi.fn() }} />
      </MemoryRouter>,
    );
  }

  it('names a linked range that is not a preset, and offers custom dates', () => {
    renderWith('/money?tab=activity&from=2026-08-01&to=2026-08-31');
    const dates = screen.getByRole('combobox', { name: 'Dates' });
    expect(dates.options[dates.selectedIndex].textContent).toBe('August 2026');
    expect(screen.getByText('August shop')).toBeTruthy();
    fireEvent.change(dates, { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    expect(currentSearch()).toBe('?tab=activity&from=2026-10-01&to=2026-10-31');
    expect(screen.queryByText('August shop')).toBeNull();
  });

  it('narrows by account and type, and clears every filter at once', () => {
    renderWith('/money?tab=activity');
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: 'a2' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), { target: { value: 'refund' } });
    expect(screen.getByText('Card refund')).toBeTruthy();
    expect(screen.queryByText('Card shop')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(currentSearch()).toBe('?tab=activity');
    expect(screen.getByText('August shop')).toBeTruthy();
  });

  it('sorts by size when asked', () => {
    renderWith('/money?tab=activity&sort=largest');
    const merchants = [...document.querySelectorAll('.om-tx-row .om-tx-merchant')].map((m) => m.firstChild.textContent);
    expect(merchants).toEqual(['Card shop', 'August shop', 'Card refund']);
  });
});
