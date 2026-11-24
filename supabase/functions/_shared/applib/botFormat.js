// The bot's one way of writing money and dates (the revamp, phase 8; the UI
// review's T17 and T18): "AED 1,234", with decimals only when they are not
// zero; "3 Oct", with the year only when it is not this year; and "·"
// between facts. Every message the bot sends writes its figures through
// these, so no two say the same thing two ways. Bot-only: the app has its
// own formatters (src/lib/money.js).
import { householdToday } from './day.js';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * An amount in the currency it is in, grouped as that currency groups it.
 * @param {number | string} amount
 * @param {string} [currency]
 */
export function money(amount, currency = 'AED') {
  const code = String(currency || 'AED').toUpperCase();
  // An amount that isn't a number is said to be unknown, never read as zero
  // or printed as "NaN" (the fresh review of 8a).
  const raw = amount == null || amount === '' ? NaN : Number(amount);
  if (!Number.isFinite(raw)) return `${code} amount not known`;
  const n = Math.round(Math.abs(raw) * 100) / 100;
  const whole = Number.isInteger(n);
  const digits = n.toLocaleString(code === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  // The minus goes before the code, as the trade messages write it, and an
  // amount that rounds to nothing has none ("AED -0").
  return `${raw < 0 && n > 0 ? '−' : ''}${code} ${digits}`;
}

/**
 * "3 Oct", or "19 Sep 2025" for a day in another year than today's.
 * @param {string} value a day ("2026-10-03") or a moment ("2026-10-03T08:00:00Z")
 * @param {string} [today] the household's today, as "YYYY-MM-DD"
 */
export function day(value, today = householdToday()) {
  const text = String(value);
  // A moment is the household's day, not the UTC one: 21:00 UTC on 31 Dec is
  // 1 Jan in Dubai (the fresh review of 8a).
  const date = text.length > 10 ? householdToday(new Date(text)) : text;
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${SHORT_MONTHS[Number(m) - 1]}${y === today.slice(0, 4) ? '' : ` ${y}`}`;
}

/**
 * The facts that are there, joined with "·".
 * @param {...(string | null | undefined | false)} parts
 */
export function facts(...parts) {
  return parts.filter(Boolean).join(' · ');
}

/**
 * What a total leaves out, in a few words for a ⚠ line (review T24):
 * "1 account not converted · 2 holdings not valued", or null.
 * @param {{ accounts?: number, holdings?: number }} counts
 */
export function notCounted({ accounts = 0, holdings = 0 } = {}) {
  const parts = [];
  if (accounts) parts.push(`${accounts} ${accounts === 1 ? 'account' : 'accounts'} not converted`);
  if (holdings) parts.push(`${holdings} ${holdings === 1 ? 'holding' : 'holdings'} not valued`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Cash cover in the bot's words (the revamp, phase 8c): the figures and a
 * verdict on one line, and what it leaves out on ⚠ lines of its own, as the
 * brief writes a figure's caveat (8a). The verdict follows the rules of the
 * app's sentence (cashCover.js formatCashCoverLine, QA #4): a bill due with
 * no AED amount makes what is due a floor, so "covered" is not said and a
 * shortfall is "at least"; with an account not converted too, the liquid
 * money is low as well, and no verdict is given. lead is "Cash cover · " in
 * the morning's lines and "Cash cover: " in the brief, whose lines are a
 * label and its figure. The SHR-292 test holds these words to the app's rule.
 * @param {{ liquidAed: number, dueAed: number, days: number, covered: boolean, certain?: boolean, shortfallAed: number, unvalued?: number, unvaluedDue?: number }} s
 * @param {string} [lead]
 */
export function cashCoverLine(s, lead = 'Cash cover · ') {
  const missing = s.unvaluedDue ?? 0;
  const unvalued = s.unvalued ?? 0;
  const short = money(s.shortfallAed);
  const verdict = missing > 0
    ? (s.covered || unvalued ? "can't say if covered" : `short by at least ${short}`)
    : (s.covered ? 'covered' : `short by ${short}`);
  const lines = [`${lead}${money(s.liquidAed)} liquid · ${money(s.dueAed)} due in ${s.days} days · ${verdict}`];
  if (missing > 0) lines.push(`⚠ ${missing} ${missing === 1 ? 'bill due has' : 'bills due have'} no AED amount, so more is due`);
  if (unvalued) lines.push(`⚠ Leaves out ${notCounted({ accounts: unvalued })}`);
  return lines.join('\n');
}
