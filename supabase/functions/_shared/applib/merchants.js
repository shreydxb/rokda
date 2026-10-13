// How the bot picks an expense's category before the model guesses one
// (docs/decisions.md, "The bot categorises from the household's own history").
//
// A household rule wins: someone wrote it on purpose. Then how the household
// categorised the same merchant before, across all of its history. Only when
// neither knows the merchant does the model's guess stand.
//
// Bot-only, like autopay.js: the app applies rules in the Inbox through
// src/lib/rules.js, which rules.js here copies.
import { firstMatchingRule } from './rules.js';

// Payment processors put their own name in front of the merchant's.
const PROCESSOR_PREFIX = /^(?:optional\s+)?(?:ziina|paymob|tap|fs|pos|tcp|sq|sp|paypal)\s*\*+\s*/;
// What card statements add after a merchant's name: the city and country, and
// the company's legal form. Dropped from the end only, so "Dubai Taxi" stays
// "dubai taxi".
const TRAILING_NOISE = new Set([
  'dubai', 'are', 'ae', 'uae', 'abudhabi', 'abu', 'dhabi', 'sharjah', 'ajman',
  'llc', 'l', 'c', 'fz', 'fze', 'fzco', 'dmcc', 'co', 'est', 'pvt', 'ltd', 'lt', 'inc', 'plc', 'spc', 'trading',
]);

// A merchant's name reduced to what identifies it, so a statement's
// "EPPCO SITE 1077" and a typed "eppco" are the same merchant, and
// "NOON MINUTES LLC DUBAI ARE" is "noon minutes".
export function normaliseMerchant(name) {
  let s = String(name ?? '').toLowerCase().trim();
  s = s.replace(PROCESSOR_PREFIX, '');
  const raw = s.split(/[^a-z0-9&]+/).filter(Boolean);
  // A store number, and the "site" or "no" in front of it.
  const tokens = raw.filter((t, i) => !/^\d+$/.test(t) && t !== 'site' && !(t === 'no' && /^\d+$/.test(raw[i + 1] ?? '')));
  while (tokens.length > 1 && TRAILING_NOISE.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

// Whether a new expense's merchant is one seen before. The new name must
// appear, as whole words, in the past one: the model often shortens a name,
// so "Alseer" still finds "Moisturiser Alseer". But a past name that is the
// new one with more words after it is a different service of the same brand:
// plain "Noon" is not "Noon Minutes", and "Careem" (a ride) is not
// "Careem Food".
export function merchantMatches(newMerchant, pastMerchant) {
  const mine = normaliseMerchant(newMerchant).split(' ').filter(Boolean);
  const theirs = normaliseMerchant(pastMerchant).split(' ').filter(Boolean);
  if (mine.length === 0 || mine.length > theirs.length) return false;
  for (let i = 0; i + mine.length <= theirs.length; i += 1) {
    if (!mine.every((w, j) => theirs[i + j] === w)) continue;
    if (theirs.length === mine.length) return true;
    if (i === 0) return false;
    return true;
  }
  return false;
}

// The category the household used most for this merchant, the most recent
// one on a tie. `history` is merchant_category_counts(): one row per merchant
// and category with how often and when it was last used.
export function categoryFromHistory(merchant, history = []) {
  if (normaliseMerchant(merchant).length < 3) return null;
  const tally = new Map();
  for (const row of history) {
    if (!row?.category_id || !merchantMatches(merchant, row.merchant)) continue;
    const seen = tally.get(row.category_id) ?? { uses: 0, last: '' };
    seen.uses += Number(row.uses) || 0;
    if (String(row.last_used ?? '') > seen.last) seen.last = String(row.last_used);
    tally.set(row.category_id, seen);
  }
  let best = null;
  for (const [categoryId, seen] of tally) {
    if (!best || seen.uses > best.uses || (seen.uses === best.uses && seen.last > best.last)) best = { categoryId, ...seen };
  }
  return best?.categoryId ?? null;
}

// The category for a new expense, and where it came from, or null when the
// household has no view on this merchant yet.
/**
 * @param {string | null | undefined} merchant
 * @param {{ rules?: Array<{ pattern: string, match_type: string, category_id: string, archived?: boolean }>, history?: Array<{ merchant: string, category_id: string, uses: number, last_used: string | null }> }} known
 * @returns {{ categoryId: string, source: 'rule' | 'history' } | null}
 */
export function pickCategory(merchant, { rules = [], history = [] } = {}) {
  if (!merchant) return null;
  const rule = firstMatchingRule(merchant, rules);
  if (rule?.category_id) return { categoryId: rule.category_id, source: 'rule' };
  const fromHistory = categoryFromHistory(merchant, history);
  return fromHistory ? { categoryId: fromHistory, source: 'history' } : null;
}
