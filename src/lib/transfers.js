import { parseDay } from './day';

// Transfers between the household's own accounts (docs/decisions.md,
// "Transfers are neither income nor spending"; SHR-234). A transfer is two
// transactions, money out of one account and the same money into another,
// joined by a row in transaction_links. The database keeps the two together;
// these helpers find one side's other side and suggest pairs to join.

// Two days either side covers a payment that leaves one bank today and lands
// on the card tomorrow, or a weekend in between, without pairing unrelated
// records that happen to share an amount.
export const TRANSFER_MATCH_DAYS = 4;

// The transfer link a transaction is one side of, if any.
export function transferLinkOf(transactionId, links = []) {
  return links.find((l) => l.kind === 'transfer' && (l.from_transaction_id === transactionId || l.to_transaction_id === transactionId)) ?? null;
}

// The other side of a transfer, as a transaction row, or null if it isn't one
// or its other side isn't loaded.
export function transferCounterpart(transaction, links = [], transactions = []) {
  const link = transferLinkOf(transaction?.id, links);
  if (!link) return null;
  const otherId = link.from_transaction_id === transaction.id ? link.to_transaction_id : link.from_transaction_id;
  return transactions.find((t) => t.id === otherId) ?? null;
}

// Records already in the ledger that could be the other side of this one: on
// another account, the opposite direction, the same amount to the cent, within
// a few days, and not already a transfer. Closest in time first. Amounts must
// match exactly; a fee is a separate expense, so a pair that differs by one is
// two records, not a transfer. A refund is money back from a shop, never one
// side of a transfer.
export function transferCandidates(transaction, transactions = [], { days = TRANSFER_MATCH_DAYS } = {}) {
  if (!transaction || transaction.kind === 'transfer' || transaction.kind === 'refund') return [];
  const amount = Number(transaction.amount);
  if (!amount) return [];
  const day = parseDay(transaction.occurred_at);
  return transactions
    .filter((t) => {
      if (t.id === transaction.id || t.kind === 'transfer' || t.kind === 'refund' || t.account_id === transaction.account_id) return false;
      if (Math.round(Number(t.amount) * 100) !== Math.round(-amount * 100)) return false;
      return Math.abs(parseDay(t.occurred_at) - day) <= days * 86400000;
    })
    .sort((a, b) => Math.abs(parseDay(a.occurred_at) - day) - Math.abs(parseDay(b.occurred_at) - day));
}

// Which of a pair is the money-out side, for link_transfer().
export function orderPair(a, b) {
  return Number(a.amount) < 0 ? { out: a, in: b } : { out: b, in: a };
}

// "To Savings" on the money-out side, "From Current account" on the money-in
// side; "Transfer" when the other side isn't to hand.
export function transferDirectionLabel(transaction, counterpart, accountById = new Map()) {
  if (!counterpart) return 'Transfer';
  const other = accountById.get(counterpart.account_id)?.name ?? 'another account';
  return Number(transaction.amount) < 0 ? `To ${other}` : `From ${other}`;
}
