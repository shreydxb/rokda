import { scopedValue } from './scope';
import { matchWindowDays, rollForward, CADENCES } from './recurring';
import { trailingAverageByCategory } from './insights';
import { monthActualsByCategory } from './budget';
import { scopedHoldingValue, visibleHoldings } from './holdings';
import { daysSincePriced, isStale } from './valuation';
import { parseDay } from './day';
import { daysUntilDue, nextDueDate } from './creditCard';
import { balanceStatus } from './balance';
import { accountValueAed } from './accounts';
import { pendingClose } from './snapshots';
import { EXPORT_DUE_DAYS, backupStatus } from './backups';
import { activityHref, monthRange, tabHref } from './activityLink';
import { yearlyCheckItems } from './yearlyChecks';

function startOfDay(d) {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

// Inverse of recurring.js's step(): the occurrence one cadence before `date`.
function stepBack(date, cadence) {
  const nd = new Date(date);
  if (cadence === 'weekly') nd.setDate(nd.getDate() - 7);
  else if (cadence === 'monthly') nd.setMonth(nd.getMonth() - 1);
  else if (cadence === 'quarterly') nd.setMonth(nd.getMonth() - 3);
  else if (cadence === 'yearly') nd.setFullYear(nd.getFullYear() - 1);
  return nd;
}

const RECURRING_GRACE_DAYS = 3; // how many days late before we call it missing
const RECURRING_LOOKBACK_DAYS = 35; // stop flagging an occurrence this old
const MATCH_AMOUNT_TOLERANCE = 0.15; // 15%

// A recurring item whose most recently expected occurrence has passed with
// no transaction that looks like it, on the account it's tied to.
function missingRecurringItems(recurring, transactions, scopeMemberId, now) {
  const today = startOfDay(now);
  const items = [];
  for (const r of recurring) {
    if (r.active === false) continue;
    if (!(scopeMemberId === null || r.is_shared || r.owner_member_id === scopeMemberId)) continue;
    if (!CADENCES.includes(r.cadence)) continue;
    const nextDue = rollForward(r.next_due_date, r.cadence, now, r.interval_count);
    const prevDue = stepBack(nextDue, r.cadence);
    // Nothing is expected after a schedule's last date.
    if (r.ends_on && prevDue > parseDay(r.ends_on)) continue;
    const daysLate = Math.round((today - prevDue) / 86400000);
    // Income is only missing once its whole window has passed.
    const windowDays = matchWindowDays(r);
    if (daysLate < Math.max(RECURRING_GRACE_DAYS, windowDays > 5 ? windowDays : 0) || daysLate > RECURRING_LOOKBACK_DAYS) continue;

    const expectedAmount = Math.abs(Number(r.amount));
    const windowStart = new Date(prevDue.getTime() - windowDays * 86400000);
    const windowEnd = new Date(prevDue.getTime() + windowDays * 86400000);
    const matched = transactions.some((t) => {
      if (r.account_id && t.account_id !== r.account_id) return false;
      const d = parseDay(t.occurred_at);
      if (d < windowStart || d > windowEnd) return false;
      const amt = Math.abs(Number(t.amount));
      return Math.abs(amt - expectedAmount) <= expectedAmount * MATCH_AMOUNT_TOLERANCE;
    });
    if (matched) continue;

    const expected = prevDue.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    // An autopay bill leaves the bank on its own; what is missing is the
    // confirmation, which the bot asks for every morning (docs/decisions.md,
    // "Autopay bills are confirmed, not entered").
    items.push(
      r.autopay && Number(r.amount) < 0
        ? {
            id: `missing-recurring-${r.id}`,
            kind: 'missing_recurring',
            severity: 'warn',
            title: `${r.name}: debit not confirmed yet`,
            detail: `Autopay due ~${expected} · answer the bot's question on Telegram, or log it here`,
          }
        : {
            id: `missing-recurring-${r.id}`,
            kind: 'missing_recurring',
            severity: 'warn',
            title: `${r.name} hasn't posted`,
            detail: `Expected ~${expected} · no matching transaction in the ${windowDays * 2 + 1}-day window around it`,
          },
    );
  }
  return items;
}

const CARD_DUE_WINDOW_DAYS = 10;

// A credit card with a real due_day set, due soon, still carrying a balance.
function cardDueItems(accounts, scopeMemberId, now) {
  const items = [];
  for (const a of accounts) {
    if (a.type !== 'credit_card') continue;
    if (a.archived_at != null) continue; // closed card: nothing to chase
    if (!(scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId)) continue;
    if (!a.due_day) continue; // not set yet — nothing honest to say
    // A card in another currency with no AED conversion: `balance_aed ??
    // balance` used to report the native number as dirhams owed (QA #4).
    // There is nothing honest to say about the amount, so the item says that
    // instead of a figure -- the due date is still worth chasing.
    const aed = accountValueAed(a);
    const balance = aed === null ? null : scopedValue(aed, a, scopeMemberId);
    if (balance !== null && balance <= 0) continue; // nothing owed
    if (balance === null && Number(a.balance ?? 0) <= 0) continue; // nothing owed in its own currency either

    // Shared with the cards panel, and clamped to the month's length so a card
    // due on the 31st is due on 28 February (QA-07).
    const due = nextDueDate(a.due_day, now);
    const daysUntil = daysUntilDue(a.due_day, now);
    if (daysUntil > CARD_DUE_WINDOW_DAYS) continue;

    items.push({
      id: `card-due-${a.id}`,
      kind: 'card_due',
      severity: 'urgent',
      title: `${a.name} payment due ${daysUntil <= 0 ? 'today' : `in ${daysUntil}d`}`,
      detail:
        balance === null
          ? `Due ${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${a.currency} ${Number(a.balance ?? 0).toLocaleString('en-AE')} owed, not converted to AED, nothing recorded paid yet`
          : `Due ${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · AED ${balance.toLocaleString('en-AE')} owed, nothing recorded paid yet`,
    });
  }
  return items;
}

const ANOMALY_MIN_AVERAGE = 100; // ignore categories too small to matter
const ANOMALY_THRESHOLD = 1.5; // 50% over the prorated trailing average
const ANOMALY_MONTHS_BACK = 3;

// A category already running well above its own trailing average, prorated
// for how far into the month we are (so day 5 isn't compared to a full month).
function categoryAnomalyItems(transactions, categories, scopeMemberId, now) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const dayOfMonth = now.getDate();
  const fractionElapsed = dayOfMonth / daysInMonth;

  const { averages, monthsWithData } = trailingAverageByCategory(transactions, year, month, ANOMALY_MONTHS_BACK, scopeMemberId);
  if (monthsWithData < 2) return []; // not enough history to trust an average yet

  const actuals = monthActualsByCategory(transactions, year, month, scopeMemberId);
  const items = [];
  for (const [catId, actual] of actuals) {
    const avg = averages.get(catId);
    if (!avg || avg < ANOMALY_MIN_AVERAGE) continue;
    const expectedSoFar = avg * fractionElapsed;
    if (expectedSoFar <= 0 || actual < expectedSoFar * ANOMALY_THRESHOLD) continue;
    const name = categories.find((c) => c.id === catId)?.name ?? 'Uncategorised';
    items.push({
      id: `category-anomaly-${catId}`,
      kind: 'category_anomaly',
      categoryId: catId,
      severity: 'info',
      title: `${name} is running high this month`,
      detail: `AED ${Math.round(actual).toLocaleString('en-AE')} so far vs a trailing ${ANOMALY_MONTHS_BACK}-month average of AED ${Math.round(avg).toLocaleString('en-AE')}`,
    });
  }
  return items;
}

