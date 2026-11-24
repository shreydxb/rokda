// The morning message's lines (checks/morningWords.ts): each nudge in a few
// words, in the bot's one format, worded as Overview's To do words the same
// kind of item. Pure, so tested on its own.
import { assertEquals } from "jsr:@std/assert@1";
import { billLine, budgetLine, cardLine, unusualLine } from "./morningWords.ts";

const TODAY = "2026-10-06";

Deno.test("a bill not seen is late, as To do says it, with its usual amount", () => {
  assertEquals(billLine({ name: "Rent", amount: -6500, due: "2026-10-03" }, TODAY), "Rent · Late · was due 3 Oct · AED 6,500");
  assertEquals(billLine({ name: "Salary", amount: 20000.5, due: "2026-09-28" }, TODAY), "Salary · Late · was due 28 Sep · AED 20,000.50");
});

Deno.test("a card due soon says when, as To do does, and one still owing after its date is late", () => {
  assertEquals(cardLine({ name: "Bank card", kind: "due_soon", due: "2026-10-06", owed: 1200, currency: "AED", converted: true }, TODAY), "Bank card · Payment due today · AED 1,200 owed");
  assertEquals(cardLine({ name: "Bank card", kind: "due_soon", due: "2026-10-08", owed: 1200, currency: "AED", converted: true }, TODAY), "Bank card · Payment due in 2d · AED 1,200 owed");
  assertEquals(cardLine({ name: "Bank card", kind: "late", due: "2026-10-01", owed: 1200, currency: "AED", converted: true }, TODAY), "Bank card · Late · was due 1 Oct · AED 1,200 owed");
  // The days the check worked out are the ones said, so the line agrees with
  // the card's own due date however the clock's zone writes it.
  assertEquals(cardLine({ name: "Bank card", kind: "due_soon", due: "2026-10-06", daysUntil: 1, owed: 1200, currency: "AED", converted: true }, TODAY), "Bank card · Payment due in 1d · AED 1,200 owed");
  // No AED value: the amount in its own currency, never read as dirhams.
  assertEquals(cardLine({ name: "Dollar card", kind: "due_soon", due: "2026-10-07", owed: 300, currency: "USD", converted: false }, TODAY), "Dollar card · Payment due in 1d · USD 300 owed, not converted");
});

Deno.test("a budget passed says how far it is, and one over says so", () => {
  assertEquals(budgetLine({ category: "Groceries", threshold: 80, actual: 1600, budgeted: 2000 }), "Groceries · 80% of budget · AED 1,600 of AED 2,000");
  // Past the 90% threshold at 98%: the line gives the 98%, as its figures do.
  assertEquals(budgetLine({ category: "Groceries", threshold: 90, actual: 1960, budgeted: 2000 }), "Groceries · 98% of budget · AED 1,960 of AED 2,000");
  assertEquals(budgetLine({ category: "Groceries", threshold: 100, actual: 2100.25, budgeted: 2000 }), "Groceries · Over budget · AED 2,100.25 of AED 2,000");
});

Deno.test("unusual spending gives the month so far, the usual, and the biggest payment", () => {
  assertEquals(unusualLine({ category: "Eating Out", actual: 1200, avg: 600, biggest: { merchant: "Bistro", amount: 400 } }), "Eating Out · AED 1,200 this month · usually AED 600 · biggest AED 400 at Bistro");
  assertEquals(unusualLine({ category: "Eating Out", actual: 1200, avg: 600, biggest: null }), "Eating Out · AED 1,200 this month · usually AED 600");
});
