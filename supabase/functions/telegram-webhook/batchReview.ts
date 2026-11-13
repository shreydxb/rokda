// Reviewing a pasted batch in Telegram (docs/decisions.md, "A pasted batch
// is finished in Telegram"): the numbered list sent after a paste of several
// entries, and what a reply to it does. Reading the reply and writing the
// list are batch.ts.
//
// Each listed entry is bound to the list message through the same
// confirm_chat_id / confirm_message_id an entry's own "reply yes" prompt
// uses, so a message bound to two or more entries is a list. Only the member
// who pasted can answer it: every lookup is scoped to that member.
import { ALREADY_RECORDED_DAYS, alreadyRecordedAll } from "../_shared/applib/alreadyRecorded.js";
import { shortDay } from "../_shared/applib/autopay.js";
import { isConfirmationText, isReadyForFastConfirm } from "../_shared/applib/telegramConfirm.js";
import { BATCH_LIST_CAP, batchListMessage, type ListedEntry, parseBatchReply } from "./batch.ts";
import { type PendingIntakeRow, RECENT_INTAKE_COLUMNS } from "./confirmations.ts";
import { supabase } from "./env.ts";
import { findDuplicateTransaction, type IntakeKind } from "./intake.ts";
import { reply } from "./transport.ts";

export const BATCH_REPLY_HINT = 'Reply to the list with the day they were paid, like "all on 2 Oct", or numbers for some, like "1-3 on 2 Oct". "drop 2" sets one aside.';
export const BATCH_UNADDRESSED_HINT = "To record a list, reply to the list itself (long-press it, then Reply), so I know which one you mean.";

type BatchRow = PendingIntakeRow & { date_guessed?: boolean | null; source_ref?: string | null };

// What the capture loop saved of one item of a paste.
export type SavedItem = {
  id: string;
  row: {
    parsed_merchant: string | null;
    parsed_amount: number | null;
    parsed_date: string | null;
    parsed_category_id: string | null;
    parsed_currency: string | null;
    parsed_account_id: string | null;
    parsed_kind: string;
    confidence: number;
    date_guessed: boolean;
  };
  accountName: string | null;
  categoryName: string | null;
};

function aed(amount: number | string | null): string {
  return `AED ${Number(amount ?? 0).toFixed(2)}`;
}

// Read in full apart from the date, which a reply to the list can give.
function listable(row: SavedItem["row"]): boolean {
  return isReadyForFastConfirm({ ...row, date_guessed: false });
}

// The first thing an entry is missing, as the list names it.
function missingReason(row: SavedItem["row"]): string {
  if (!(Number(row.parsed_amount) > 0)) return "no amount";
  if (!row.parsed_merchant) return "no merchant";
  if (!row.parsed_account_id) return "no card matched";
  if (!row.parsed_category_id) return "no category";
  if (row.parsed_currency && row.parsed_currency !== "AED") return `in ${row.parsed_currency}`;
  return "not sure I read it right";
}