// Staleness is measured against priced_at — the date a valuation was actually
// confirmed as of — not against when the record was last touched. Reloading the
// Investments screen or renaming a holding leaves this warning standing
// (QA-04).
function staleHoldingItems(holdings, scopeMemberId, now) {
  const items = [];
  for (const h of visibleHoldings(holdings, scopeMemberId)) {
    if (!isStale(h, now)) continue;
    const daysSince = daysSincePriced(h, now);
    items.push({
      id: `stale-holding-${h.id}`,
      kind: 'stale_holding',
      severity: 'info',
      title: `${h.name} hasn't been repriced`,
      detail: daysSince === null
        ? `Value AED ${Math.round(scopedHoldingValue(h, scopeMemberId)).toLocaleString('en-AE')} · no valuation confirmed yet`
        : `Value AED ${Math.round(scopedHoldingValue(h, scopeMemberId)).toLocaleString('en-AE')} · valued ${daysSince}d ago`,
    });
  }
  return items;
}

// An account nobody has valued is a setup gap, not a zero. Overview said "All
// caught up" while every balance was unconfirmed (QA-02).
function unconfirmedBalanceItems(accounts, scopeMemberId, now) {
  const items = [];
  for (const a of accounts) {
    if (a.archived_at != null) continue;
    if (!(scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId)) continue;
    const status = balanceStatus(a, now);
    if (status === 'confirmed') continue;
    items.push({
      id: `balance-${a.id}`,
      kind: 'balance_unset',
      severity: status === 'unset' ? 'warn' : 'info',
      title: status === 'unset' ? `${a.name} has no confirmed balance` : `${a.name}'s balance is getting old`,
      detail:
        status === 'unset'
          ? 'Net worth treats it as zero until someone confirms what it actually is.'
          : `Last confirmed ${Math.floor((now - new Date(a.balance_as_of)) / 86400000)}d ago.`,
    });
  }
  return items;
}

