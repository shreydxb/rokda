// What the bot says about one expense (expenseMessages.ts): two short lines
// before it is recorded, one after, and why it waits when it waits.
import { assertEquals } from "jsr:@std/assert@1";
import { askText, cancelledText, inboxReason, inboxText, readyText, recordedText, undoneText } from "./expenseMessages.ts";

const TODAY = "2026-10-20";
const BAKERY = { merchant: "Bakery", amount: 42, currency: "AED", date: "2026-10-03", kind: "expense", category: "Groceries", account: "Bank card" };

Deno.test("an expense ready to record is two lines: who and how much, then category, card and day", () => {
  assertEquals(readyText(BAKERY, TODAY), "Bakery · AED 42\nGroceries · Bank card · 3 Oct");
  assertEquals(readyText({ ...BAKERY, amount: 2050.5 }, TODAY), "Bakery · AED 2,050.50\nGroceries · Bank card · 3 Oct");
  assertEquals(readyText({ ...BAKERY, date: "2025-12-30" }, TODAY), "Bakery · AED 42\nGroceries · Bank card · 30 Dec 2025");
});

Deno.test("income and a refund say so first", () => {
  assertEquals(readyText({ ...BAKERY, kind: "refund", merchant: "Shop" }, TODAY), "Refund · Shop · AED 42\nGroceries · Bank card · 3 Oct");
  assertEquals(readyText({ ...BAKERY, kind: "income", merchant: "Employer", category: "Salary" }, TODAY), "Income · Employer · AED 42\nSalary · Bank card · 3 Oct");
});

Deno.test("recorded is one line with a tick and its category; cancelled and undone say so", () => {
  assertEquals(recordedText(BAKERY), "✓ Bakery · AED 42 · Groceries");
  assertEquals(recordedText({ ...BAKERY, kind: "income", merchant: "Employer", category: null }), "✓ Income · Employer · AED 42");
  assertEquals(cancelledText(BAKERY), "Cancelled · Bakery · AED 42");
  assertEquals(undoneText(BAKERY), "Undone · Bakery · AED 42 · Groceries");
});

Deno.test("a question about a missing category or card shows what was read, then asks", () => {
  assertEquals(askText({ ...BAKERY, category: null }, "category", TODAY), "Bakery · AED 42\nBank card · 3 Oct\nWhich category? Saved in the Inbox meanwhile.");
  assertEquals(askText({ ...BAKERY, account: null }, "account", TODAY), "Bakery · AED 42\nGroceries · 3 Oct\nWhich card or account? Saved in the Inbox meanwhile.");
});

const READ = { parsed_merchant: "Bakery", parsed_amount: 42, parsed_account_id: "a", parsed_category_id: "c", parsed_currency: "AED", confidence: 0.95, date_guessed: false };

Deno.test("why it waits in the Inbox, in a few words", () => {
  assertEquals(inboxReason({ ...READ, parsed_category_id: null }), { reason: "needs a category", note: null });
  assertEquals(inboxReason({ ...READ, parsed_merchant: null, parsed_category_id: null }), { reason: "needs who was paid and a category", note: null });
  assertEquals(inboxReason({ ...READ, parsed_amount: null, parsed_merchant: null, parsed_account_id: null }), { reason: "needs the amount, who was paid and the card or account", note: null });
  assertEquals(inboxReason({ ...READ, confidence: 0.5 }), { reason: "to check: not sure I read it right", note: null });
  assertEquals(inboxReason(READ), { reason: "to check and approve", note: null });
  assertEquals(inboxReason({ ...READ, date_guessed: true }), { reason: "needs the day it was paid", note: null });
  assertEquals(inboxReason(READ, { occurred_at: "2026-10-02" }, TODAY), { reason: "looks like one recorded 2 Oct", note: null });
  assertEquals(inboxReason({ ...READ, parsed_currency: "INR", confidence: 0.5 }), { reason: "to check and approve", note: "It's in INR: add the AED debited, or leave it for an estimate." });
});

Deno.test("the Inbox message leads with where it is and why, then what was read", () => {
  assertEquals(
    inboxText({ ...BAKERY, category: null }, { reason: "needs a category", note: null }, TODAY),
    "In the Inbox · needs a category\nBakery · AED 42 · 3 Oct",
  );
  assertEquals(
    inboxText({ ...BAKERY, currency: "INR", amount: 500 }, { reason: "to check and approve", note: "It's in INR: add the AED debited, or leave it for an estimate." }, TODAY),
    "In the Inbox · to check and approve\nBakery · INR 500 · 3 Oct\nIt's in INR: add the AED debited, or leave it for an estimate.",
  );
  // Nothing read but the words: only where it is and why.
  assertEquals(inboxText({ merchant: null, amount: null, date: null }, { reason: "needs the amount and who was paid", note: null }, TODAY), "In the Inbox · needs the amount and who was paid");
});
