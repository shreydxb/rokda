import { parseDay } from './day';

// Refunds linked to the purchases they return (docs/decisions.md, "A refund
// is linked to its purchase"; SHR-234). A link is a row in transaction_links
// of kind 'refund', from the purchase to the refund; link_refund() makes it
// and gives the refund the purchase's category. These helpers find a
// refund's purchase, a purchase's refunds, and the purchases a new refund
// could be for.

// Most shops refund within a few weeks, and a card can take another cycle to
// show it; four months covers a slow return without offering every purchase
// of the year.
export const REFUND_MATCH_DAYS = 120;

// A refund converted from another currency at a later rate can come to a
// little more than the purchase did. The database allows the same 5%.
export const REFUND_ALLOWANCE = 0.05;

// The refund link a refund is the refund side of, if any.
export function refundLinkOf(refundId, links = []) {
  return links.find((l) => l.kind === 'refund' && l.to_transaction_id === refundId) ?? null;
}

// The purchase a refund returns, as a transaction row, or null.
export function refundedPurchase(refund, links = [], transactions = []) {
  const link = refundLinkOf(refund?.id, links);
  return link ? (transactions.find((t) => t.id === link.from_transaction_id) ?? null) : null;
}

// The refunds linked to a purchase, oldest first.
export function refundsOf(purchaseId, links = [], transactions = []) {
  const ids = new Set(links.filter((l) => l.kind === 'refund' && l.from_transaction_id === purchaseId).map((l) => l.to_transaction_id));
  return transactions.filter((t) => ids.has(t.id)).sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
}

// How much of a purchase has come back, to the cent.
export function refundedAmount(purchaseId, links = [], transactions = []) {
  return Math.round(refundsOf(purchaseId, links, transactions).reduce((sum, t) => sum + Number(t.amount), 0) * 100) / 100;
}

const word = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Whether two merchant names are the same shop: one contains the other once
// case and punctuation are set aside ("SPINNEYS DUBAI" and "Spinneys").
export function sameMerchant(a, b) {
  const x = word(a);
  const y = word(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

// The purchases a refund could be returning, best first. A purchase is an
// expense, dated on or before the refund and within REFUND_MATCH_DAYS, with
// enough of it not yet refunded. Only the same shop or the same card is
// suggested: a refund that matches neither is linked by hand, never guessed.
// The same shop counts most, then the same account, then the exact amount,
// then the nearest date.
export function refundCandidates(refund, transactions = [], links = [], { days = REFUND_MATCH_DAYS } = {}) {
  if (!refund) return [];
  const amount = Math.abs(Number(refund.amount));
  if (!amount) return [];
  const day = parseDay(refund.occurred_at);
  const scored = [];
  for (const t of transactions) {
    if (t.id === refund.id || t.kind !== 'expense' || !(Number(t.amount) < 0)) continue;
    const age = (day - parseDay(t.occurred_at)) / 86400000;
    if (age < 0 || age > days) continue;
    const others = refundsOf(t.id, links, transactions).filter((r) => r.id !== refund.id);
    const left = -Number(t.amount) * (1 + REFUND_ALLOWANCE) - others.reduce((s, r) => s + Number(r.amount), 0);
    if (left + 0.005 < amount) continue;
    const merchant = sameMerchant(t.merchant, refund.merchant);
    const account = !!refund.account_id && t.account_id === refund.account_id;
    if (!merchant && !account) continue;
    const exact = Math.round(-Number(t.amount) * 100) === Math.round(amount * 100);
    scored.push({ t, score: (merchant ? 4 : 0) + (account ? 2 : 0) + (exact ? 1 : 0), age });
  }
  return scored.sort((a, b) => b.score - a.score || a.age - b.age).map((s) => s.t);
}
