// Every form that offers today's date offers the household's day.
//
// At 01:30 in Dubai on the 16th it is still the 15th in UTC, and six forms
// defaulted their date to `new Date().toISOString().slice(0, 10)`. An expense,
// a bill marked paid, an Inbox item with no date, a new reminder, a new deposit
// term or a goal contribution entered after midnight was dated the day before
// unless someone noticed. The as-of fields read the browser's own day, which
// is Dubai's only while the browser is there.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from './test/renderScreen';

vi.mock('./lib/supabaseClient', () => {
  const done = Promise.resolve({ data: [], error: null });
  const chain = {
    eq: () => chain,
    order: () => done,
    select: () => chain,
    single: () => done,
    then: (resolve, reject) => done.then(resolve, reject),
  };
  return { supabase: { from: () => ({ select: () => chain, insert: () => chain, update: () => chain }), rpc: () => done } };
});

const { default: TransactionEditor } = await import('./screens/money/TransactionEditor');
const { default: Recurring } = await import('./screens/money/Recurring');
const { default: Inbox } = await import('./screens/money/Inbox');
const { default: RecurringEditor } = await import('./screens/money/RecurringEditor');
const { default: AccountEditor } = await import('./screens/wealth/AccountEditor');
const { default: HoldingEditor } = await import('./screens/wealth/HoldingEditor');
const { default: GoalEditor } = await import('./screens/planning/GoalEditor');

// 01:30 on the 16th in Dubai; 21:30 on the 15th in UTC.
const AFTER_MIDNIGHT_DUBAI = new Date('2026-09-15T21:30:00Z');
const DUBAI_DAY = '2026-09-16';
const ACCOUNTS = [{ id: 'acc-1', name: 'Bank card', type: 'credit_card', currency: 'AED', archived_at: null, is_shared: true }];
const dateField = (label) => screen.getByText(label, { selector: '.te-fieldlabel' }).parentElement.querySelector('input[type="date"]');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AFTER_MIDNIGHT_DUBAI);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("forms default to the household's day, not UTC's", () => {
  it('a new transaction', () => {
    renderScreen(<TransactionEditor tx={null} householdId="hh" accounts={ACCOUNTS} categories={[]} members={[]} allTransactions={[]} onClose={() => {}} onSaved={async () => {}} onOpenOther={null} />);
    expect(dateField('Date').value).toBe(DUBAI_DAY);
  });

  it('a bill marked paid from Recurring', () => {
    const rent = { id: 'r1', name: 'Rent', amount: -1000, currency: 'AED', cadence: 'monthly', interval_count: 1, next_due_date: DUBAI_DAY, is_shared: true, active: true, autopay: false, is_fixed: true };
    renderScreen(<Recurring household={{ id: 'hh' }} members={[]} loading={false} data={{ recurring: [rent], accounts: ACCOUNTS, categories: [], transactions: [], reload: vi.fn() }} />);
    fireEvent.click(screen.getByText('Mark paid'));
    expect(dateField('Date').value).toBe(DUBAI_DAY);
  });

  it('an Inbox item with no date, opened to edit', async () => {
    const item = { id: 'i1', household_id: 'hh', status: 'pending', source: 'telegram', raw_text: 'Cafe 20', parsed_amount: 20, parsed_merchant: 'Cafe', parsed_category_id: null, parsed_date: null, confidence: 0.9 };
    renderScreen(<Inbox members={[]} accounts={ACCOUNTS} categories={[]} loading={false} data={{ intake: [item], categoryRules: [], reload: vi.fn() }} />);
    await act(async () => {
      screen.getByRole('button', { name: 'Edit first' }).click();
    });
    expect(document.querySelector('input[type="date"]').value).toBe(DUBAI_DAY);
  });

  it('a new reminder', () => {
    renderScreen(<RecurringEditor household={{ id: 'hh', inr_per_aed: null }} householdId="hh" accounts={[]} categories={[]} members={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(dateField('Next due date').value).toBe(DUBAI_DAY);
  });

  it("a balance's as-of date, and its latest allowed day", () => {
    renderScreen(<AccountEditor account={null} defaultType="checking" householdId="hh" members={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    const asOf = screen.getByLabelText('Balance as of');
    expect([asOf.value, asOf.max]).toEqual([DUBAI_DAY, DUBAI_DAY]);
  });

  it('a matured deposit rolled into a new term', () => {
    const fd = { id: 'fd1', name: 'Term deposit', type: 'fd', currency: 'AED', balance: 10365, principal: 10000, interest_rate_pct: 3.65, compounding: 'simple', opened_date: '2025-09-15', maturity_date: '2026-09-15', fd_status: 'matured', is_shared: true, owner_member_id: null, credit_limit: null, statement_day: null, due_day: null, archived_at: null };
    renderScreen(<AccountEditor account={fd} householdId="hh" members={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByText('Start new term'));
    expect(dateField('Opened').value).toBe(DUBAI_DAY);
  });

  it("a holding's valuation date", () => {
    renderScreen(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    const asOf = screen.getByLabelText('Valued as of');
    expect([asOf.value, asOf.max]).toEqual([DUBAI_DAY, DUBAI_DAY]);
  });

  it('a goal contribution', () => {
    const goal = { id: 'g1', name: 'Trip', target_amount: 5000, target_date: '2027-06-01', is_shared: true, owner_member_id: null, note: '', funding_source: null, cost_today: false, inflation_pct: null, priority: null };
    renderScreen(<GoalEditor goal={goal} contributions={[]} allocations={[]} accounts={[]} holdings={[]} householdId="hh" members={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(dateField('Date').value).toBe(DUBAI_DAY);
  });
});
