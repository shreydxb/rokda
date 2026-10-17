// Credit card statements and whether each was reconciled (docs/decisions.md,
// "A statement is reconciled, and Rokda records it").
//
// A card closes a statement on its statement day. The statement covers the
// days since the previous close, the day after it through the closing day
// itself, which is how the banks print it ("29 Mar to 28 Apr"). Someone then
// checks it against what Rokda recorded for the card, and
// statement_reconciliations records the outcome. These helpers work out which
// statements have closed and line them up with those records; the Telegram
// bot uses the same dates to know what to ask about.
import { atDayOfMonth, isPosted, parseDay, startOfDay } from './day';
import { spendDelta } from './transactionKind';

// A day as stored: YYYY-MM-DD, read in local time like every stored date.
export function isoDay(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The statements a card has closed before today, newest first. A statement
// closing today is not included: its last day's spending can still arrive,
// so it is asked about from tomorrow.
export function closedStatementDates(statementDay, today = new Date(), count = 1) {
  if (!statementDay) return [];
  const day = startOfDay(today);
  const year = day.getFullYear();
  let month = day.getMonth();
  let close = atDayOfMonth(year, month, statementDay);
  if (close >= day) {
    month -= 1;
    close = atDayOfMonth(year, month, statementDay);
  }
  const dates = [];
  while (dates.length < count) {
    dates.push(close);
    month -= 1;
    close = atDayOfMonth(year, month, statementDay);
  }
  return dates;
}

// The day after the previous statement closed: where this statement begins.
export function statementPeriodStart(statementDay, statementDate) {
  const close = parseDay(statementDate);
  const previous = atDayOfMonth(close.getFullYear(), close.getMonth() - 1, statementDay);
  return new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1);
}

// When a statement is due: the first due day on or after it closes. A card
// due on its statement day (paid in full automatically) is due the same day.
export function statementDueDate(statementDate, dueDay) {
  if (!dueDay) return null;
  const close = parseDay(statementDate);
  const sameMonth = atDayOfMonth(close.getFullYear(), close.getMonth(), dueDay);
  return sameMonth >= close ? sameMonth : atDayOfMonth(close.getFullYear(), close.getMonth() + 1, dueDay);
}

// The transactions Rokda recorded on a card over a statement's period, oldest
// first: what someone reviewing a statement goes through line by line.
export function statementTransactions(transactions, accountId, periodStart, statementDate, now = new Date()) {
  const from = parseDay(periodStart);
  const to = parseDay(statementDate);
  return transactions
    .filter((t) => t.account_id === accountId && isPosted(t, now))
    .filter((t) => {
      const d = parseDay(t.occurred_at);
      return d >= from && d <= to;
    })
    .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
}

// What Rokda recorded as spent on a card over a statement's period, refunds
// netted, the same arithmetic as every other spend total. Negative when
// refunds outweigh spending. Rounded to the cent, as a statement is.
export function recordedSpend(transactions, accountId, periodStart, statementDate, now = new Date()) {
  const total = statementTransactions(transactions, accountId, periodStart, statementDate, now).reduce((sum, t) => sum + spendDelta(t, Number(t.amount)), 0);
  return Math.round(total * 100) / 100;
}

const NEEDS_CHECK = new Set(['waiting', 'unchecked', 'mismatch']);

// The cards whose statements are listed: open credit cards with a statement day.
const statementCards = (accounts) => accounts.filter((a) => a.type === 'credit_card' && !a.archived_at && a.statement_day);

// One statement's row: its period, what was recorded about it, and what
// Rokda recorded on the card over that period.
function statementRow(account, close, byKey, transactions, now) {
  const statementDate = isoDay(close);
  const record = byKey.get(`${account.id}:${statementDate}`) ?? null;
  const periodStart = record?.period_start ?? isoDay(statementPeriodStart(account.statement_day, close));
  const lines = statementTransactions(transactions, account.id, periodStart, statementDate, now);
  const spend = recordedSpend(lines, account.id, periodStart, statementDate, now);
  const statementSpend = record?.statement_spend == null ? null : Number(record.statement_spend);
  return {
    account,
    statementDate,
    periodStart,
    dueDate: record?.due_date ?? (account.due_day ? isoDay(statementDueDate(close, account.due_day)) : null),
    status: record?.status ?? 'unchecked',
    record,
    recordedSpend: spend,
    transactions: lines,
    statementSpend,
    statementBalance: record?.statement_balance == null ? null : Number(record.statement_balance),
    difference: statementSpend == null ? null : Math.round((spend - statementSpend) * 100) / 100,
  };
}

// Statements still to be checked first, then the rest newest first.
function sortStatementRows(rows) {
  return rows.sort((a, b) => {
    const needA = NEEDS_CHECK.has(a.status) ? 0 : 1;
    const needB = NEEDS_CHECK.has(b.status) ? 0 : 1;
    if (needA !== needB) return needA - needB;
    if (a.statementDate !== b.statementDate) return a.statementDate < b.statementDate ? 1 : -1;
    return a.account.name.localeCompare(b.account.name);
  });
}

// One row per open card per recent statement, for Wealth -> Statements. A
// statement nobody has recorded anything about yet is "unchecked"; the bot
// creates the "waiting" record once it starts asking.
export function statementRows({ accounts = [], reconciliations = [], transactions = [], now = new Date(), perCard = 6 }) {
  const byKey = new Map(reconciliations.map((r) => [`${r.account_id}:${r.statement_date}`, r]));
  const rows = [];
  for (const account of statementCards(accounts)) {
    for (const close of closedStatementDates(account.statement_day, now, perCard)) rows.push(statementRow(account, close, byKey, transactions, now));
  }
  return sortStatementRows(rows);
}

// The statements that closed in one month (1-12), however long ago, for the
// monthly review's link to them: one per open card that had it by then, and
// only once it has closed (QA re-review, 17 October: the link opened the six
// most recent instead).
export function statementRowsForMonth({ accounts = [], reconciliations = [], transactions = [], now = new Date(), year, month }) {
  const byKey = new Map(reconciliations.map((r) => [`${r.account_id}:${r.statement_date}`, r]));
  const today = startOfDay(now);
  const rows = [];
  for (const account of statementCards(accounts)) {
    const close = atDayOfMonth(year, month - 1, account.statement_day);
    if (close >= today) continue;
    if (account.created_at && parseDay(account.created_at) > close) continue;
    rows.push(statementRow(account, close, byKey, transactions, now));
  }
  return sortStatementRows(rows);
}

// How many statements are still to be checked, for the tab's badge and the
// Overview attention list.
export function statementsToCheck(rows) {
  return rows.filter((r) => NEEDS_CHECK.has(r.status)).length;
}
