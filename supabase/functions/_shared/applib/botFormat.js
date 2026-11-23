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
  const n = Math.round(Number(amount) * 100) / 100;
  const whole = Number.isInteger(n);
  const digits = n.toLocaleString(code === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  return `${code} ${digits}`;
}

/**
 * "3 Oct", or "19 Sep 2025" for a day in another year than today's.
 * @param {string} value a day ("2026-10-03") or a moment ("2026-10-03T08:00:00Z")
 * @param {string} [today] the household's today, as "YYYY-MM-DD"
 */
export function day(value, today = householdToday()) {
  const [y, m, d] = String(value).slice(0, 10).split('-');
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
