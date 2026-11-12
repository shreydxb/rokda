import { describe, it, expect, vi, afterEach } from 'vitest';
import { amountFigures, buildEdits, estimateNote, foreignOf, initialForm, signedNative, transactionPayload } from './transactionForm';

const ACCOUNTS = [
  { id: 'bank', name: 'Bank' },
  { id: 'card', name: 'Bank card' },
];
const CATEGORIES = [
  { id: 'food', name: 'Food' },
  { id: 'fun', name: 'Fun' },
];
const MEMBERS = [{ id: 'm1', display_name: 'Partner' }];
const EXPENSE = { id: 't1', kind: 'expense', amount: -100, merchant: 'Shop', occurred_at: '2026-10-02', account_id: 'bank', category_id: 'food', is_shared: true, owner_member_id: null, note: null, needs_review: false, currency: 'AED', native_amount: null };
const DEPS = { accounts: ACCOUNTS, categories: CATEGORIES, members: MEMBERS };

afterEach(() => vi.useRealTimers());

describe('initialForm', () => {
  it('starts a new entry as a shared expense in AED on the first account, dated today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T08:00:00Z'));
    expect(initialForm(null, ACCOUNTS)).toEqual({
      type: 'expense', amount: '', merchant: '', occurred_at: '2026-10-05', account_id: 'bank', category_id: '', owner: 'shared', note: '', needs_review: false, entry_currency: 'AED', aed_debited: '',
    });
  });

  it('opens a refund as a refund, its amount unsigned', () => {
    const form = initialForm({ ...EXPENSE, kind: 'refund', amount: 75 }, ACCOUNTS);
    expect(form).toMatchObject({ type: 'refund', amount: '75', owner: 'shared' });
  });

  it('opens a payment in rupees in rupees, with the AED debited beside it, or blank while that is an estimate', () => {
    const rupees = { ...EXPENSE, currency: 'INR', native_amount: -2350, amount: -100, aed_estimated: false };
    expect(initialForm(rupees, ACCOUNTS)).toMatchObject({ entry_currency: 'INR', amount: '2350', aed_debited: '100' });
    expect(initialForm({ ...rupees, aed_estimated: true }, ACCOUNTS)).toMatchObject({ aed_debited: '' });
  });
});

describe('amountFigures', () => {
  const form = (over) => ({ ...initialForm(EXPENSE, ACCOUNTS), ...over });

  it('counts an AED amount as it is typed', () => {
    expect(amountFigures(form({ amount: '42.5' }), [], null)).toMatchObject({ foreign: false, amountAed: 42.5, aedEstimated: false, amountError: '' });
  });

  it('counts the AED debited when it is given, and estimates it otherwise', () => {
    expect(amountFigures(form({ entry_currency: 'USD', amount: '10', aed_debited: '37' }), [], null)).toMatchObject({ foreign: true, debited: 37, amountAed: 37, aedEstimated: false });
    expect(amountFigures(form({ entry_currency: 'USD', amount: '10', aed_debited: '' }), [], null)).toMatchObject({ debited: null, amountAed: 36.73, aedEstimated: true });
  });

  it('says what is wrong with the amount', () => {
    expect(amountFigures(form({ amount: '' }), [], null).amountError).toBe('Enter an amount greater than zero.');
    expect(amountFigures(form({ entry_currency: 'USD', amount: '10', aed_debited: '0' }), [], null).amountError).toMatch(/^Enter the AED debited as an amount greater than zero/);
    expect(amountFigures(form({ entry_currency: 'INR', amount: '10', aed_debited: '' }), [], null).amountError).toBe('No exchange rate for INR on that date. Enter the AED debited.');
  });
});

