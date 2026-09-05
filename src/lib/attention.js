import { scopedValue } from './scope';
import { rollForward, CADENCES } from './recurring';
import { trailingAverageByCategory } from './insights';
import { monthActualsByCategory } from './budget';
import { scopedHoldingValue, visibleHoldings } from './holdings';
import { daysSincePriced, isStale } from './valuation';

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
const MATCH_WINDOW_DAYS = 5;

// A recurring item whose most recently expected occurrence has passed with
// no transaction that looks like it, on the account it's tied to.
function missingRecurringItems(recurring, transactions, scopeMemberId, now) {
  const today = startOfDay(now);
  const items = [];
  for (const r of recurring) {
    if (r.active === false) continue;
    if (!(scopeMemberId === null || r.is_shared || r.owner_member_id === scopeMemberId)) continue;
    if (!CADENCES.includes(r.cadence)) continue;
    const nextDue = rollForward(r.next_due_date, r.cadence, now);
    const prevDue = stepBack(nextDue, r.cadence);
    const daysLate = Math.round((today - prevDue) / 86400000);
    if (daysLate < RECURRING_GRACE_DAYS || daysLate > RECURRING_LOOKBACK_DAYS) continue;

    const expectedAmount = Math.abs(Number(r.amount));
    const windowStart = new Date(prevDue.getTime() - MATCH_WINDOW_DAYS * 86400000);
    const windowEnd = new Date(prevDue.getTime() + MATCH_WINDOW_DAYS * 86400000);
    const matched = transactions.some((t) => {
      if (r.account_id && t.account_id !== r.account_id) return false;
      const d = new Date(t.occurred_at);
      if (d < windowStart || d > windowEnd) return false;
      const amt = Math.abs(Number(t.amount));
      return Math.abs(amt - expectedAmount) <= expectedAmount * MATCH_AMOUNT_TOLERANCE;
    });
    if (matched) continue;

    items.push({
      id: `missing-recurring-${r.id}`,
      kind: 'missing_recurring',
      severity: 'warn',
      title: `${r.name} hasn't posted`,
      detail: `Expected ~${prevDue.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · no matching transaction in the ${MATCH_WINDOW_DAYS * 2 + 1}-day window around it`,
    });
  }
  return items;
}

const CARD_DUE_WINDOW_DAYS = 10;

// A credit card with a real due_day set, due soon, still carrying a balance.
function cardDueItems(accounts, scopeMemberId, now) {
  const today = startOfDay(now);
  const items = [];
  for (const a of accounts) {
    if (a.type !== 'credit_card') continue;
    if (a.archived_at != null) continue; // closed card: nothing to chase
    if (!(scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId)) continue;
    if (!a.due_day) continue; // not set yet — nothing honest to say
    const balance = scopedValue(a.balance, a, scopeMemberId);
    if (balance <= 0) continue; // nothing owed

    let due = new Date(today.getFullYear(), today.getMonth(), a.due_day);
    if (due < today) due = new Date(today.getFullYear(), today.getMonth() + 1, a.due_day);
    const daysUntil = Math.round((due - today) / 86400000);
    if (daysUntil > CARD_DUE_WINDOW_DAYS) continue;

    items.push({
      id: `card-due-${a.id}`,
      kind: 'card_due',
      severity: 'urgent',
      title: `${a.name} payment due ${daysUntil <= 0 ? 'today' : `in ${daysUntil}d`}`,
      detail: `Due ${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · AED ${balance.toLocaleString('en-AE')} owed, nothing recorded paid yet`,
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

// Every item here is computed fresh from real data each call — nothing is a
// fixed template, so which items appear (and how many) changes month to
// month with the household's actual conditions.
export function buildAttentionItems({ transactions, recurring, accounts, holdings, categories, scopeMemberId, now = new Date() }) {
  const reviewItems = transactions
    .filter((t) => t.needs_review && (scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId))
    .map((t) => ({ id: `review-${t.id}`, kind: 'review', severity: 'warn', tx: t }));

  return [
    ...reviewItems,
    ...cardDueItems(accounts, scopeMemberId, now),
    ...missingRecurringItems(recurring, transactions, scopeMemberId, now),
    ...categoryAnomalyItems(transactions, categories, scopeMemberId, now),
    ...staleHoldingItems(holdings, scopeMemberId, now),
  ];
}
