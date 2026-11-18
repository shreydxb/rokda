import { parseDay } from './day';
import { formatMoney } from './money';
import { accountHref, holdingHref, tabHref } from './activityLink';

// Overview's To do (the revamp, phase 3; review S-overview-1 and N13): the
// one list of everything waiting on someone, from the checks the app already
// makes. Needs attention's items (lib/attention.js), the latest statement to
// check on each card (lib/statements.js), dividends' questions
// (lib/dividendSummary.js needsYou) and goals due within 3 years and short of
// cash (the Plan's own rule, planning/usePlanFigures.js). Each row is a name,
// a short status and one button named for the job; where the job has its
// own place, the button opens it.

export const TODO_GROUPS = ['Today', 'Month end', 'Planning'];

const TONE_RANK = { neg: 0, warn: 1, neutral: 2 };
const toneOf = (severity) => (severity === 'urgent' ? 'neg' : severity === 'warn' ? 'warn' : 'neutral');
const link = (label, href) => ({ kind: 'link', label, href });
const day = (iso) => parseDay(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace('Sept', 'Sep');

function fromAttention(item) {
  const base = { id: item.id, title: item.name, status: item.status, tone: toneOf(item.severity) };
  switch (item.kind) {
    case 'review':
      return { ...base, group: 'Today', title: item.tx?.merchant ?? 'Transaction', status: 'Needs a look', tone: 'warn', action: { kind: 'review', tx: item.tx } };
    case 'missing_recurring':
      // A bill that has not posted is late; an autopay one only waits for
      // its confirmation.
      // Dated the day it was due, so the payment settles it.
      return { ...base, group: 'Today', tone: item.late ? 'neg' : 'warn', action: { kind: 'mark-paid', label: item.income ? 'Mark received' : 'Mark paid', recurringId: item.recurringId, dueOn: item.dueOn } };
    case 'card_due':
      return { ...base, group: 'Today', action: link('Open card', item.accountId ? accountHref(item.accountId) : '/wealth') };
    case 'balance_unset':
      return { ...base, group: 'Today', action: link('Confirm balance', item.accountId ? accountHref(item.accountId, { view: 'details' }) : '/wealth') };
    case 'stale_holding':
      return { ...base, group: 'Today', action: link('Update price', item.holdingId ? holdingHref(item.holdingId) : tabHref('/wealth', 'investments')) };
    case 'month_close':
      return { ...base, group: 'Month end', action: link('Close month', tabHref('/money', 'monthend', item.month ? { month: item.month } : {})) };
    case 'backup':
      return { ...base, group: 'Month end', action: link('Record backup', tabHref('/settings', 'backups')) };
    case 'yearly_check':
      return { ...base, group: 'Planning', action: link('Open notes', tabHref('/planning', 'notes')) };
    // A category running high is a finding, not a decision: What changed.
    default:
      return null;
  }
}

const NEEDS_CHECK = new Set(['waiting', 'unchecked', 'mismatch']);

// The latest statement to check on each card, with how many older ones also
// wait: a backlog of old statements is one row, not six.
function fromStatements(rows) {
  const byCard = new Map();
  for (const r of rows) {
    if (!NEEDS_CHECK.has(r.status)) continue;
    const list = byCard.get(r.account.id) ?? [];
    list.push(r);
    byCard.set(r.account.id, list);
  }
  return [...byCard.values()].map((list) => {
    const [latest, ...older] = [...list].sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1));
    const mismatch = latest.status === 'mismatch';
    return {
      id: `statement-${latest.account.id}-${latest.statementDate}`,
      group: 'Month end',
      title: `${latest.account.name} statement`,
      status: `${mismatch ? "Doesn't match" : 'To check'} · ${day(latest.periodStart)} – ${day(latest.statementDate)}${older.length ? ` · ${older.length} older` : ''}`,
      tone: mismatch ? 'neg' : 'warn',
      // Month end's running month lists every statement still open (the
      // revamp, phase 4d).
      action: link('Check', tabHref('/money', 'monthend')),
    };
  });
}

const QUESTION_STATUS = { one_off: 'One-off question', flagged: 'Needs a look', split_not_traded: 'Split not in trades', add_by_hand: 'Add by hand' };

function fromDividends(questions, holdings) {
  const names = new Map(holdings.map((h) => [h.id, h.name]));
  return questions.map((q, i) => ({
    id: `dividend-${q.kind}-${q.eventId ?? q.dividendId ?? q.holdingId}-${i}`,
    group: 'Today',
    title: `${names.get(q.holdingId) ?? 'Holding'} dividend`,
    status: QUESTION_STATUS[q.kind] ?? 'Needs an answer',
    tone: 'warn',
    action: link('Answer', tabHref('/wealth', 'dividends')),
  }));
}

function fromGoals(goalsShort) {
  return goalsShort.map((r) => ({
    id: `goal-${r.goal.id}`,
    group: 'Planning',
    title: r.goal.name,
    // Planning's figures are in dirhams whatever the display currency.
    status: `Short of cash · AED ${formatMoney(r.remaining)} to set aside`,
    tone: 'warn',
    // The goal itself, by its address (the revamp, phase 6b).
    action: link('Open goal', tabHref('/planning', 'goals', { goal: r.goal.id })),
  }));
}

export function buildTodo({ attention = [], statements = [], dividendQuestions = [], holdings = [], goalsShort = [] } = {}) {
  const rows = [...attention.map(fromAttention).filter(Boolean), ...fromStatements(statements), ...fromDividends(dividendQuestions, holdings), ...fromGoals(goalsShort)];
  // Groups in order, the most pressing first within each, otherwise as built.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => TODO_GROUPS.indexOf(a.r.group) - TODO_GROUPS.indexOf(b.r.group) || TONE_RANK[a.r.tone] - TONE_RANK[b.r.tone] || a.i - b.i)
    .map(({ r }) => r);
}
