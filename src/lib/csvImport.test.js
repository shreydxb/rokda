import { describe, expect, it } from 'vitest';
import {
  commitPayload,
  dateRange,
  detectDateOrder,
  detectDecimal,
  findHeader,
  guessMapping,
  parseAmount,
  parseCsv,
  parseDate,
  readRows,
  reconcile,
  reviewRows,
  rowProblem,
  withImportKeys,
} from './csvImport';

// Synthetic statements only: generic shops, round figures.
const CARD = { id: 'card', name: 'Bank card', type: 'credit_card', currency: 'AED' };
const BANK = { id: 'bank', name: 'Current account', type: 'checking', currency: 'AED' };
const RUPEES = { id: 'nre', name: 'Rupee account', type: 'savings', currency: 'INR' };

// Parse, map and read a file the way the screen does.
function read(text, overrides = {}, account = CARD) {
  const { rows } = parseCsv(text);
  const header = findHeader(rows);
  const mapping = guessMapping(rows[header]);
  const body = rows.slice(header + 1);
  const dates = detectDateOrder(body.map((r) => r[mapping.date]));
  const decimal = detectDecimal(body.map((r) => r[mapping.amountMode === 'split' ? mapping.debit : mapping.amount]));
  return withImportKeys(readRows(rows, header, { ...mapping, dateOrder: dates.order, decimal, outPositive: false, ...overrides }), account);
}

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks, and drops blank lines', () => {
    const { rows, delimiter } = parseCsv('﻿Date,Description,Amount\r\n02/09/2026,"Grocer, Main St",-120.50\r\n\r\n03/09/2026,"The ""Corner"" Shop\nBranch 2",-15\n');
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      ['Date', 'Description', 'Amount'],
      ['02/09/2026', 'Grocer, Main St', '-120.50'],
      ['03/09/2026', 'The "Corner" Shop\nBranch 2', '-15'],
    ]);
  });

  it('finds a semicolon or tab delimiter', () => {
    expect(parseCsv('Datum;Text;Betrag\n02.09.2026;Bakery;-1.234,50\n').delimiter).toBe(';');
    expect(parseCsv('Date\tDetails\tAmount\n2026-09-02\tBakery\t-12\n').delimiter).toBe('\t');
  });
});

describe('columns', () => {
  it('finds the header below lines about the account', () => {
    const { rows } = parseCsv('Account,Current account\nPeriod,September\n\nTransaction Date,Value Date,Narration,Debit,Credit,Balance\n02/09/2026,03/09/2026,Grocer,120.50,,1000\n');
    const header = findHeader(rows);
    expect(header).toBe(2);
    expect(guessMapping(rows[header])).toEqual({ date: 0, description: 2, amount: -1, debit: 3, credit: 4, currency: -1, amountMode: 'split' });
  });

  it('takes one signed amount column when there is one', () => {
    expect(guessMapping(['Date', 'Description', 'Amount', 'Currency'])).toMatchObject({ date: 0, description: 1, amount: 2, currency: 3, amountMode: 'single' });
  });
});

describe('dates', () => {
  it('reads day-first, month-first, year-first and month names', () => {
    expect(parseDate('02/09/2026', 'DMY')).toBe('2026-09-02');
    expect(parseDate('09/02/2026', 'MDY')).toBe('2026-09-02');
    expect(parseDate('2026-09-02', 'DMY')).toBe('2026-09-02');
    expect(parseDate('02-Sep-26', 'MDY')).toBe('2026-09-02');
    expect(parseDate('Sep 2, 2026', 'DMY')).toBe('2026-09-02');
    expect(parseDate('02/09/2026 14:30', 'DMY')).toBe('2026-09-02');
  });

  it('refuses what is not a date', () => {
    expect(parseDate('31/02/2026', 'DMY')).toBeNull();
    expect(parseDate('13/13/2026', 'DMY')).toBeNull();
    expect(parseDate('yesterday', 'DMY')).toBeNull();
    expect(parseDate('', 'DMY')).toBeNull();
  });

  it('says when a file\'s dates read correctly either way round', () => {
    expect(detectDateOrder(['02/09/2026', '05/09/2026'])).toEqual({ order: 'DMY', ambiguous: true, readable: true });
    expect(detectDateOrder(['02/09/2026', '25/09/2026'])).toEqual({ order: 'DMY', ambiguous: false, readable: true });
    expect(detectDateOrder(['09/25/2026'])).toEqual({ order: 'MDY', ambiguous: false, readable: true });
    expect(detectDateOrder(['2026-09-02'])).toMatchObject({ ambiguous: false, readable: true });
  });
});