describe('transactionPayload', () => {
  const figures = { amountAed: 100, typed: 100, foreign: false, aedEstimated: false };

  it('writes the form as a signed AED record, owned as chosen', () => {
    const payload = transactionPayload({ ...initialForm(EXPENSE, ACCOUNTS), owner: 'm1', merchant: ' Shop ', note: '' }, figures, { householdId: 'h1' });
    expect(payload).toEqual({
      household_id: 'h1', account_id: 'bank', category_id: 'food', amount: -100, kind: 'expense', currency: 'AED', native_amount: null, aed_estimated: false,
      merchant: 'Shop', note: null, occurred_at: '2026-10-02', is_shared: false, owner_member_id: 'm1', needs_review: false,
    });
  });

  it('keeps the amount paid in another currency, signed like the record', () => {
    const payload = transactionPayload({ ...initialForm(EXPENSE, ACCOUNTS), entry_currency: 'USD', amount: '10' }, { amountAed: 36.73, typed: 10, foreign: true, aedEstimated: true }, { householdId: 'h1' });
    expect(payload).toMatchObject({ amount: -36.73, currency: 'USD', native_amount: -10, aed_estimated: true });
  });

  it('leaves a split\'s category, and an edited split\'s amount, to its lines', () => {
    const form = initialForm(EXPENSE, ACCOUNTS);
    expect(transactionPayload(form, figures, { householdId: 'h1', splitting: true })).toMatchObject({ category_id: null, amount: -100 });
    expect(transactionPayload(form, figures, { householdId: 'h1', splitting: true, editing: true })).not.toHaveProperty('amount');
  });

  it('sends no category for a refund that follows its purchase', () => {
    expect(transactionPayload(initialForm(EXPENSE, ACCOUNTS), figures, { householdId: 'h1', followsPurchase: true })).not.toHaveProperty('category_id');
  });
});

describe('buildEdits', () => {
  it('records nothing for a refund saved unchanged, stored positive', () => {
    const refund = { ...EXPENSE, kind: 'refund', amount: 75 };
    expect(buildEdits(refund, initialForm(refund, ACCOUNTS), 75, DEPS)).toEqual([]);
  });

  it('records a change of kind, category, amount, date, account, merchant and owner, in words', () => {
    const form = { ...initialForm(EXPENSE, ACCOUNTS), type: 'income', category_id: 'fun', occurred_at: '2026-10-03', account_id: 'card', merchant: 'Other', owner: 'm1' };
    expect(buildEdits(EXPENSE, form, 120, DEPS)).toEqual([
      { field: 'kind', old_value: 'Expense', new_value: 'Income' },
      { field: 'category', old_value: 'Food', new_value: 'Fun' },
      { field: 'amount', old_value: '−100', new_value: '+120' },
      { field: 'date', old_value: '2 Oct 2026', new_value: '3 Oct 2026' },
      { field: 'account', old_value: 'Bank', new_value: 'Bank card' },
      { field: 'merchant', old_value: 'Shop', new_value: 'Other' },
      { field: 'scope', old_value: 'Shared', new_value: 'Partner' },
    ]);
  });

  it('leaves a category change to the split that makes it', () => {
    const form = { ...initialForm(EXPENSE, ACCOUNTS), category_id: '' };
    expect(buildEdits(EXPENSE, form, -100, { ...DEPS, splitChanging: true })).toEqual([]);
  });

  it('records the amount paid in another currency', () => {
    const form = initialForm(EXPENSE, ACCOUNTS);
    expect(buildEdits(EXPENSE, form, -100, { ...DEPS, savedNative: { currency: 'USD', amount: -27.23 } })).toEqual([
      { field: 'native_amount', old_value: 'AED only', new_value: 'USD −27.23' },
    ]);
  });
});

describe('estimateNote', () => {
  it('names the rate an estimate used', () => {
    expect(estimateNote({ source: 'peg' }, 'USD')).toBe('the dollar peg (1 USD = 3.6725 AED)');
    expect(estimateNote({ source: 'current', rate: 23.5 }, 'INR')).toBe("today's rate, 1 AED = 23.5 INR, as none is on record for that date");
    expect(estimateNote({ source: 'history', rate: 23.5, rateDay: '2026-09-02' }, 'INR')).toBe('1 AED = 23.5 INR, the rate on 2 Sept 2026');
  });
});

describe('foreignOf and signedNative', () => {
  it('tell a record made in another currency, and sign its amount like the record', () => {
    expect(foreignOf(EXPENSE)).toBe(false);
    expect(foreignOf({ ...EXPENSE, currency: 'INR', native_amount: -10 })).toBe(true);
    expect(signedNative(10, 'expense')).toBe(-10);
    expect(signedNative(-10, 'refund')).toBe(10);
    expect(signedNative(null, 'expense')).toBeNull();
  });
});
