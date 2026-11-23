// The morning message's lines (checks/morningWords.ts): each nudge in a few
// words, in the bot's one format, worded as Overview's To do words the same
// kind of item. Pure, so tested on its own.
import { assertEquals } from "jsr:@std/assert@1";
import { billLine, budgetLine, cardLine, cashCoverLine, unusualLine } from "./morningWords.ts";

const TODAY = "2026-10-06";

Deno.test("a bill not seen is late, as To do says it, with its usual amount", () => {
  assertEquals(billLine({ name: "Rent", amount: -6500, due: "2026-10-03" }, TODAY), "Rent · Late · was due 3 Oct · AED 6,500");
  assertEquals(billLine({ name: "Salary", amount: 20000.5, due: "2026-09-28" }, TODAY), "Salary · Late · was due 28 Sep · AED 20,000.50");
});

Deno.test("a card due soon says when, as To do does, and one still owing after its date is late", () => {
  assertEquals(cardLine({ name: "Bank card", kind: "due_soon", due: "2026-10-06", owed: 1200, currency: "AED", converted: true }, TODAY), "Bank card · Payment due today · AED 1,200 owed");
  assertEquals(cardLine({ name: "Bank card", kind: "due_soon", due: "2026-10-08", owed: 1200, currency: "AED", converted: true }, TODAY), "Bank card · Payment due in 2d · AED 1,200 owed");
  assertEquals(cardLine({ name: "Bank card", kind: "late", due: "2026-10-01", owed: 1200, currency: "AED", converted: true }, TODAY), "Bank card · Late · was due 1 Oct · AED 1,200 owed");
  // No AED value: the amount in its own currency, never read as dirhams.
  assertEquals(cardLine({ name: "Dollar card", kind: "due_soon", due: "2026-10-07", owed: 300, currency: "USD", converted: false }, TODAY), "Dollar card · Payment due in 1d · USD 300 owed, not converted");
});

Deno.test("a budget passed says how far, and one over says so", () => {
  assertEquals(budgetLine({ category: "Groceries", threshold: 80, actual: 1600, budgeted: 2000 }), "Groceries · 80% of budget · AED 1,600 of AED 2,000");
  assertEquals(budgetLine({ category: "Groceries", threshold: 100, actual: 2100.25, budgeted: 2000 }), "Groceries · Over budget · AED 2,100.25 of AED 2,000");
});

Deno.test("unusual spending gives the month so far, the usual, and the biggest payment", () => {
  assertEquals(unusualLine({ category: "Eating Out", actual: 1200, avg: 600, biggest: { merchant: "Bistro", amount: 400 } }), "Eating Out · AED 1,200 this month · usually AED 600 · biggest AED 400 at Bistro");
  assertEquals(unusualLine({ category: "Eating Out", actual: 1200, avg: 600, biggest: null }), "Eating Out · AED 1,200 this month · usually AED 600");
});

Deno.test("cash cover gives its figures and verdict, and every caveat on a ⚠ line", () => {
  const base = { liquidAed: 5000, dueAed: 7000, days: 7, covered: false, certain: true, shortfallAed: 2000, unvalued: 0, unvaluedDue: 0 };
  assertEquals(cashCoverLine(base), "Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · short by AED 2,000");
  // A bill with no AED amount: what is due is a floor.
  assertEquals(cashCoverLine({ ...base, certain: false, unvaluedDue: 1 }), "Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · short by at least AED 2,000\n⚠ 1 bill due has no AED amount, so more is due");
  assertEquals(cashCoverLine({ ...base, covered: true, certain: false, unvaluedDue: 2, shortfallAed: 0, dueAed: 3000 }), "Cash cover · AED 5,000 liquid · AED 3,000 due in 7 days · can't say if covered\n⚠ 2 bills due have no AED amount, so more is due");
  // An account not converted: the liquid figure is low too.
  assertEquals(cashCoverLine({ ...base, unvalued: 1 }), "Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · short by AED 2,000\n⚠ Leaves out 1 account not converted");
  assertEquals(cashCoverLine({ ...base, certain: false, unvaluedDue: 1, unvalued: 1 }), "Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · can't say if covered\n⚠ 1 bill due has no AED amount, so more is due\n⚠ Leaves out 1 account not converted");
});