describe('amounts', () => {
  it('reads signs, brackets, markers, currency and separators', () => {
    expect(parseAmount('-120.50')).toBe(-120.5);
    expect(parseAmount('120.50-')).toBe(-120.5);
    expect(parseAmount('(1,234.00)')).toBe(-1234);
    expect(parseAmount('AED 1,234.56')).toBe(1234.56);
    expect(parseAmount('500.00 CR')).toBe(500);
    expect(parseAmount('75.25DR')).toBe(-75.25);
    expect(parseAmount('1.234,50', ',')).toBe(1234.5);
    expect(parseAmount('-12,5', ',')).toBe(-12.5);
  });

  it('refuses what is not a number', () => {
    expect(parseAmount('12.3.4')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });

  it('tells a decimal comma from a thousands comma', () => {
    expect(detectDecimal(['1.234,50', '-12,00'])).toBe(',');
    expect(detectDecimal(['1,234.50', '-12.00'])).toBe('.');
  });
});

describe('a card statement, read', () => {
  const statement = [
    'Transaction Date,Description,Amount',
    '02/09/2026,Grocer,120.50',
    '02/09/2026,Grocer,120.50',
    '05/09/2026,Shoe Shop,-40.00',
    '20/09/2026,Payment Received - Thank You,-500.00',
    '21/09/2026,Café,1O.00',
    '31/09/2026,Bakery,8.00',
    ',,',
  ].join('\n');
  // Card statements list purchases as positive amounts.
  const rows = read(statement, { outPositive: true });

  it('turns purchases into money out and says which lines it could not read', () => {
    expect(rows.map((r) => [r.line, r.date, r.amount, r.error])).toEqual([
      [2, '2026-09-02', -120.5, null],
      [3, '2026-09-02', -120.5, null],
      [4, '2026-09-05', 40, null],
      [5, '2026-09-20', 500, null],
      [6, '2026-09-21', null, 'The amount "1O.00" isn\'t a number.'],
      [7, null, 8 * -1, '"31/09/2026" isn\'t a date written day first (31/01/2026).'],
    ]);
  });

  it('keeps two identical purchases apart by their keys', () => {
    expect(rows[0].key).toBe('2026-09-02|-120.50|grocer');
    expect(rows[1].key).toBe('2026-09-02|-120.50|grocer#2');
    expect(rows[4].key).toBeNull();
  });

  it('suggests what each line becomes', () => {
    const review = reviewRows(rows, { account: CARD, transactions: [] });
    expect(review.map((r) => `${r.action} ${r.kind ?? '-'}`)).toEqual(['import expense', 'import expense', 'import refund', 'import transfer', 'skip -', 'skip -']);
    expect(rowProblem(review[3])).toBe('Choose the other account.');
  });

  it('compares the file with the statement, without writing off a difference', () => {
    // Owed 1,000 at the start and 701 at the end: 299 less owed, which the
    // readable lines explain exactly. Owing 709 instead leaves 8 unexplained,
    // shown as it is: the unreadable bakery line may be why.
    expect(reconcile(rows, { opening: 1000, closing: 701, account: CARD })).toEqual({ fileChange: 299, statementChange: 299, difference: 0, unreadable: 2 });
    expect(reconcile(rows, { opening: 1000, closing: 709, account: CARD })).toMatchObject({ statementChange: 291, difference: -8 });
    expect(reconcile(rows, { account: CARD })).toMatchObject({ fileChange: 299, statementChange: null, difference: null });
    expect(dateRange(rows)).toEqual({ start: '2026-09-02', end: '2026-09-20' });
  });
});

describe('reviewRows against what is already recorded', () => {
  const rows = read(['Date,Details,Debit,Credit', '02/09/2026,Grocer,120.50,', '03/09/2026,Fuel Station,60.00,', '25/09/2026,SALARY TRANSFER,,10000', '26/09/2026,Transfer to savings,2000,'].join('\n'), {}, BANK);

  it('skips a line already imported, and one that looks already recorded', () => {
    const transactions = [
      { id: 'a', account_id: 'bank', amount: -120.5, occurred_at: '2026-09-02', merchant: 'Grocer', import_key: '2026-09-02|-120.50|grocer' },
      { id: 'b', account_id: 'bank', amount: -60, occurred_at: '2026-09-04', merchant: 'Petrol', import_key: null },
    ];
    const review = reviewRows(rows, { account: BANK, transactions });
    expect(review[0]).toMatchObject({ action: 'skip', note: 'Already imported.', fixed: true });
    expect(review[1]).toMatchObject({ action: 'skip', twinId: 'b', note: 'Looks already recorded: Petrol on 4 Sept.' });
  });

  it('also catches a line imported before under different wording', () => {
    const transactions = [{ id: 'c', account_id: 'bank', amount: -120.5, occurred_at: '2026-09-02', merchant: 'GROCER MAIN ST', import_key: '2026-09-02|-120.50|grocer main st' }];
    expect(reviewRows(rows, { account: BANK, transactions })[0]).toMatchObject({ action: 'skip', twinId: 'c' });
  });

  it('files pay as income and joins a transfer to its recorded other side', () => {
    const transactions = [{ id: 's', account_id: 'savings', amount: 2000, kind: 'income', occurred_at: '2026-09-27', merchant: 'From current' }];
    const review = reviewRows(rows, { account: BANK, transactions });
    expect(review[2]).toMatchObject({ action: 'import', kind: 'income' });
    expect(review[3]).toMatchObject({ action: 'import', kind: 'transfer', pairId: 's', otherAccountId: 'savings' });
  });

  it('files a merchant by the household\'s rule first, then by how it was filed before', () => {
    const transactions = [{ id: 'h', account_id: 'card', amount: -20, occurred_at: '2026-08-01', merchant: 'Fuel Station', category_id: 'cat-fuel' }];
    const rules = [{ pattern: 'grocer', match_type: 'contains', category_id: 'cat-food', archived: false }];
    const review = reviewRows(rows, { account: BANK, transactions, rules });
    expect(review[0].category_id).toBe('cat-food');
    expect(review[1].category_id).toBe('cat-fuel');
  });
});

describe('commitPayload', () => {
  it('sends the kept rows in AED, with a transfer\'s other side, and refuses a row with a problem', () => {
    const review = [
      { line: 2, date: '2026-09-02', amount: -120.5, description: 'Grocer', key: 'k1', action: 'import', kind: 'expense', category_id: 'cat-food' },
      { line: 3, date: '2026-09-03', amount: -60, description: 'Fuel', key: 'k2', action: 'skip', kind: 'expense' },
      { line: 4, date: '2026-09-26', amount: -2000, description: 'Transfer', key: 'k3', action: 'import', kind: 'transfer', otherAccountId: 'savings' },
    ];
    expect(commitPayload(review, { account: BANK })).toEqual([
      { occurred_at: '2026-09-02', kind: 'expense', merchant: 'Grocer', import_key: 'k1', category_id: 'cat-food', amount: -120.5 },
      { occurred_at: '2026-09-26', kind: 'transfer', merchant: 'Transfer', import_key: 'k3', other_account_id: 'savings', amount: -2000 },
    ]);
    expect(() => commitPayload([{ ...review[2], otherAccountId: null }], { account: BANK })).toThrow('Choose the other account.');
    expect(() => commitPayload([{ ...review[0], amount: 5 }], { account: BANK })).toThrow('An expense is money out; this is money in.');
  });

  it('keeps a rupee account\'s amounts beside the AED, marked an estimate', () => {
    const review = [{ line: 2, date: '2026-09-02', amount: -2500, description: 'Electricity', key: 'k1', action: 'import', kind: 'expense' }];
    const fxHistory = [{ base: 'AED', quote: 'INR', day: '2026-09-01', rate: 25 }];
    expect(commitPayload(review, { account: RUPEES, fxHistory })).toEqual([
      { occurred_at: '2026-09-02', kind: 'expense', merchant: 'Electricity', import_key: 'k1', amount: -100, currency: 'INR', native_amount: -2500, aed_estimated: true },
    ]);
    expect(() => commitPayload(review, { account: RUPEES })).toThrow(/no INR rate/);
  });
});
