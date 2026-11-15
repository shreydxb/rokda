import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { renderScreen } from '../../test/renderScreen';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));
// The sidebar scope, set per test: Both, or one member's view.
const scopeState = vi.hoisted(() => ({ scope: 'both' }));
vi.mock('../../lib/ScopeContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useScope: () => ({ scope: scopeState.scope, setScope: () => {} }),
}));
const { default: Recurring } = await import('./Recurring');

const NOW = new Date('2026-10-21T09:00:00');
const MEMBERS = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
];
const bill = (over) => ({ id: over.name, amount: -100, currency: 'AED', cadence: 'monthly', interval_count: 1, is_shared: true, active: true, autopay: false, is_fixed: true, ...over });

function renderRecurring(recurring, { accounts = [], transactions = [] } = {}) {
  renderScreen(<Recurring household={{ id: 'hh' }} members={MEMBERS} me={{ id: 'm1' }} loading={false} data={{ recurring, accounts, categories: [], transactions, reload: vi.fn() }} />);
}
// The rows of a table, by name.
const names = (region) => [...screen.getByRole('region', { name: region }).querySelectorAll('[data-testid="recurring-row"] .rc-name')].map((n) => n.textContent.trim());
const figure = (label) => screen.getByText(label, { selector: 'dt' }).closest('.ds-kpi').querySelector('dd').textContent;

beforeEach(() => {
  scopeState.scope = 'both';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Recurring: the strip', () => {
  it('gives fixed and variable bills a month, expected income, and what is to mark paid', () => {
    renderRecurring([
      bill({ name: 'Rent', amount: -6000, next_due_date: '2026-10-28' }),
      bill({ name: 'Insurance', amount: -1200, cadence: 'yearly', next_due_date: '2027-02-01' }),
      bill({ name: 'Power', amount: -300, is_fixed: false, next_due_date: '2026-10-28' }),
      bill({ name: 'Salary', amount: 20000, next_due_date: '2026-10-28' }),
      bill({ name: 'School fees', amount: -900, next_due_date: '2026-09-05' }),
    ]);
    expect(figure('Fixed a month')).toBe('7,0003 bills');
    expect(figure('Variable, about')).toBe('3001 bill');
    expect(figure('Expected income a month')).toBe('20,000');
    expect(figure('To mark paid')).toBe('11 late');
  });

  it('says all clear when nothing is to mark paid', () => {
    renderRecurring([bill({ name: 'Rent', next_due_date: '2026-10-28' })]);
    expect(figure('To mark paid')).toBe('0All clear');
  });
});

// The page once listed bills in the order they were added (layout audit,
// 21 Oct): what needs marking comes first.
describe('Recurring: the bills', () => {
  it('puts a late bill, then one due soon, before the upcoming ones, and folds an ended one away', () => {
    renderRecurring([
      bill({ name: 'Rent', next_due_date: '2026-10-28' }),
      bill({ name: 'Phone', next_due_date: '2026-10-23' }),
      bill({ name: 'School fees', next_due_date: '2026-09-05' }),
      bill({ name: 'Old gym', next_due_date: '2026-03-03', ends_on: '2026-06-03' }),
    ]);
    expect(names('Bills')).toEqual(['School fees', 'Phone', 'Rent']);
    expect(screen.getAllByRole('button', { name: 'Mark paid' })).toHaveLength(2);
    expect(screen.getByText('Ended (1)').closest('details').open).toBe(false);
  });

  it('says when a late bill was due, and how long ago', () => {
    renderRecurring([bill({ name: 'School fees', next_due_date: '2026-09-05' })]);
    const row = screen.getByText('School fees').closest('tr');
    expect(within(row).getByText('Late')).toBeTruthy();
    expect(row.querySelector('.rc-due').textContent).toBe('5 Oct16 days ago');
    expect(row.querySelector('.rc-every').textContent).toBe('Month');
  });

  it('says Not confirmed for an autopay bill with nothing recorded, and Paid once it is', () => {
    const transactions = [{ id: 't', account_id: 'a', amount: -100, kind: 'expense', occurred_at: '2026-10-05', merchant: 'Phone' }];
    renderRecurring(
      [bill({ name: 'Cloud', amount: -10, autopay: true, next_due_date: '2026-09-10' }), bill({ name: 'Phone', account_id: 'a', next_due_date: '2026-09-05' })],
      { transactions },
    );
    const cloud = screen.getByText('Cloud').closest('tr');
    expect(within(cloud).getByText('Not confirmed')).toBeTruthy();
    expect(within(cloud).getByText('Autopay')).toBeTruthy();
    const phone = screen.getByText('Phone').closest('tr');
    expect(within(phone).getByText('Paid')).toBeTruthy();
    expect(within(phone).getByText('Manual')).toBeTruthy();
  });

  it('says about for an amount that varies', () => {
    renderRecurring([bill({ name: 'Power', amount: -300, is_fixed: false, next_due_date: '2026-10-28' })]);
    expect(screen.getByText('Power').closest('tr').querySelector('.rc-amount').textContent).toBe('about −300');
  });
});

