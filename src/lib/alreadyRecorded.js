// Whether an undated entry is a copy of one already recorded.
//
// A bank SMS with no date is dated the day it was pasted. Pasted again a
// week later, a copy of one already recorded passed the 3-day duplicate
// check unseen (the feature review, November 2026). So an undated entry is
// checked against the two weeks up to the day it was pasted: the same card,
// the same amount to the fils, the same kind, and the same merchant once the
// bank's additions are taken off ("CITY TAXI, DUBAI" is "City Taxi"). The
// card and the amount carry the match; the merchant only guards it. An entry
// whose message gave its date is left to the ordinary duplicate check.
import { normaliseMerchant } from './merchants';
import { daysBetweenDays, parseDay } from './day';

export const ALREADY_RECORDED_DAYS = 14;

// Words a name often starts with that say nothing of which shop it is: an
// article, a place, a payment service in front of the shop's own name. A name
// starting with one is compared on its first two words.
const GENERIC_FIRST = new Set(['al', 'the', 'dubai', 'abu', 'uae', 'emirates', 'sharjah', 'ajman', 'sumup', 'google', 'apple', 'paypal', 'stripe', 'checkout']);
function merchantKey(merchant) {
  const words = normaliseMerchant(merchant).split(' ').filter(Boolean);
  return GENERIC_FIRST.has(words[0]) ? words.slice(0, 2).join(' ') : (words[0] ?? '');
}

// An expense is matched only with an expense, and a refund or income only
// with its own kind: a refund set aside as a copy of a purchase would be
// money lost from the books (the fresh review of this change).
const kindOf = (t) => t.kind ?? (Number(t.amount) < 0 ? 'expense' : 'income');
const messageOf = (ref) => String(ref ?? '').split('#')[0];

// For each entry, the record it repeats, as a Map from the entry's id. Each
// record answers for one entry at most, the latest record first, so two real
// fares of the same amount are not both taken for one recorded fare. A record
// made from another entry of the same message is never one it repeats: two
// purchases pasted together are two purchases. `intake` is every Inbox row,
// to tell those records (intake.transaction_id).
export function alreadyRecordedAll(items = [], transactions = [], intake = []) {
  const found = new Map();
  const used = new Set();
  for (const item of items) {
    if (!item?.date_guessed || !item.parsed_account_id || !item.parsed_merchant || item.parsed_amount == null || !item.parsed_date) continue;
    const amount = Math.abs(Number(item.parsed_amount));
    const key = merchantKey(item.parsed_merchant);
    if (!key || !(amount > 0)) continue;
    const kind = item.parsed_kind ?? 'expense';
    const message = messageOf(item.source_ref);
    const fromSiblings = new Set(intake.filter((r) => r.transaction_id && message && messageOf(r.source_ref) === message).map((r) => r.transaction_id));
    const pasted = parseDay(item.parsed_date);
    let best = null;
    for (const t of transactions) {
      if (used.has(t.id) || fromSiblings.has(t.id)) continue;
      if (t.account_id !== item.parsed_account_id || !t.occurred_at || kindOf(t) !== kind) continue;
      if (Math.abs(Math.abs(Number(t.amount)) - amount) >= 0.005) continue;
      const before = daysBetweenDays(parseDay(t.occurred_at), pasted);
      if (before < 0 || before > ALREADY_RECORDED_DAYS) continue;
      if (merchantKey(t.merchant) !== key) continue;
      if (!best || t.occurred_at > best.occurred_at) best = t;
    }
    if (best) {
      found.set(item.id, best);
      used.add(best.id);
    }
  }
  return found;
}
