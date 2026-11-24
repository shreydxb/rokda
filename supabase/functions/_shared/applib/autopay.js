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
import { day, money } from './botFormat.js';
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

// What the bot asks (the revamp, phase 8c; review T10): one line, written
// through the one format (botFormat.js), with Paid, Not yet and Other amount
// under it. The first question says "due today" on the due date (a bill
// switched to autopay mid-cycle is first asked about days later, and says
// the date); the next mornings ask "Gone out yet?". A typed answer still
// works: "paid", "paid 2,050", "not yet", or a 👍.
/**
 * @param {{ name: string, amount: number, accountName?: string | null, due: string }} bill
 * @param {{ reminder?: boolean, today?: string | null }} [options]
 */
export function autopayQuestion(bill, { reminder = false, today = null } = {}) {
  const on = today ?? bill.due;
  const when = !reminder && on === bill.due ? 'today' : day(bill.due, on);
  const from = bill.accountName ? ` from ${bill.accountName}` : '';
  return `${bill.name} · ${money(Math.abs(Number(bill.amount)))} · due ${when}${from}. ${reminder ? 'Gone out yet?' : 'Gone out?'}`;
}

// What a bill recorded from its question became: "✓ Car EMI · AED 2,000 ·
// 3 Oct · next due 3 Nov".
/**
 * @param {{ name?: string, amount?: number | string, occurred_at?: string, next_due?: string | null }} bill
 * @param {string} [today]
 */
export function autopayRecordedLine(bill, today) {
  const what = autopayWhat(bill, today);
  return bill.next_due ? `✓ ${what} · next due ${day(bill.next_due, today)}` : `✓ ${what}`;
}

// "Car EMI · AED 2,000 · 3 Oct".
export function autopayWhat(bill, today) {
  return [bill.name ?? 'That bill', money(Number(bill.amount)), bill.occurred_at ? day(String(bill.occurred_at), today) : null].filter(Boolean).join(' · ');
}

// Said for Other amount: the amount comes as a typed answer, on its own or
// with "paid" (autopayAmountOnly, autopayAnswer).
export const AUTOPAY_OTHER_AMOUNT = 'Reply to this with the amount that went out, like "2,050".';

// An amount on its own, as a reply to an autopay question after Other
// amount: "2,050", "2050.50", "AED 2,050". Grouped the international or the
// Indian way, as autopayAnswer reads it; anything else is not an amount.
/**
 * @param {unknown} text
 * @returns {number | null}
 */
export function autopayAmountOnly(text) {
  const s = String(text ?? '').toLowerCase().replace(/\b(aed|dhs?|dirhams?)\b/g, ' ').trim();
  if (!/^\d+(?:,\d+)*(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, cents] = s.split('.');
  if (whole.includes(',') && !/^\d{1,3}(?:,\d{3})+$/.test(whole) && !/^\d{1,2}(?:,\d{2})*,\d{3}$/.test(whole)) return null;
  const amount = Number(whole.replace(/,/g, '') + (cents ? `.${cents}` : ''));
  return amount > 0 ? amount : null;
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
  // A number is read whole from the text instead, grouped the international
  // way (1,000,000) or the Indian way (1,00,000); any other grouping is not
  // guessed at. Only one group used to be put back together, so 1,00,000
  // was not read at all (round 2 of the outside review).
  const numbers = s.match(/\d+(?:,\d+)*(?:\.\d{1,2})?/g) ?? [];
  if (numbers.length > 1) return none;
  if (numbers.length === 1) {
    const [whole, cents] = numbers[0].split('.');
    const grouped = whole.includes(',');
    if (grouped && !/^\d{1,3}(?:,\d{3})+$/.test(whole) && !/^\d{1,2}(?:,\d{2})*,\d{3}$/.test(whole)) return none;
    amount = Number(whole.replace(/,/g, '') + (cents ? `.${cents}` : ''));
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
  return `Not yet · ${name} · I'll ask again tomorrow`;
}