// The month that just ended, until someone closes it (docs/decisions.md, "A
// month that has not closed says so"). Months close by hand, on purpose, and
// nothing reminded anyone: production had no closed month at all, so Net
// Worth had no history, and waiting would never have given it one. A
// household with no accounts has nothing to close yet.
function monthCloseItems(accounts, snapshots, now) {
  if (!accounts.some((a) => a.archived_at == null)) return [];
  const pending = pendingClose(snapshots, now);
  if (!pending) return [];
  const name = pending.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return [
    {
      id: `month-close-${pending.key}`,
      kind: 'month_close',
      severity: 'warn',
      title: `${name} hasn't been closed`,
      detail: 'Review it under Money → Review, then close it to keep its totals in history. Months close by hand; waiting does not close one.',
    },
  ];
}

// The household's only copy of its finances, until someone exports it
// (docs/decisions.md, "A backup is recorded, and an old one says so";
// SHR-238). Exports are taken by hand, so nothing else would notice one
// failing or stopping. A household with no open accounts has nothing to back
// up yet.
function backupItems(accounts, records, now) {
  if (!accounts.some((a) => a.archived_at == null)) return [];
  const status = backupStatus(records, now);
  const day = (record) => new Date(`${record.done_on}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const lastGood = status.lastPassedExport ? `The last one that passed was on ${day(status.lastPassedExport)}.` : 'No export has passed yet.';
  if (status.lastExportFailed) {
    return [{ id: 'backup-failed', kind: 'backup', severity: 'warn', title: 'The last backup export failed', detail: `Recorded for ${day(status.lastExport)}. ${lastGood}` }];
  }
  if (!status.exportDue) return [];
  return [
    {
      id: 'backup-due',
      kind: 'backup',
      severity: 'warn',
      title: status.lastPassedExport ? `The last backup is ${status.daysSinceExport} days old` : 'No backup has been recorded',
      detail: status.lastPassedExport
        ? `Taken on ${day(status.lastPassedExport)}; one is due every ${EXPORT_DUE_DAYS} days. Record the next under Settings → Backups.`
        : 'Take an export (docs/backup-restore.md) and record it under Settings → Backups.',
    },
  ];
}

// Every item here is computed fresh from real data each call — nothing is a
// fixed template, so which items appear (and how many) changes month to
// month with the household's actual conditions.
// Most pressing first: a payment due before anything stale, and among equals
// the order they were built in. Overview shows the first few of these and
// keeps the rest one tap away, so a long list does not push the page down.
const SEVERITY_RANK = { urgent: 0, warn: 1, info: 2 };
export const ATTENTION_PREVIEW_COUNT = 4;

export function sortAttention(items = []) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (SEVERITY_RANK[a.item.severity] ?? 3) - (SEVERITY_RANK[b.item.severity] ?? 3) || a.index - b.index)
    .map(({ item }) => item);
}

// What Overview shows: everything when expanded, otherwise the first
// ATTENTION_PREVIEW_COUNT, and how many are left out.
export function attentionPreview(items = [], expanded = false, count = ATTENTION_PREVIEW_COUNT) {
  const sorted = sortAttention(items);
  const shown = expanded ? sorted : sorted.slice(0, count);
  return { shown, hidden: sorted.length - shown.length };
}

export function buildAttentionItems({ transactions, recurring, accounts, holdings, categories, snapshots = [], backupRecords = [], yearlyChecks = [], scopeMemberId, now = new Date() }) {
  const reviewItems = transactions
    .filter((t) => t.needs_review && (scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId))
    .map((t) => ({ id: `review-${t.id}`, kind: 'review', severity: 'warn', tx: t }));

  return [
    ...reviewItems,
    ...cardDueItems(accounts, scopeMemberId, now),
    ...unconfirmedBalanceItems(accounts, scopeMemberId, now),
    ...missingRecurringItems(recurring, transactions, scopeMemberId, now),
    ...categoryAnomalyItems(transactions, categories, scopeMemberId, now),
    ...staleHoldingItems(holdings, scopeMemberId, now),
    ...monthCloseItems(accounts, snapshots, now),
    ...backupItems(accounts, backupRecords, now),
    ...yearlyCheckItems(yearlyChecks, now),
  ];
}

// Where each item's Open goes: the tab, and for a category running high, the
// month's records in that category, so the item opens the thing that resolves
// it rather than a screen's first tab (product review, 15 October).
export function attentionHref(item, now = new Date()) {
  switch (item.kind) {
    case 'missing_recurring':
      return tabHref('/money', 'recurring');
    case 'category_anomaly':
      return activityHref({ categoryId: item.categoryId, ...monthRange(now.getFullYear(), now.getMonth() + 1) });
    case 'card_due':
    case 'balance_unset':
      return tabHref('/wealth', 'accounts');
    case 'stale_holding':
      return tabHref('/wealth', 'investments');
    case 'month_close':
      return tabHref('/money', 'review');
    case 'backup':
      return tabHref('/settings', 'backups');
    case 'yearly_check':
      return tabHref('/planning', 'notes');
    default:
      return '/';
  }
}
