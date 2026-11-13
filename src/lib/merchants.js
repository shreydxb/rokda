// A merchant's name as banks and statements write it, reduced to what
// identifies it. The bot categorises by it (supabase/functions/_shared/applib/
// merchants.js, which copies normaliseMerchant from here); the app uses it to
// tell an entry already recorded (lib/alreadyRecorded.js).
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