// The fresh review of 4a: a schedule past its last date with its last
// payment unpaid is still to mark, and a paused one asks nothing.
describe('Recurring: ending and pausing', () => {
  it('keeps a just-ended schedule with an unpaid payment among the bills, with Mark paid', () => {
    renderRecurring([bill({ name: 'Gym', next_due_date: '2026-09-05', ends_on: '2026-10-10' })]);
    expect(names('Bills')).toEqual(['Gym']);
    expect(screen.getByRole('button', { name: 'Mark paid' })).toBeTruthy();
    expect(screen.queryByText('Ended (1)')).toBeNull();
  });

  it('says Paused, with no Mark paid', () => {
    renderRecurring([bill({ name: 'Gym', active: false, next_due_date: '2026-09-05' })]);
    const row = screen.getByText('Gym').closest('tr');
    expect(within(row).getByText('Paused')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark paid' })).toBeNull();
  });
});

describe('Recurring: expected income', () => {
  it('lists income with the account it is paid into', () => {
    renderRecurring([bill({ name: 'Salary', amount: 20000, account_id: 'a', next_due_date: '2026-10-28' })], { accounts: [{ id: 'a', name: 'Current account', is_shared: true }] });
    const row = within(screen.getByRole('region', { name: 'Expected income' })).getByText('Salary').closest('tr');
    expect(within(row).getByText('Current account')).toBeTruthy();
    expect(within(row).getByText('Upcoming')).toBeTruthy();
  });
});

describe("Recurring: one person's view", () => {
  it("leaves out the other person's own schedules and shows half of a shared one", () => {
    scopeState.scope = 'me';
    renderRecurring([
      bill({ name: 'Shared rent', amount: -6000, next_due_date: '2026-10-28' }),
      bill({ name: 'Their gym', amount: -200, is_shared: false, owner_member_id: 'm2', next_due_date: '2026-10-28' }),
    ]);
    expect(names('Bills')).toEqual(['Shared rent']);
    const amount = screen.getByText('Shared rent').closest('tr').querySelector('.rc-amount').textContent;
    expect(amount).toMatch(/^−3,000/);
    expect(amount).toMatch(/half of −6,000/);
  });
});

// The fresh review of B-02: a bill is settled only by a payment on its own
// account, so "Mark paid" starts the payment on that account.
describe('Recurring: Mark paid', () => {
  it("starts the payment on the bill's own account", () => {
    const accounts = [
      { id: 'a-first', name: 'First bank', type: 'checking', currency: 'AED', is_shared: true, archived_at: null },
      { id: 'a-bill', name: 'Bill bank', type: 'checking', currency: 'AED', is_shared: true, archived_at: null },
    ];
    renderRecurring([bill({ name: 'Phone', next_due_date: '2026-10-23', account_id: 'a-bill' })], { accounts });
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    const account = [...document.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === 'a-bill'));
    expect(account.value).toBe('a-bill');
  });

  // A payment settles a bill only near its date, so a late one is paid on
  // the day it was due, as Overview's To do does (the fresh review of 4a).
  it('dates a late bill\'s payment the day it was due, and one not yet due today', () => {
    renderRecurring([bill({ name: 'School fees', next_due_date: '2026-09-05' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    expect(screen.getByLabelText('Date').value).toBe('2026-10-05');
  });

  it('dates a bill due soon today', () => {
    renderRecurring([bill({ name: 'Phone', next_due_date: '2026-10-23' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    expect(screen.getByLabelText('Date').value).toBe('2026-10-21');
  });
});

describe('Recurring: + Bill', () => {
  it('opens the editor for a new bill, in the drawer', () => {
    renderRecurring([bill({ name: 'Rent', next_due_date: '2026-10-28' })]);
    fireEvent.click(screen.getByRole('button', { name: '+ Bill' }));
    expect(screen.getByRole('dialog', { name: 'Add a bill or income' })).toBeTruthy();
  });
});
