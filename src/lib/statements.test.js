import { describe, expect, it } from 'vitest';
import { closedStatementDates, isoDay, recordedSpend, statementDueDate, statementPeriodStart, statementRows, statementRowsForMonth, statementsToCheck, statementTransactions } from './statements';

const day = (s) => new Date(`${s}T12:00:00`);
const days = (dates) => dates.map(isoDay);

describe('closedStatementDates', () => {
  it('lists the statements closed before today, newest first', () => {
    expect(days(closedStatementDates(28, day('2026-10-12'), 3))).toEqual(['2026-09-28', '2026-08-28', '2026-07-28']);
    expect(days(closedStatementDates(2, day('2026-10-12'), 2))).toEqual(['2026-10-02', '2026-09-02']);
  });

  it('leaves out a statement closing today: its last day can still post', () => {
    expect(days(closedStatementDates(12, day('2026-10-12'), 1))).toEqual(['2026-09-12']);
    expect(days(closedStatementDates(12, day('2026-10-13'), 1))).toEqual(['2026-10-12']);
  });

  it('clamps a late statement day to short months and crosses the year', () => {
    expect(days(closedStatementDates(31, day('2026-03-10'), 2))).toEqual(['2026-02-28', '2026-01-31']);
    expect(days(closedStatementDates(15, day('2026-01-05'), 2))).toEqual(['2025-12-15', '2025-11-15']);
  });

  it('is empty for a card without a statement day', () => {
    expect(closedStatementDates(null, day('2026-10-12'))).toEqual([]);
  });
});

describe('statement period and due date', () => {
  it('starts the day after the previous close', () => {
    expect(isoDay(statementPeriodStart(28, '2026-04-28'))).toBe('2026-03-29');
    expect(isoDay(statementPeriodStart(1, '2026-03-01'))).toBe('2026-02-02');
    expect(isoDay(statementPeriodStart(31, '2026-03-31'))).toBe('2026-03-01');
  });

  it('is due on the first due day on or after the close', () => {
    expect(isoDay(statementDueDate('2026-09-28', 22))).toBe('2026-10-22');
    expect(isoDay(statementDueDate('2026-09-01', 26))).toBe('2026-09-26');
    // Paid in full on the statement day.
    expect(isoDay(statementDueDate('2026-10-02', 2))).toBe('2026-10-02');
    expect(statementDueDate('2026-10-02', null)).toBeNull();
  });
});

describe('recordedSpend', () => {
  const tx = [
    { account_id: 'card', occurred_at: '2026-08-29', amount: -100, kind: 'expense' },
    { account_id: 'card', occurred_at: '2026-09-28', amount: -50, kind: 'expense' },
    { account_id: 'card', occurred_at: '2026-09-10', amount: 20, kind: 'refund' },
    { account_id: 'card', occurred_at: '2026-08-28', amount: -999, kind: 'expense' },
    { account_id: 'card', occurred_at: '2026-09-29', amount: -999, kind: 'expense' },
    { account_id: 'other', occurred_at: '2026-09-10', amount: -999, kind: 'expense' },
  ];

  it('counts the period from its first day through the closing day, refunds netted', () => {
    expect(recordedSpend(tx, 'card', '2026-08-29', '2026-09-28', day('2026-10-12'))).toBe(130);
  });
});

