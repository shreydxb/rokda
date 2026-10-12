// Autopay bills confirmed over Telegram (docs/decisions.md, "Autopay bills
// are confirmed, not entered").
//
// A bill on autopay leaves the bank account on its own, so nobody types it
// in. The bot asks on its due date whether it went out, and every morning
// after until someone answers. "yes", "paid", "deducted" or a 👍 records it;
// "not yet" or a 👎 means ask again tomorrow. This file decides which cycle is
// due and what an answer means; index.ts does the asking and the recording.
//
// Bot-only, like telegramConfirm.js: nothing in the web app answers a
// question over Telegram.
import { occurrenceAt } from './recurring.js';
import { parseDay, startOfDay } from './day.js';

// A calendar day as YYYY-MM-DD, read in local time like every other stored
// date (day.js).
export function dayString(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The cycle an autopay bill is in on `today`: the occurrence most recently
// due, on or before today, and the one after it. The bot asks from `due`
// until the day before `next`. Null before the schedule's first date, after
// its last one (ends_on), or for a cadence it does not know.
/**
 * @param {{ next_due_date: string, cadence: string, interval_count?: number | null, ends_on?: string | null }} row
 * @param {Date} [today]
 * @returns {{ due: string, next: string } | null}
 */
export function autopayCycle(row, today = new Date()) {
  if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(row?.cadence)) return null;
  const day = startOfDay(today);
  const every = row.interval_count ?? 1;
  // The stored date is the first one asked about: a cycle before it was never
  // set up in Rokda, or was already settled when it was moved forward.
  if (occurrenceAt(row.next_due_date, row.cadence, 0, every) > day) return null;
  let n = 0;
  while (n < 5000 && occurrenceAt(row.next_due_date, row.cadence, n + 1, every) <= day) n += 1;
  const due = occurrenceAt(row.next_due_date, row.cadence, n, every);
  if (row.ends_on && due > parseDay(row.ends_on)) return null;
  return { due: dayString(due), next: dayString(occurrenceAt(row.next_due_date, row.cadence, n + 1, every)) };
}

