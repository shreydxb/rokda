import { addMonthsClamped, isPosted, parseDay, startOfDay } from './day';
import { isTransfer } from './transactionKind';
import { amountInCategory, inCategory } from './splits';

const CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'];

// The nth occurrence of a schedule, always measured from the stored anchor
// date rather than by repeatedly stepping the previous result. Stepping loses
// the anchor day in short months: Jan 31 advanced monthly became Mar 3 because
// "Feb 31" overflowed, and every later occurrence inherited the drift (QA-07).
//
// intervalCount generalises "every quarter"/"every year" into "every N of
// this unit" -- a bill due every 2 months (rent, in this household's real
// case) isn't quarterly, and forcing it into the closest built-in cadence
// would silently mismatch its actual due dates. Defaults to 1, which is
// exactly the old fixed weekly/monthly/quarterly/yearly behaviour.
export function occurrenceAt(anchorDate, cadence, n, intervalCount = 1) {
  const anchor = parseDay(anchorDate);
  const every = Math.max(1, Number(intervalCount) || 1);
  if (cadence === 'weekly') {
    const d = new Date(anchor);
    d.setDate(d.getDate() + 7 * every * n);
    return d;
  }
  if (cadence === 'monthly') return addMonthsClamped(anchor, every * n);
  if (cadence === 'quarterly') return addMonthsClamped(anchor, 3 * every * n);
  if (cadence === 'yearly') return addMonthsClamped(anchor, 12 * every * n);
  return anchor;
}

// Rolls a (possibly past) next_due_date forward by cadence until it's today
// or later, so a bill paid last month still shows correctly without the
// user having to bump the stored date after every payment.
export function rollForward(dateStr, cadence, now = new Date(), intervalCount = 1) {
  const today = startOfDay(now);
  for (let n = 0; n < 1000; n++) {
    const occurrence = occurrenceAt(dateStr, cadence, n, intervalCount);
    if (occurrence >= today) return occurrence;
  }
  return occurrenceAt(dateStr, cadence, 0, intervalCount);
}

// EVERY occurrence inside the window, not just the first. A weekly bill in a
// 30-day window is five commitments; returning one understated what the
// household had already committed to (QA-07).
export function occurrencesInWindow(dateStr, cadence, days, now = new Date(), intervalCount = 1) {
  const today = startOfDay(now);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + days);
  const occurrences = [];
  for (let n = 0; n < 1000; n++) {
    const occurrence = occurrenceAt(dateStr, cadence, n, intervalCount);
    if (occurrence > horizon) break;
    if (occurrence >= today) occurrences.push(occurrence);
  }
  return occurrences;
}

// How many days either side of its date a payment still counts as this
// occurrence. A bill is paid on or near its date; a salary moves with bank
// holidays and payroll cut-offs, so expected income gets a wider window.
export function matchWindowDays(row) {
  return Number(row.amount) > 0 ? 10 : 5;
}

// Whether a transaction settles one occurrence of a reminder (a bill or an
// expected income). The one rule every screen uses (outside review, B-02).
// It is stricter than the bot's own check, which ignores direction, owner
// and whether a record has posted. It settles only if it
//   - has landed: a record dated after today is planned, not paid;
//   - moves money the reminder's way: out for a bill, in (and not a refund
//     or a transfer) for an income;
//   - is on the reminder's account, and in its category, when it names them
//     (a transfer, or a split record with a line in it, counts as in it);
//   - is the reminder's owner's, or shared, when the reminder is personal;
//   - falls within the reminder's window of the occurrence's date, at an
//     amount within 20% of the reminder's: for a split record, its lines in
//     the reminder's category, not the whole record (round 2 of the outside
//     review).
// Each copy of this used to drop a different condition, so a planned
// salary, a refund or another member's payment could tick a bill off.
export function settlesReminder(row, t, due, now = new Date()) {
  if (!t?.occurred_at || !isPosted(t, now)) return false;
  const expected = Number(row.amount);
  const amount = Number(t.amount);
  const rightWay = expected < 0 ? amount < 0 : amount > 0 && t.kind !== 'refund' && !isTransfer(t);
  if (!rightWay) return false;
  if (row.account_id && t.account_id !== row.account_id) return false;
  // A transfer has no category (a card bill is paid by one), and a split
  // record's categories are on its lines: either counts when a line is in
  // the reminder's category (the fresh review of group 3).
  if (row.category_id && !isTransfer(t) && !inCategory(t, row.category_id)) return false;
  const paidAmount = row.category_id && !isTransfer(t) ? amountInCategory(t, row.category_id) : amount;
  if (!row.is_shared && row.owner_member_id && !t.is_shared && t.owner_member_id != null && t.owner_member_id !== row.owner_member_id) return false;
  const days = Math.abs(Math.round((startOfDay(parseDay(t.occurred_at)) - startOfDay(due)) / 86400000));
  if (days > matchWindowDays(row)) return false;
  return Math.abs(Math.abs(paidAmount) - Math.abs(expected)) <= Math.abs(expected) * 0.2;
}