describe('statementRows', () => {
  const card = { id: 'card', name: 'Bank card', type: 'credit_card', statement_day: 28, due_day: 22, archived_at: null };
  const now = day('2026-10-12');

  it('marks a statement nobody has looked at as unchecked, and lists it first', () => {
    const rows = statementRows({
      accounts: [card],
      reconciliations: [{ account_id: 'card', statement_date: '2026-08-28', status: 'reconciled', period_start: '2026-07-29', due_date: '2026-09-22', statement_spend: 100 }],
      transactions: [{ account_id: 'card', occurred_at: '2026-08-10', amount: -100, kind: 'expense' }],
      now,
      perCard: 2,
    });
    expect(rows.map((r) => [r.statementDate, r.status])).toEqual([
      ['2026-09-28', 'unchecked'],
      ['2026-08-28', 'reconciled'],
    ]);
    expect(rows[0].dueDate).toBe('2026-10-22');
    expect(rows[0].periodStart).toBe('2026-08-29');
    expect(rows[1].difference).toBe(0);
    expect(statementsToCheck(rows)).toBe(1);
  });

  it('shows the difference when the statement and Rokda disagree', () => {
    const rows = statementRows({
      accounts: [card],
      reconciliations: [{ account_id: 'card', statement_date: '2026-09-28', status: 'mismatch', period_start: '2026-08-29', statement_spend: 500 }],
      transactions: [{ account_id: 'card', occurred_at: '2026-09-01', amount: -450.25, kind: 'expense' }],
      now,
      perCard: 1,
    });
    expect(rows[0].difference).toBe(-49.75);
    expect(statementsToCheck(rows)).toBe(1);
  });

  it('skips closed cards, cards without a statement day, and other accounts', () => {
    const rows = statementRows({
      accounts: [
        { ...card, id: 'closed', archived_at: '2026-09-27T00:00:00Z' },
        { ...card, id: 'nodate', statement_day: null },
        { id: 'bank', name: 'Bank', type: 'checking', statement_day: 1 },
      ],
      now,
    });
    expect(rows).toEqual([]);
  });
});

describe('statementTransactions', () => {
  it('lists the card\'s posted transactions in the period, oldest first, and the total is to the cent', () => {
    const txs = [
      { id: 'b', account_id: 'c', amount: -0.1, kind: 'expense', occurred_at: '2026-09-20' },
      { id: 'a', account_id: 'c', amount: -0.2, kind: 'expense', occurred_at: '2026-09-01' },
      { id: 'x', account_id: 'other', amount: -5, kind: 'expense', occurred_at: '2026-09-05' },
      { id: 'y', account_id: 'c', amount: -5, kind: 'expense', occurred_at: '2026-08-28' },
    ];
    const lines = statementTransactions(txs, 'c', '2026-08-29', '2026-09-28', day('2026-10-12'));
    expect(lines.map((t) => t.id)).toEqual(['a', 'b']);
    expect(recordedSpend(txs, 'c', '2026-08-29', '2026-09-28', day('2026-10-12'))).toBe(0.3);
  });
});

describe('statementRowsForMonth', () => {
  const card = (id, statement_day, created_at = '2024-01-01T00:00:00Z') => ({ id, name: id, type: 'credit_card', statement_day, created_at, archived_at: null });

  it("lists each card's statement that closed in the month, however long ago", () => {
    const rows = statementRowsForMonth({ accounts: [card('A', 10), card('B', 28)], now: day('2026-10-17'), year: 2025, month: 3 });
    expect(rows.map((r) => `${r.account.id} ${r.statementDate}`)).toEqual(['B 2025-03-28', 'A 2025-03-10']);
  });

  it("leaves out a statement that hasn't closed yet and a card opened after it closed", () => {
    const rows = statementRowsForMonth({ accounts: [card('A', 10), card('B', 28), card('C', 5, '2026-10-06T00:00:00Z')], now: day('2026-10-17'), year: 2026, month: 10 });
    expect(rows.map((r) => r.account.id)).toEqual(['A']);
  });

  it('carries what was recorded about the statement', () => {
    const reconciliations = [{ account_id: 'A', statement_date: '2025-03-10', status: 'matched', statement_spend: 100 }];
    const [row] = statementRowsForMonth({ accounts: [card('A', 10)], reconciliations, now: day('2026-10-17'), year: 2025, month: 3 });
    expect(row.status).toBe('matched');
    expect(row.statementSpend).toBe(100);
  });
});
