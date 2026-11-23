// What the bot says about one expense (the revamp, phase 8b; the UI review's
// T2, T3, T5 and T6). Before it is recorded, two short lines: who and how
// much, then the category, card and day, under the buttons that record,
// change or discard it. After, one line with a tick. When it waits in the
// Inbox, where it is and why in a few words, then what was read. Written
// through the bot's one format (_shared/applib/botFormat.js), with the three
// outcome words: Recorded (the tick), In the Inbox and Cancelled.
import { day, facts, money } from "../_shared/applib/botFormat.js";
import { householdToday } from "../_shared/applib/day.js";

// An entry as a message shows it: names, not ids.
export type ExpenseView = {
  merchant: string | null;
  amount: number | string | null;
  currency?: string | null;
  date: string | null;
  kind?: string | null;
  category?: string | null;
  account?: string | null;
};

const KIND_LABEL: Record<string, string> = { income: "Income", refund: "Refund" };

function amountOf(v: ExpenseView): string | null {
  return v.amount != null && Number(v.amount) > 0 ? money(v.amount, v.currency || "AED") : null;
}

// "Bakery · AED 42", or "Refund · Shop · AED 42".
function head(v: ExpenseView): string {
  return facts(KIND_LABEL[v.kind ?? ""], v.merchant, amountOf(v));
}

export function readyText(v: ExpenseView, today = householdToday()): string {
  return `${head(v)}\n${facts(v.category, v.account, v.date && day(v.date, today))}`;
}

export function recordedText(v: ExpenseView): string {
  return `✓ ${facts(head(v), v.category)}`;
}

export function cancelledText(v: ExpenseView): string {
  return `Cancelled · ${head(v)}`;
}

// The question asked when only the category or the card is missing.
export function askText(v: ExpenseView, ask: "category" | "account", today = householdToday()): string {
  const known = ask === "category" ? v.account : v.category;
  return `${head(v)}\n${facts(known, v.date && day(v.date, today))}\n${ask === "category" ? "Which category?" : "Which card or account?"}`;
}

type ReasonRow = {
  parsed_amount?: number | string | null;
  parsed_merchant?: string | null;
  parsed_account_id?: string | null;
  parsed_category_id?: string | null;
  parsed_currency?: string | null;
  confidence?: number | string | null;
  date_guessed?: boolean | null;
};

export type InboxReason = { reason: string; note: string | null };

// Why one entry waits in the Inbox rather than being offered Record, in a few
// words the member can act on. What is missing comes first; then a repeat of
// a record already made; then a reading the parser was unsure of.
export function inboxReason(row: ReasonRow, duplicate: { occurred_at: string } | null = null, today = householdToday()): InboxReason {
  // Another currency is not something missing: the Inbox keeps that amount
  // and records the AED debited beside it, or an estimate until it is known
  // (docs/decisions.md, "A payment in rupees keeps both amounts").
  const foreign = row.parsed_currency && row.parsed_currency !== "AED" ? row.parsed_currency : null;
  const note = foreign ? `It's in ${foreign}: add the AED debited, or leave it for an estimate.` : null;
  if (duplicate) return { reason: `looks like one recorded ${day(duplicate.occurred_at, today)}`, note };
  const missing: string[] = [];
  if (!(Number(row.parsed_amount) > 0)) missing.push("the amount");
  if (!row.parsed_merchant) missing.push("who was paid");
  if (!row.parsed_account_id) missing.push("the card or account");
  if (!row.parsed_category_id) missing.push("a category");
  if (missing.length) {
    const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
    return { reason: `needs ${list}`, note };
  }
  if (row.date_guessed) return { reason: "needs the day it was paid", note };
  if (Number(row.confidence ?? 0) < 0.85 && !foreign) return { reason: "to check: not sure I read it right", note };
  return { reason: "to check and approve", note };
}

export function inboxText(v: ExpenseView, why: InboxReason, today = householdToday()): string {
  const read = facts(v.merchant, amountOf(v), v.date && day(v.date, today));
  return [`In the Inbox · ${why.reason}`, read, why.note].filter(Boolean).join("\n");
}
