import { formatSigned } from './money';
import { parseDay } from './day';
import { refundedPurchase, refundsOf } from './refunds';

// Edit history across linked records (SHR-323). A purchase, its refunds and
// the two sides of a transfer change together: a purchase's new category is
// copied to its refunds, a transfer's new amount is written to both sides.
// Each record's transaction_edits rows say what changed on it; read one
// record at a time, "why did this refund's category move?" meant opening the
// purchase to find out. These helpers put a record's edits and its linked
// records' edits on one timeline, grouped into the saves that made them.

export const FIELD_LABELS = {
  kind: 'Type',
  category: 'Category',
  amount: 'Amount',
  native_amount: 'Amount paid',
  account: 'Account',
  merchant: 'Merchant',
  scope: 'Scope',
  refund_for: 'Refund for',
  date: 'Date',
};

// Rows written by one save land within moments of each other. A minute keeps
// a save that also updates linked records together without merging two saves
// someone made one after the other.
export const SAME_SAVE_MS = 60_000;

const shortDate = (day) => parseDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// The record being edited and the records linked to it, each with the label
// its lines carry: a refund's purchase, or a purchase's refunds.
export function relatedRecords(tx, links = [], transactions = []) {
  if (!tx) return [];
  const own = { id: tx.id, label: tx.kind === 'refund' ? 'This refund' : tx.kind === 'income' ? 'This income' : 'This purchase' };
  const others = [];
  if (tx.kind === 'refund') {
    const purchase = refundedPurchase(tx, links, transactions);
    if (purchase) others.push({ id: purchase.id, label: `The purchase · ${purchase.merchant?.trim() || 'no merchant'} · ${shortDate(purchase.occurred_at)}` });
  } else {
    for (const r of refundsOf(tx.id, links, transactions)) {
      others.push({ id: r.id, label: `Refund · ${formatSigned(Number(r.amount))} · ${shortDate(r.occurred_at)}` });
    }
  }
  return [own, ...others];
}

// The edits of every record given, as saves, newest first. A save is the
// edits one person made within SAME_SAVE_MS of each other. Each line names its
// record when there is more than one. `who` is the member's name; an edit with
// no member was made by the bot or the database on its own (or by a member
// since removed), and reads "Automatic".
export function historyEvents(edits = [], records = [], members = []) {
  const labelOf = new Map(records.map((r) => [r.id, r.label]));
  const named = records.length > 1;
  const sorted = [...edits].sort((a, b) => new Date(a.edited_at) - new Date(b.edited_at) || String(a.id).localeCompare(String(b.id)));
  const events = [];
  for (const e of sorted) {
    const at = new Date(e.edited_at);
    const last = events[events.length - 1];
    const line = {
      id: e.id,
      record: named ? (labelOf.get(e.transaction_id) ?? 'A linked record') : null,
      field: FIELD_LABELS[e.field] ?? e.field,
      from: e.old_value ?? '—',
      to: e.new_value ?? '—',
    };
    if (last && last.editedBy === (e.edited_by ?? null) && at - last.lastAt <= SAME_SAVE_MS) {
      last.lines.push(line);
      last.lastAt = at;
      continue;
    }
    events.push({
      key: e.id,
      at,
      lastAt: at,
      editedBy: e.edited_by ?? null,
      who: e.edited_by ? (members.find((m) => m.id === e.edited_by)?.display_name ?? 'A former member') : 'Automatic',
      lines: [line],
    });
  }
  // Within a save, this record's own lines first, then the linked ones in the
  // order the records were given.
  const order = new Map(records.map((r, i) => [r.label, i]));
  for (const ev of events) ev.lines.sort((a, b) => (order.get(a.record) ?? 99) - (order.get(b.record) ?? 99));
  return events.reverse();
}

// The history rows a saved change to a transfer writes, one per side: the
// amount (money out stays negative) and the date.
export function transferEdits(transfer, amount, occurredAt) {
  const rows = [];
  const oldAmount = Math.abs(Number(transfer.in.amount));
  if (Math.abs(oldAmount - amount) > 0.001) {
    rows.push(
      { transaction_id: transfer.out.id, field: 'amount', old_value: formatSigned(-oldAmount), new_value: formatSigned(-amount) },
      { transaction_id: transfer.in.id, field: 'amount', old_value: formatSigned(oldAmount), new_value: formatSigned(amount) },
    );
  }
  if (transfer.out.occurred_at !== occurredAt) {
    const day = (d) => parseDay(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    for (const side of [transfer.out, transfer.in]) rows.push({ transaction_id: side.id, field: 'date', old_value: day(side.occurred_at), new_value: day(occurredAt) });
  }
  return rows;
}
