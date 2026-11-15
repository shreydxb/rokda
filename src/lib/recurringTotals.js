import { billStatus, hasEnded } from './recurring';
import { scopedValue } from './scope';

// Money -> Recurring's figures and words (the revamp, phase 4; the design
// note's decisions 1 and 3). The app's alone: the bot's shared schedule
// logic (lib/recurring.js and its applib copy) is untouched.

const MONTHS_PER = { monthly: 1, quarterly: 3, yearly: 12 };

// What a schedule costs (or brings in) a month on average, signed as its
// amount: a yearly bill is a twelfth of itself, a bill every two months
// half, a weekly one 52 weeks over 12 months.
export function monthlyEquivalent(row) {
  const amount = Number(row.amount) || 0;
  const every = Math.max(1, Number(row.interval_count) || 1);
  if (row.cadence === 'weekly') return (amount * 52) / 12 / every;
  return amount / ((MONTHS_PER[row.cadence] ?? 1) * every);
}

const UNIT = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };

// "Month", "Year", or "2 months" for one every other month.
export function everyLabel(row) {
  const unit = UNIT[row.cadence] ?? row.cadence;
  const every = Number(row.interval_count) || 1;
  return every > 1 ? `${every} ${unit}s` : unit.charAt(0).toUpperCase() + unit.slice(1);
}

// The status as Recurring words it (lib/recurring.js billStatus gives the
// state): Paid for a bill and Received for income once it is recorded; Not
// confirmed, in amber, for an autopay bill past its date with nothing
// recorded, since the money most likely left on time; the rest as they are,
// the quiet ones grey.
export function statusWords(row, status) {
  const income = Number(row.amount) > 0;
  if (status.label === 'Posted') return { label: income ? 'Received' : 'Paid', tone: 'pos' };
  if (status.label === 'Late' && row.autopay && !income) return { label: 'Not confirmed', tone: 'warn' };
  return { label: status.label, tone: status.tone === 'mute' ? 'neutral' : status.tone };
}

// The strip above the tables: fixed and variable bills a month, expected
// income a month, and the bills to mark paid, with how many of those are late
// and how many unconfirmed autopay. A schedule that has ended or is paused is
// not a commitment and is left out. In one person's view a shared schedule
// counts half and the other person's own not at all, as everywhere else.
export function recurringStrip(rows, transactions, scopeMemberId, now = new Date()) {
  const strip = { fixed: 0, fixedCount: 0, variable: 0, variableCount: 0, income: 0, toMarkPaid: 0, late: 0, unconfirmed: 0 };
  for (const row of rows) {
    if (row.active === false || hasEnded(row, now)) continue;
    const share = scopedValue(monthlyEquivalent(row), row, scopeMemberId);
    if (share === 0) continue;
    if (Number(row.amount) > 0) {
      strip.income += share;
      continue;
    }
    if (row.is_fixed) {
      strip.fixed += -share;
      strip.fixedCount += 1;
    } else {
      strip.variable += -share;
      strip.variableCount += 1;
    }
    const status = billStatus(row, transactions, now);
    if (!status.needsAction) continue;
    strip.toMarkPaid += 1;
    const words = statusWords(row, status);
    if (words.label === 'Late') strip.late += 1;
    if (words.label === 'Not confirmed') strip.unconfirmed += 1;
  }
  return strip;
}
