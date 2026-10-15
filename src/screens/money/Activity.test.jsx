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
    expect(text).toMatch(/Spent AED 100 net of refunds/);
    expect(text).toMatch(/Income AED 500/);
  });

  it('omits the breakdown when there is nothing to show', () => {
    renderActivity([]);
    const text = document.querySelector('.mn-count').textContent;
    expect(text).toMatch(/0 posted records/);
    expect(text).not.toMatch(/Spent/);
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
    expect(text).toMatch(/Spent AED 40 net of refunds/);
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
    expect(text).toMatch(/Spent AED 100 /);
    expect(text).toMatch(/1 scheduled not counted/);
    expect(screen.queryByText('Next week')).toBeNull();
  });

  it('shows scheduled records, labelled, under Scheduled and All', () => {
    renderActivity(ROWS);
    fireEvent.click(screen.getByRole('button', { name: '1 scheduled not counted' }));
    expect(document.querySelector('.mn-count').textContent).toMatch(/2 records · Spent AED 400/);
    expect(screen.getByText('Next week').parentElement.textContent).toMatch(/scheduled/);
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled' }));
    expect(document.querySelector('.mn-count').textContent).toMatch(/1 scheduled record · Spent AED 300/);
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
    expect(document.querySelector('.mn-count').textContent).toMatch(/2 posted records · Spent AED 100/);
    expect(screen.getByText('Pump')).toBeTruthy();
    expect(screen.getByText('Taxi')).toBeTruthy();
    expect(screen.queryByText('Pump October')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Category' }).value).toBe('g');
  });

  it('shows the date range as a chip that clears it', () => {
    renderActivity(ROWS, { url: '/money?tab=activity&cat=g&from=2026-09-01&to=2026-09-30', categories: CATS });
    fireEvent.click(screen.getByRole('button', { name: 'September 2026: show all dates' }));
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