export function upcomingItems(rows, days, now = new Date()) {
  return rows
    .filter((r) => r.active !== false)
    .flatMap((r) =>
      occurrencesInWindow(r.next_due_date, r.cadence, days, now, r.interval_count)
        // A schedule with an end date (the last EMI, the last premium) has no
        // occurrences after it.
        .filter((dueDate) => !r.ends_on || dueDate <= parseDay(r.ends_on))
        .map((dueDate, index) => ({
          ...r,
          dueDate,
          // Rows can now appear more than once in a window, so they need a key
          // that distinguishes the occurrences.
          occurrenceKey: `${r.id}@${dueDate.getFullYear()}-${dueDate.getMonth() + 1}-${dueDate.getDate()}#${index}`,
        })),
    )
    .sort((a, b) => a.dueDate - b.dueDate);
}

// Whether a posted transaction already settles this bill/income's current
// due occurrence (settlesReminder above). Merchant text isn't checked: it's
// too inconsistent between a bank SMS and a manual entry to be a reliable
// signal here.
//
// rollForward always lands on a FUTURE-or-today occurrence (it assumes
// every earlier cycle was already paid, which is exactly the display-only
// convenience it exists for -- see its own comment). Checking payment
// status needs the opposite: the occurrence one cadence step BEHIND that,
// which is the cycle that just came due and hasn't been confirmed paid yet.
// If the schedule's very first occurrence hasn't even arrived (n === 0, the
// anchor itself is still in the future), there is no past cycle to check --
// only "upcoming" applies.
export function billStatus(row, transactions, now = new Date()) {
  const today = startOfDay(now);
  let n = 0;
  let occurrence = occurrenceAt(row.next_due_date, row.cadence, 0, row.interval_count);
  while (occurrence < today && n < 1000) {
    n += 1;
    occurrence = occurrenceAt(row.next_due_date, row.cadence, n, row.interval_count);
  }
  const isPastCycle = n > 0;
  const due = isPastCycle ? occurrenceAt(row.next_due_date, row.cadence, n - 1, row.interval_count) : occurrence;
  // Past its last date, a schedule has nothing left to pay.
  if (row.ends_on && due > parseDay(row.ends_on)) return { label: 'Ended', tone: 'mute', needsAction: false, posted: false, due: null };

  const windowEnd = new Date(due);
  windowEnd.setDate(windowEnd.getDate() + matchWindowDays(row));
  const posted = transactions.some((t) => settlesReminder(row, t, due, now));
  if (posted) return { label: 'Posted', tone: 'pos', needsAction: false, posted: true, due };
  // Income can still arrive a few days after its date without anything being
  // wrong: it is only late once its window has passed.
  if (isPastCycle && Number(row.amount) > 0 && today <= windowEnd) return { label: 'Expected', tone: 'mute', needsAction: false, posted: false, due };
  if (isPastCycle) return { label: 'Late', tone: 'neg', needsAction: true, posted: false, due };

  const daysUntil = Math.round((due - today) / 86400000);
  if (daysUntil <= 3) return { label: 'Due soon', tone: 'warn', needsAction: true, posted: false, due };
  return { label: 'Upcoming', tone: 'mute', needsAction: false, posted: false, due };
}

// Whether a schedule has had its last occurrence: its next one would fall
// after its end date.
export function hasEnded(row, now = new Date()) {
  return !!row.ends_on && rollForward(row.next_due_date, row.cadence, now, row.interval_count) > parseDay(row.ends_on);
}

// The amount in the currency it is set in: "₹89,554" for a premium in rupees.
// Null for an AED schedule, whose `amount` already is that figure.
export function nativeAmountLabel(row) {
  if (!row.currency || row.currency === 'AED' || row.native_amount == null) return null;
  const symbol = { INR: '₹', USD: '$' }[row.currency] ?? `${row.currency} `;
  const locale = row.currency === 'INR' ? 'en-IN' : 'en-US';
  return `${symbol}${Math.abs(Number(row.native_amount)).toLocaleString(locale, { maximumFractionDigits: 0 })}`;
}

export { CADENCES };
