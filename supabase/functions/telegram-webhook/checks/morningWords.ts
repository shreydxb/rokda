// The morning message's lines (the revamp, phase 8c; the UI review's T9):
// each nudge in a few words, in the bot's one format (botFormat.js). A
// bill not seen and a card due are worded as Overview's To do words them
// ("Rent · Late · was due 3 Oct", "Bank card · Payment due in 2d"); the
// month's nudges, which To do does not list, are written the same way. Pure,
// so the words are tested on their own (morningWords.test.ts).
import { day, money, notCounted } from "../../_shared/applib/botFormat.js";
import { householdToday } from "../../_shared/applib/day.js";

const DAY_MS = 86_400_000;

// "Rent · Late · was due 3 Oct · AED 6,500": a bill, or income, that has not
// shown up in Rokda some days after its date.
export function billLine(bill: { name: string; amount: number | string; due: string }, today = householdToday()): string {
  return `${bill.name} · Late · was due ${day(bill.due, today)} · ${money(Math.abs(Number(bill.amount)))}`;
}

// "Bank card · Payment due in 2d · AED 1,200 owed", as To do says it; a card
// still owing after its date is late. An amount with no AED value is given
// in its own currency, and says so, rather than read as dirhams (QA #4).
export function cardLine(
  card: { name: string; kind: "due_soon" | "late"; due: string; owed: number; currency: string; converted: boolean },
  today = householdToday(),
): string {
  const owed = card.converted ? `${money(card.owed)} owed` : `${money(card.owed, card.currency)} owed, not converted`;
  if (card.kind === "late") return `${card.name} · Late · was due ${day(card.due, today)} · ${owed}`;
  const days = Math.round((Date.parse(card.due) - Date.parse(today)) / DAY_MS);
  return `${card.name} · Payment due ${days <= 0 ? "today" : `in ${days}d`} · ${owed}`;
}

// "Groceries · 80% of budget · AED 1,600 of AED 2,000", or "Over budget".
export function budgetLine(b: { category: string; threshold: number; actual: number; budgeted: number }): string {
  return `${b.category} · ${b.threshold >= 100 ? "Over budget" : `${b.threshold}% of budget`} · ${money(b.actual)} of ${money(b.budgeted)}`;
}

// "Eating Out · AED 1,200 this month · usually AED 600 · biggest AED 400 at Bistro".
export function unusualLine(u: { category: string; actual: number; avg: number; biggest: { merchant: string; amount: number } | null }): string {
  const biggest = u.biggest ? ` · biggest ${money(u.biggest.amount)} at ${u.biggest.merchant}` : "";
  return `${u.category} · ${money(u.actual)} this month · usually ${money(u.avg)}${biggest}`;
}

type CashCover = { liquidAed: number; dueAed: number; days: number; covered: boolean; certain?: boolean; shortfallAed: number; unvalued?: number; unvaluedDue?: number };

// Cash cover, with what it leaves out on ⚠ lines of its own, as the brief
// writes a figure's caveat (8a). The verdict follows the shared sentence's
// rules (cashCover.js formatCashCoverLine, QA #4): a bill with no AED amount
// makes what is due a floor, so "covered" is not said, and a shortfall is
// "at least"; with an account not converted too, the liquid money is low as
// well, and no verdict is given. lead is "Cash cover · " in the morning's
// lines, and "Cash cover: " in the brief, whose lines are a label and its
// figure.
export function cashCoverLine(s: CashCover, lead = "Cash cover · "): string {
  const missing = s.unvaluedDue ?? 0;
  const unvalued = s.unvalued ?? 0;
  const short = money(s.shortfallAed);
  const verdict = missing > 0
    ? (s.covered || unvalued ? "can't say if covered" : `short by at least ${short}`)
    : (s.covered ? "covered" : `short by ${short}`);
  const lines = [`${lead}${money(s.liquidAed)} liquid · ${money(s.dueAed)} due in ${s.days} days · ${verdict}`];
  if (missing > 0) lines.push(`⚠ ${missing} ${missing === 1 ? "bill due has" : "bills due have"} no AED amount, so more is due`);
  if (unvalued) lines.push(`⚠ Leaves out ${notCounted({ accounts: unvalued })}`);
  return lines.join("\n");
}
