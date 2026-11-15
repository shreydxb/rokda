const DAY_MS = 24 * 60 * 60 * 1000;

// A record like this already exists — same account, same merchant, same
// amount, within a few days. Shared by the manual transaction form and the
// Inbox review screen so a likely duplicate is caught the same way
// regardless of how the entry was created.
export function findDuplicate(form, allTransactions, excludeId) {
  const merchant = form.merchant.trim().toLowerCase();
  const amount = Number(form.amount);
  if (!merchant || !amount || !form.account_id || !form.occurred_at) return null;
  const occurred = new Date(form.occurred_at).getTime();

  return (
    allTransactions.find((t) => {
      if (t.id === excludeId) return false;
      if (t.account_id !== form.account_id) return false;
      if ((t.merchant ?? '').trim().toLowerCase() !== merchant) return false;
      if (Math.abs(Math.abs(Number(t.amount)) - amount) > 0.01) return false;
      const diffDays = Math.abs(new Date(t.occurred_at).getTime() - occurred) / DAY_MS;
      return diffDays <= 3;
    }) ?? null
  );
}

// Two records already in the ledger that look like one recorded twice
// (docs/decisions.md, "A pair confirmed as two real records stays
// confirmed"; SHR-234): the same account, merchant, direction and amount to
// the cent, within DUPLICATE_DAYS. Someone says either "both are real",
// which is kept as a transaction_links row of kind 'duplicate_confirmed' so
// the pair is never asked about again, or deletes one.
export const DUPLICATE_DAYS = 3;

// Whether a pair has been confirmed as two real records, either way round.
export function isConfirmedPair(aId, bId, links = []) {
  return links.some(
    (l) => l.kind === 'duplicate_confirmed' && ((l.from_transaction_id === aId && l.to_transaction_id === bId) || (l.from_transaction_id === bId && l.to_transaction_id === aId)),
  );
}

const sameRecord = (a, b, days) =>
  a.account_id === b.account_id &&
  (a.merchant ?? '').trim().toLowerCase() !== '' &&
  (a.merchant ?? '').trim().toLowerCase() === (b.merchant ?? '').trim().toLowerCase() &&
  Math.round(Number(a.amount) * 100) === Math.round(Number(b.amount) * 100) &&
  (a.kind ?? null) === (b.kind ?? null) &&
  Math.abs(new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()) / DAY_MS <= days;

// The possible duplicates among `rows`, each matched against every record,
// earlier-recorded first in each pair. A transfer's sides are never
// duplicates, and a confirmed pair is left out. Each record is in one pair at
// most.
export function duplicatePairs(rows, transactions = [], links = [], { days = DUPLICATE_DAYS } = {}) {
  const used = new Set();
  const pairs = [];
  const recordedFirst = (a, b) => (String(a.created_at ?? '') < String(b.created_at ?? '') || (a.created_at === b.created_at && a.id < b.id) ? [a, b] : [b, a]);
  for (const t of rows) {
    if (t.kind === 'transfer' || used.has(t.id)) continue;
    const other = transactions.find((o) => o.id !== t.id && o.kind !== 'transfer' && !used.has(o.id) && sameRecord(t, o, days) && !isConfirmedPair(t.id, o.id, links));
    if (!other) continue;
    used.add(t.id);
    used.add(other.id);
    const [first, second] = recordedFirst(t, other);
    pairs.push({ first, second });
  }
  return pairs;
}

// The row that remembers a pair as two real records. The lower id goes
// first, so the same pair always makes the same row.
export function confirmedPairRow(householdId, a, b) {
  const [from, to] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  return { household_id: householdId, kind: 'duplicate_confirmed', from_transaction_id: from, to_transaction_id: to };
}

// Every record that may be recorded twice, for Activity's chips (the revamp,
// phase 4): the same as the pairs above but without the one-pair-each rule,
// and worked out once for the whole ledger by grouping on account, merchant,
// amount and kind, so a long history doesn't slow every keystroke (the fresh
// review of 4a: comparing each row with every record took over a second on
// six thousand).
export function possibleDuplicateIds(transactions = [], links = [], { days = DUPLICATE_DAYS } = {}) {
  const groups = new Map();
  for (const t of transactions) {
    const merchant = (t.merchant ?? '').trim().toLowerCase();
    if (t.kind === 'transfer' || merchant === '') continue;
    const key = `${t.account_id}|${merchant}|${Math.round(Number(t.amount) * 100)}|${t.kind ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const ids = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const dated = group.map((t) => ({ t, at: new Date(t.occurred_at).getTime() })).sort((a, b) => a.at - b.at);
    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length && (dated[j].at - dated[i].at) / DAY_MS <= days; j++) {
        if (isConfirmedPair(dated[i].t.id, dated[j].t.id, links)) continue;
        ids.add(dated[i].t.id);
        ids.add(dated[j].t.id);
      }
    }
  }
  return ids;
}