// "3 Oct", for the question.
export function shortDay(dateStr) {
  return parseDay(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function aed(amount) {
  return `AED ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// What the bot sends. The first question on the due date, and a shorter
// reminder each morning after it. Both say how to answer, because a reply
// that is not understood falls through to the bot's ordinary handling.
/**
 * @param {{ name: string, amount: number, accountName?: string | null, due: string }} bill
 * @param {{ reminder?: boolean }} [options]
 */
export function autopayQuestion(bill, { reminder = false } = {}) {
  const from = bill.accountName ? ` from ${bill.accountName}` : '';
  const head = reminder
    ? `Reminder: has ${bill.name} (${aed(bill.amount)}, due ${shortDay(bill.due)}) been deducted${from} yet?`
    : `${bill.name} (${aed(bill.amount)}) was due today, ${shortDay(bill.due)}. Has it been deducted${from}?`;
  return (
    `${head}\n` +
    'Reply "yes" or "paid", or react 👍, and I\'ll record it. ' +
    'If a different amount went out, reply with it, like "paid 2,050". ' +
    'Reply "not yet" and I\'ll ask again tomorrow morning.'
  );
}

// Words that, on their own or together, mean "it went out".
const PAID_WORDS = new Set([
  'yes', 'y', 'yep', 'yeah', 'yup', 'ya', 'yea', 'ok', 'okay', 'k', 'sure', 'correct', 'confirmed', 'confirm',
  'done', 'paid', 'deducted', 'debited', 'cleared', 'gone', 'went', 'out',
]);
// Words that, with any of the above, mean "not yet".
const NOT_WORDS = new Set([
  'no', 'n', 'nope', 'nah', 'not', 'yet', 'pending', 'still', 'didnt', 'didn', 'hasnt', 'hasn', 'havent', 'wasnt', 'isnt', 'never', 'nothing',
]);
// Words that carry no answer either way: "it's paid", "EMI has been
// deducted", "already paid today".
const FILLER_WORDS = new Set([
  'it', 'its', 'is', 'was', 'has', 'have', 'had', 'been', 'got', 'get', 'the', 'a', 'my', 'our', 'this', 'that', 'emi', 'car', 'loan',
  'payment', 'bill', 'already', 'all', 'just', 'today', 'yesterday', 'thanks', 'thank', 'you', 'thx', 'ty', 'aed', 'dhs', 'dirhams',
  'and', 'from', 'fab', 'bank', 'account', 'auto', 'autopay', 'debit', 'deduction', 'for', 'me', 'us', 'please', 'pls', 'of', 'month',
]);
const PAID_EMOJIS = new Set(['👍', '✅', '✔', '☑', '👌', '💯', '🙌', '👏']);
const NOT_EMOJIS = new Set(['👎', '❌', '✖', '⏳', '🚫']);

// Skin tones and the variation selector change how an emoji looks, not what
// it means.
function normaliseEmoji(text) {
  return text.replace(/[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u200D/gu, '');
}

// What a reaction means for an autopay question. A reaction always names the
// message, so a wider set than a typed answer is safe here.
export function autopayReactionDecision(emoji) {
  const e = normaliseEmoji(String(emoji ?? ''));
  if (PAID_EMOJIS.has(e)) return 'paid';
  if (NOT_EMOJIS.has(e)) return 'not_yet';
  return null;
}

// What a typed message means as an answer to an autopay question:
//   { decision: 'paid', amount }    it went out; `amount` when they gave one
//   { decision: 'not_yet', amount: null }
//   { decision: null, amount: null }  not an answer: anything else in it
//
// Deliberately whole-message: every word has to be an answer word, a filler
// word, an emoji or one amount, so "paid 40 for lunch" is an expense to
// capture, not a confirmation. Any "not" word makes the answer "not yet",
// which is the safe direction: a missed confirmation costs another question
// tomorrow, a wrong one records a payment that did not happen.
/**
 * @param {unknown} text
 * @returns {{ decision: 'paid' | 'not_yet' | null, amount: number | null }}
 */
export function autopayAnswer(text) {
  const none = { decision: null, amount: null };
  let s = normaliseEmoji(String(text ?? '')).toLowerCase().trim();
  if (!s || s.length > 80) return none;
  // Contractions and apostrophes: "it's", "didn't", "hasn’t".
  s = s.replace(/[’']/g, '');
  // Emojis become words of their own, so "paid✅" is "paid ✅".
  s = s.replace(/(\p{Extended_Pictographic})/gu, ' $1 ');
  const tokens = s.split(/[\s,.!?;:()\-–—]+/u).filter(Boolean);
  if (tokens.length === 0) return none;

  let paid = 0;
  let not = 0;
  let amount = null;
  // Thousands separators were split off above: "2,050" arrives as "2" "050".
  // Put a number back together before reading it.
  const joined = s.replace(/(\d),(\d{3})\b/g, '$1$2');
  const numbers = joined.match(/\d+(?:\.\d{1,2})?/g) ?? [];
  if (numbers.length > 1) return none;
  if (numbers.length === 1) {
    amount = Number(numbers[0]);
    if (!(amount > 0)) return none;
  }
  for (const token of tokens) {
    if (/^\d+(?:\.\d{1,2})?$/.test(token)) continue;
    if (PAID_EMOJIS.has(token)) paid += 1;
    else if (NOT_EMOJIS.has(token)) not += 1;
    else if (PAID_WORDS.has(token)) paid += 1;
    else if (NOT_WORDS.has(token)) not += 1;
    else if (!FILLER_WORDS.has(token)) return none;
  }
  if (not > 0) return { decision: 'not_yet', amount: null };
  if (paid > 0) return { decision: 'paid', amount };
  return none;
}

// Said when someone answers "not yet".
export function autopayNotYetMessage(name) {
  return `OK, ${name} hasn't gone out yet. I'll ask again tomorrow morning.`;
}
