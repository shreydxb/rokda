// What the bot says about a transfer or a goal contribution it proposes (the
// revamp, phase 8b; the UI review's T14 and T16), and the buttons that answer
// it. The proposal is one line, with Record and Cancel under it; once
// answered, the message becomes what was done: a tick line, or "Cancelled".
// Written through the bot's one format (_shared/applib/botFormat.js). A
// trade's words are trades.ts; its buttons are here, as every proposal's are.
import { day, money } from "../_shared/applib/botFormat.js";
import { householdToday } from "../_shared/applib/day.js";
import { encodeChoice, type Keyboard } from "./choices.ts";

// The proposals answered with buttons. Balances, an autopay bill and
// dividends are asked about by the morning checks, which take their typed
// answers until they are rebuilt (phase 8c).
export const BUTTON_KINDS = new Set(["transfer", "goal_contribution", "trade", "trade_undo"]);

const LABELS: Record<string, [string, string]> = {
  transfer: ["Record", "Cancel"],
  goal_contribution: ["Record", "Cancel"],
  trade: ["Save", "Cancel"],
  trade_undo: ["Undo trade", "Cancel"],
};

// The buttons under an autopay bill's question (the revamp, phase 8c; review
// T10): Paid records it at the scheduled amount, Not yet asks again
// tomorrow, Other amount asks for the amount as a typed answer.
export function autopayKeyboard(proposalId: string): Keyboard {
  return { inline_keyboard: [[{ text: "Paid", callback_data: encodeChoice("P", proposalId) }, { text: "Not yet", callback_data: encodeChoice("N", proposalId) }], [{ text: "Other amount", callback_data: encodeChoice("O", proposalId) }]] };
}

// The buttons under a dividend question (the revamp, phase 8c; review T12):
// Received records them, Leave for the app leaves them, Not yet asks again
// tomorrow. About a balance confirmed on or after the pay date: Already in
// the balance records them as in it (P), Arrived after as moving the fund
// (X: a "no", as it is typed), and Not yet.
export function dividendsKeyboard(proposalId: string, asksAboutBalance: boolean): Keyboard {
  const [yes, no] = asksAboutBalance ? ["Already in the balance", "Arrived after"] : ["Received", "Leave for the app"];
  const notYet = { text: "Not yet", callback_data: encodeChoice("N", proposalId) };
  const first = { text: yes, callback_data: encodeChoice("P", proposalId) };
  const second = { text: no, callback_data: encodeChoice("X", proposalId) };
  return { inline_keyboard: asksAboutBalance ? [[first, second], [notYet]] : [[first, notYet], [second]] };
}

// The buttons under a proposal: P applies it, X cancels it. Both name the
// proposal, and a tap is checked against it (confirmations.ts).
export function proposalKeyboard(kind: string, proposalId: string): Keyboard | null {
  const labels = LABELS[kind];
  if (!labels) return null;
  return { inline_keyboard: [[{ text: labels[0], callback_data: encodeChoice("P", proposalId) }, { text: labels[1], callback_data: encodeChoice("X", proposalId) }]] };
}

type TransferFacts = { amount?: unknown; from_name?: unknown; to_name?: unknown; occurred_at?: unknown };
type GoalFacts = { amount?: unknown; goal_name?: unknown; name?: unknown; occurred_at?: unknown };

function dayOf(value: unknown, today: string): string | null {
  return typeof value === "string" && value ? day(value, today) : null;
}

// "Transfer AED 3,000 · Current account → Savings · 20 Sep".
export function transferLine(t: TransferFacts, today = householdToday()): string {
  const when = dayOf(t.occurred_at, today);
  return `Transfer ${money(t.amount as number)} · ${String(t.from_name ?? "one account")} → ${String(t.to_name ?? "another")}${when ? ` · ${when}` : ""}`;
}

// "AED 500 toward House · 3 Oct".
export function goalLine(g: GoalFacts, today = householdToday()): string {
  const when = dayOf(g.occurred_at, today);
  return `${money(g.amount as number)} toward ${String(g.goal_name ?? g.name ?? "the goal")}${when ? ` · ${when}` : ""}`;
}

// What a transfer or goal proposal would do, from what was saved with it.
export function proposalLine(kind: string, payload: Record<string, unknown>, today = householdToday()): string {
  return kind === "transfer" ? transferLine(payload, today) : goalLine(payload, today);
}

type AppliedTransfer = TransferFacts & { joined_out?: boolean; joined_in?: boolean; already_recorded?: boolean };

// A transfer that took over a side already in Rokda (the payment pasted from
// the bank's SMS, say) says so, since that side stops counting as spending.
function joinedLine(t: AppliedTransfer): string | null {
  if (t.joined_out && t.joined_in) return "Joined to both sides already in Rokda";
  if (t.joined_out) return `Joined to the payment out of ${String(t.from_name)} already in Rokda`;
  if (t.joined_in) return `Joined to the money into ${String(t.to_name)} already in Rokda`;
  return null;
}

// What a transfer or goal contribution's message becomes once applied, from
// the database's answer (the record of a write, never the model's words),
// and whether it had been recorded before. Null when nothing was recorded:
// an account closed, or the goal gone, since it was proposed.
export function appliedLine(result: { kind?: string; applied?: Array<Record<string, unknown>> } | null, today = householdToday()): { line: string; what: string; already: boolean } | null {
  const done = result?.applied?.[0];
  if (!done) return null;
  if (result?.kind === "transfer") {
    const what = transferLine(done, today);
    return { line: [`✓ ${what}`, joinedLine(done as AppliedTransfer)].filter(Boolean).join("\n"), what, already: done.already_recorded === true };
  }
  const what = goalLine(done, today);
  return { line: `✓ ${what}`, what, already: done.already_recorded === true };
}

// Said when a transfer's account or a goal is gone by the time it is applied.
export function notRecordedLine(kind: string): string {
  return kind === "transfer" ? "Couldn't record that: one of those accounts is closed." : "Couldn't record that: the goal is gone.";
}

export const LAPSED_TOAST = "That lapsed. Send it again if it still holds.";
