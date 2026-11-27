// The morning message's lines (the revamp, phase 8c; the UI review's T9):
// each nudge in a few words, in the bot's one format (botFormat.js). A
// bill not seen and a card due are worded as Overview's To do words them
// ("Rent · Late · was due 3 Oct", "Bank card · Payment due in 2d"); the
// month's nudges, which To do does not list, are written the same way. Cash
// cover's words are botFormat.js cashCoverLine, which the brief shares. Pure,
// so the words are tested on their own (morningWords.test.ts).
import { day, money } from "../../_shared/applib/botFormat.js";
import { householdToday } from "../../_shared/applib/day.js";

const DAY_MS = 86_400_000;

// "Rent · Late · was due 3 Oct · AED 6,500": a bill, or income, that has not
// shown up in Rokda some days after its date.
export function billLine(bill: { name: string; amount: number | string; due: string }, today = householdToday()): string {
  return `${bill.name} · Late · was due ${day(bill.due, today)} · ${money(Math.abs(Number(bill.amount)))}`;
}

// "Bank card · Payment due in 2d · AED 1,200 owed", as To do says it; a card
// still owing after its date is late. An amount with no AED value is given
// in its own currency, and says so, rather than read as dirhams (QA #4). The
// days are the ones the check worked out (daysUntilDue), when it gives them,
// so the line agrees with the card's due date whatever zone the clock is in.
export function cardLine(
  card: { name: string; kind: "due_soon" | "late"; due: string; daysUntil?: number; owed: number; currency: string; converted: boolean },
  today = householdToday(),
): string {
  const owed = card.converted ? `${money(card.owed)} owed` : `${money(card.owed, card.currency)} owed, not converted`;
  if (card.kind === "late") return `${card.name} · Late · was due ${day(card.due, today)} · ${owed}`;
  const days = card.daysUntil ?? Math.round((Date.parse(card.due) - Date.parse(today)) / DAY_MS);
  return `${card.name} · Payment due ${days <= 0 ? "today" : `in ${days}d`} · ${owed}`;
}

// "Groceries · 98% of budget · AED 1,960 of AED 2,000", or "Over budget".
// The share is the month's so far, not the threshold that set the nudge off,
// so it agrees with the figures beside it.
export function budgetLine(b: { category: string; threshold: number; actual: number; budgeted: number }): string {
  const share = b.threshold >= 100 ? "Over budget" : `${Math.max(b.threshold, Math.floor((b.actual / b.budgeted) * 100))}% of budget`;
  return `${b.category} · ${share} · ${money(b.actual)} of ${money(b.budgeted)}`;
}

// "Eating Out · AED 1,200 this month · usually AED 600 · biggest AED 400 at Bistro".
export function unusualLine(u: { category: string; actual: number; avg: number; biggest: { merchant: string; amount: number } | null }): string {
  const biggest = u.biggest ? ` · biggest ${money(u.biggest.amount)} at ${u.biggest.merchant}` : "";
  return `${u.category} · ${money(u.actual)} this month · usually ${money(u.avg)}${biggest}`;
}