// The ids of the saved items that are already in Rokda: undated ones by the
// Inbox's own rule (alreadyRecorded.js), dated ones as a single entry's
// "reply yes" is checked. Null when that cannot be read: the list is not sent
// then, rather than offering entries that might be repeats.
async function alreadyRecordedIds(householdId: string, items: SavedItem[]): Promise<Set<string> | null> {
  const found = new Set<string>();
  try {
    const undated = items.filter((i) => i.row.date_guessed).map((i) => ({ ...i.row, id: i.id }));
    if (undated.length) {
      const days = undated.map((i) => i.parsed_date!).sort();
      const from = new Date(Date.parse(days[0]) - ALREADY_RECORDED_DAYS * 86400000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from("transactions")
        .select("id, account_id, amount, kind, merchant, occurred_at")
        .eq("household_id", householdId)
        .in("account_id", [...new Set(undated.map((i) => i.parsed_account_id!))])
        .gte("occurred_at", from)
        .lte("occurred_at", days.at(-1)!);
      if (error) return null;
      for (const id of alreadyRecordedAll(undated, data ?? [], []).keys()) found.add(id);
    }
    for (const item of items.filter((i) => !i.row.date_guessed)) {
      const r = item.row;
      if (await findDuplicateTransaction(householdId, r.parsed_account_id, r.parsed_merchant, r.parsed_amount, r.parsed_date)) found.add(item.id);
    }
  } catch {
    return null;
  }
  return found;
}

// Sends the numbered list for a paste of several entries and binds each
// listed entry to it. False when there is no list to send (fewer than two
// entries read in full and not already recorded, or the check for repeats
// could not be made): the paste is then answered as before, pointing to the
// Inbox. extraLines follow the list (what could not be saved, a dividend left
// out).
export async function sendBatchList(chatId: number, householdId: string, saved: SavedItem[], extraLines: string[]): Promise<boolean> {
  const candidates = saved.filter((s) => listable(s.row));
  const waiting = saved.filter((s) => !listable(s.row)).map((s) => ({ merchant: s.row.parsed_merchant, reason: missingReason(s.row) }));
  if (candidates.length < 2) return false;
  const recordedIds = await alreadyRecordedIds(householdId, candidates);
  if (!recordedIds) return false;
  const fresh = candidates.filter((c) => !recordedIds.has(c.id));
  if (fresh.length < 2) return false;
  const listed = fresh.slice(0, BATCH_LIST_CAP);
  const entries: ListedEntry[] = listed.map((s) => ({
    amount: Number(s.row.parsed_amount),
    merchant: s.row.parsed_merchant!,
    account: s.accountName ?? "account",
    category: s.categoryName ?? "category",
    undated: s.row.date_guessed,
  }));
  const recorded = candidates.filter((c) => recordedIds.has(c.id)).map((c) => ({ merchant: c.row.parsed_merchant!, amount: Number(c.row.parsed_amount) }));
  const text = [batchListMessage(entries, { recorded, waiting, overCap: fresh.length - listed.length }), ...extraLines.filter(Boolean)].join("\n");
  const messageId = await reply(chatId, text);
  if (messageId == null) return true;
  const { error } = await supabase
    .from("intake")
    .update({ confirm_chat_id: chatId, confirm_message_id: messageId })
    .in("id", listed.map((s) => s.id))
    .eq("status", "pending");
  if (error) await reply(chatId, "I couldn't link that list to its entries, so a reply to it won't work. They're all in the Inbox to review.");
  return true;
}

// Capture order: the message's first item has the update's own source_ref,
// the rest "<update>#1", "<update>#2", ... (compared as numbers, so #10 comes
// after #9).
function captureIndex(row: BatchRow): number {
  const m = /#(\d+)$/.exec(String(row.source_ref ?? ""));
  return m ? Number(m[1]) : 0;
}

// The entries bound to the message a reply or reaction names, for this
// member, in the order the list numbered them; whatever their status now, so
// the numbers keep meaning what the list said. A list is two or more.
export async function batchForPrompt(householdId: string, memberId: string, chatId: number, messageId: number | null): Promise<BatchRow[] | "failed"> {
  if (messageId == null) return [];
  const { data, error } = await supabase
    .from("intake")
    .select(`${RECENT_INTAKE_COLUMNS}, source_ref`)
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .eq("confirm_chat_id", chatId)
    .eq("confirm_message_id", messageId);
  if (error) return "failed";
  return ((data ?? []) as BatchRow[]).sort((a, b) => captureIndex(a) - captureIndex(b));
}

// Whether this member has a list with entries still waiting: an unaddressed
// batch command is then told to reply to the list, never applied to one.
export async function hasOpenList(householdId: string, memberId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("intake")
    .select("confirm_message_id")
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .eq("status", "pending")
    .not("confirm_message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return false;
  const seen = new Map<number, number>();
  for (const r of (data ?? []) as Array<{ confirm_message_id: number }>) seen.set(r.confirm_message_id, (seen.get(r.confirm_message_id) ?? 0) + 1);
  return [...seen.values()].some((n) => n >= 2);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// A reply to a list. Nothing is done unless the whole reply can be: a number
// not on the list, or a day missing for an entry with none, refuses it all.
export async function handleBatchReply(chatId: number, member: { id: string; household_id: string }, rows: BatchRow[], text: string, today: string): Promise<void> {
  const command = parseBatchReply(text, today);
  if (!command) {
    await reply(chatId, isConfirmationText(text) ? `"Yes" alone doesn't say which day they were paid. ${BATCH_REPLY_HINT}` : `${BATCH_REPLY_HINT} To change an entry, open it in the Inbox.`);
    return;
  }
  if (command.kind === "invalid") {
    await reply(chatId, `${command.reason} Nothing done yet.`);
    return;
  }
  const numbers = command.kind === "all" ? rows.map((_, i) => i + 1) : command.numbers;
  const outside = numbers.filter((n) => n > rows.length);
  if (outside.length) {
    await reply(chatId, `There's no ${outside.join(", ")} on that list: it runs 1 to ${rows.length}. Nothing done yet.`);
    return;
  }
  const targets = numbers.map((n) => rows[n - 1]);
  const pending = targets.filter((r) => r.status === "pending");
  const settled = targets.length - pending.length;
  const settledLead = settled ? `${settled === targets.length ? (settled === 1 ? "That one was" : `Those ${settled} were`) : plural(settled, "was", "were")} already settled.` : "";

  if (command.kind === "drop") {
    const dropped: BatchRow[] = [];
    let failed = 0;
    for (const row of pending) {
      const { data, error } = await supabase.from("intake").update({ status: "rejected" }).eq("id", row.id).eq("status", "pending").select("id");
      if (error) failed++;
      else if (data?.length) dropped.push(row);
    }
    const lines: string[] = [];
    if (dropped.length) lines.push(`Set aside ${dropped.length} (${dropped.map((r) => `${r.parsed_merchant}, ${aed(r.parsed_amount)}`).join("; ")}).`);
    if (settled || pending.length - dropped.length - failed > 0) lines.push(settledLead || "Already settled.");
    if (failed) lines.push(`I couldn't set aside ${failed}: try again, or use the Inbox.`);
    await reply(chatId, lines.join(" ") || "Nothing to set aside.");
    return;
  }

  // A day is for entries the SMS gave none: it is never put over a date the
  // bank's own text gave, and an entry without one is never recorded without it.
  const undated = pending.filter((r) => r.date_guessed);
  if (!command.date && undated.length) {
    await reply(chatId, `${plural(undated.length, "has", "have")} no date in the SMS: say the day ${undated.length === 1 ? "it was" : "they were"} paid, like "${command.kind === "all" ? "all" : numbers.join(", ")} on 2 Oct". Nothing recorded yet.`);
    return;
  }
  if (command.date && pending.length && !undated.length) {
    await reply(chatId, `${pending.length === 1 ? "That one has its" : "These have their"} own dates from the SMS, so reply "${command.kind === "all" ? "all" : numbers.join(", ")}" without a day. Nothing recorded yet.`);
    return;
  }

  const recorded: Array<{ row: BatchRow; day: string }> = [];
  const repeats: BatchRow[] = [];
  const changed: BatchRow[] = [];
  let alreadyDone = settled;
  let failed = 0;
  const madeNow: string[] = [];
  for (const row of pending) {
    // Edited in the Inbox since the list was sent: left there.
    if (!isReadyForFastConfirm({ ...row, date_guessed: false })) {
      changed.push(row);
      continue;
    }
    const day = row.date_guessed ? command.date! : row.parsed_date!;
    try {
      if (await findDuplicateTransaction(member.household_id, row.parsed_account_id, row.parsed_merchant, row.parsed_amount, day, madeNow)) {
        repeats.push(row);
        continue;
      }
      const { data, error } = await supabase.rpc("approve_intake", {
        p_intake_id: row.id,
        p_account_id: row.parsed_account_id,
        p_amount: row.parsed_amount,
        p_occurred_at: day,
        p_kind: (row.parsed_kind as IntakeKind | null) ?? "expense",
        p_category_id: row.parsed_category_id,
        p_currency: "AED",
        p_merchant: row.parsed_merchant,
        ...(row.date_guessed ? { p_date_confirmed: true } : {}),
      });
      if (error) {
        // Set aside, or approved, in the app since the rows were read.
        const { data: now } = await supabase.from("intake").select("status").eq("id", row.id).maybeSingle();
        if (now && now.status !== "pending") alreadyDone++;
        else failed++;
        continue;
      }
      const result = data as { transaction_id?: string; already_approved?: boolean } | null;
      if (result?.already_approved) {
        alreadyDone++;
        continue;
      }
      if (result?.transaction_id) madeNow.push(result.transaction_id);
      recorded.push({ row, day });
    } catch {
      failed++;
    }
  }

  const lines: string[] = [];
  if (recorded.length) {
    const days = [...new Set(recorded.map((r) => r.day))];
    lines.push(`Recorded ${recorded.length}${days.length === 1 ? ` on ${shortDay(days[0])}` : ""}.`);
  } else if (!repeats.length && !changed.length && !failed) {
    lines.push(alreadyDone ? `Nothing to record: ${alreadyDone === targets.length && alreadyDone > 1 ? `those ${alreadyDone} were` : plural(alreadyDone, "was", "were")} already settled.` : "Nothing to record.");
    await reply(chatId, lines.join(" "));
    return;
  }
  if (alreadyDone) lines.push(`${plural(alreadyDone, "was", "were")} already settled.`);
  if (repeats.length) lines.push(`${plural(repeats.length, "looks", "look")} already recorded (${repeats.map((r) => `${r.parsed_merchant}, ${aed(r.parsed_amount)}`).join("; ")}), so ${repeats.length === 1 ? "it's" : "they're"} left in the Inbox.`);
  if (changed.length) lines.push(`${plural(changed.length, "was", "were")} changed in the Inbox since, so left there.`);
  if (failed) lines.push(`I couldn't record ${failed}: ${failed === 1 ? "it's" : "they're"} still in the Inbox.`);
  const untouched = rows.filter((r, i) => r.status === "pending" && !numbers.includes(i + 1)).length;
  if (untouched) lines.push(`${plural(untouched, "still waits", "still wait")} in the Inbox.`);
  await reply(chatId, lines.join(" "));
}
