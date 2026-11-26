// Reviewing a pasted batch in Telegram (docs/decisions.md, "A pasted batch
// is finished in Telegram", and the revamp's phase 8b, "A pasted list is
// answered with buttons"): the numbered list sent after a paste of several
// entries, its buttons, and what a tap or a reply to it does. Reading a reply
// and writing the list are batch.ts.
//
// Each listed entry is bound to the list message through the same
// confirm_chat_id / confirm_message_id an entry's own message uses, so a
// message bound to two or more entries is a list. Only the member who pasted
// can answer it: every lookup is scoped to that member. A tap or reply records
// only what the list shows: the list's own text comes with it, and an entry
// that reads differently now was changed in the Inbox and is left there.
import { ALREADY_RECORDED_DAYS, alreadyRecordedAll } from "../_shared/applib/alreadyRecorded.js";
import { day, facts } from "../_shared/applib/botFormat.js";
import { householdToday } from "../_shared/applib/day.js";
import { isPrivateChat } from "../_shared/applib/telegramChat.js";
import { isConfirmationText, isReadyForFastConfirm } from "../_shared/applib/telegramConfirm.js";
import { type BatchCommand, BATCH_LIST_CAP, batchListMessage, chooseKeyboard, type ListedEntry, listedLines, listKeyboard, listLine, type ListMark, listNumbers, type ListOp, parseBatchReply, readBatchDate, renderList } from "./batch.ts";
import { edit } from "./choices.ts";
import { type PendingIntakeRow, RECENT_INTAKE_COLUMNS } from "./confirmations.ts";
import { supabase } from "./env.ts";
import { findDuplicateTransaction, type IntakeKind } from "./intake.ts";
import { reply, tgCall } from "./transport.ts";

export const BATCH_REPLY_HINT = 'Tap a button on the list, or reply to it like "all on 2 Oct", "1-3" or "drop 2".';
export const BATCH_UNADDRESSED_HINT = "Which one? Use the buttons on the list, or reply to it.";
export const LIST_WHICH_DAY = 'Which day? Tap Today or Yesterday on the list, or reply like "all on 2 Oct".';
export const LIST_USE_BUTTONS = "Use the buttons on the list, or reply to it.";
const LIST_UNREADABLE = "I can't see that list, so I won't record from it. They're in the Inbox.";
const LIST_CHECK_FAILED = "Couldn't check that just now. Nothing changed — try again in a minute.";

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

// Read in full apart from the date, which a reply to the list can give.
function listable(row: SavedItem["row"]): boolean {
  return isReadyForFastConfirm({ ...row, date_guessed: false });
}

// The first thing an entry is missing, as the list names it, in the words
// an entry's own message uses (expenseMessages.ts).
function missingReason(row: SavedItem["row"]): string {
  if (!(Number(row.parsed_amount) > 0)) return "needs the amount";
  if (!row.parsed_merchant) return "needs who was paid";
  if (!row.parsed_account_id) return "needs the card or account";
  if (!row.parsed_category_id) return "needs a category";
  if (row.parsed_currency && row.parsed_currency !== "AED") return `in ${row.parsed_currency}`;
  return "to check: not sure I read it right";
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
    date: s.row.date_guessed ? null : s.row.parsed_date,
    undated: s.row.date_guessed,
  }));
  const recorded = candidates.filter((c) => recordedIds.has(c.id)).map((c) => ({ merchant: c.row.parsed_merchant!, amount: Number(c.row.parsed_amount) }));
  const text = [batchListMessage(entries, { recorded, waiting, overCap: fresh.length - listed.length }), ...extraLines.filter(Boolean)].join("\n");
  const messageId = await reply(chatId, text, listKeyboard(entries.some((e) => e.undated)));
  if (messageId == null) return true;
  const { error } = await supabase
    .from("intake")
    .update({ confirm_chat_id: chatId, confirm_message_id: messageId })
    .in("id", listed.map((s) => s.id));
  if (error) {
    // Unbound, the list's buttons would act on nothing: they go.
    await tgCall("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => null);
    await reply(chatId, "Couldn't link that list to its entries. They're in the Inbox.");
  }
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

// The lines each row would have on the list now, by row id, to compare with
// the line the list showed: as this list writes it, on the day it was sent
// (so a day written "28 Dec" on 30 December still matches in January), and
// as a list sent before the one format wrote it ("AED 20.00 · City Taxi ·
// Card · Transport"), so a reply to one sent before the change still
// records. Null when the names cannot be read.
async function currentLines(rows: BatchRow[]): Promise<Map<string, string[]> | null> {
  const accountIds = [...new Set(rows.map((r) => r.parsed_account_id).filter(Boolean))] as string[];
  const categoryIds = [...new Set(rows.map((r) => r.parsed_category_id).filter(Boolean))] as string[];
  const [accounts, categories] = await Promise.all([
    supabase.from("accounts").select("id, name").in("id", accountIds),
    supabase.from("categories").select("id, name").in("id", categoryIds),
  ]);
  if (accounts.error || categories.error) return null;
  const name = (list: Array<{ id: string; name: string }> | null, id: string | null) => (list ?? []).find((x) => x.id === id)?.name ?? "";
  return new Map(rows.map((r) => {
    const facts = { amount: Number(r.parsed_amount), merchant: r.parsed_merchant ?? "", account: name(accounts.data, r.parsed_account_id), category: name(categories.data, r.parsed_category_id) };
    const sentOn = householdToday(new Date(r.created_at));
    return [r.id, [listLine({ ...facts, date: r.date_guessed ? null : r.parsed_date }, sentOn), `AED ${facts.amount.toFixed(2)} · ${facts.merchant} · ${facts.account} · ${facts.category}`]];
  }));
}

// Which of these messages are lists: bound to two or more of this member's
// entries, whatever their status now. A bare "yes" or "no", or a correction,
// must never reach an entry on a list, even the last one waiting: it would
// record or change it without the list's check, and write over the list.
// Failed when that cannot be read.
export async function listPrompts(householdId: string, memberId: string, chatId: number, messageIds: number[]): Promise<Set<number> | "failed"> {
  if (!messageIds.length) return new Set();
  const { data, error } = await supabase
    .from("intake")
    .select("confirm_message_id")
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .eq("confirm_chat_id", chatId)
    .in("confirm_message_id", messageIds);
  if (error) return "failed";
  const seen = new Map<number, number>();
  for (const r of (data ?? []) as Array<{ confirm_message_id: number }>) seen.set(Number(r.confirm_message_id), (seen.get(Number(r.confirm_message_id)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n >= 2).map(([id]) => id));
}

// What became of the entries a command named: a refusal before anything was
// done, or what each became (by its place on the list) and a summary.
type ListOutcome =
  | { kind: "refused"; text: string }
  | { kind: "done"; marks: Map<number, ListMark>; summary: string };

function count(n: number, what: string): string | null {
  return n ? `${n} ${what}` : null;
}

// Acts on a list. A number not on the list, or a day missing for an entry
// with none, refuses it all before anything is done. listText is the list as
// Telegram sends it back with a tap or a reply: an entry whose line now reads
// differently was changed in the Inbox since, and is left there, so nothing
// is recorded at an amount the list did not show. "all" is every entry the
// list still numbers.
async function actOnList(member: { id: string; household_id: string }, rows: BatchRow[], command: BatchCommand, today: string, listText: string | null): Promise<ListOutcome> {
  const shown = listedLines(listText ?? "");
  const numbers = command.kind === "all" ? [...shown.keys()].sort((a, b) => a - b) : command.numbers;
  if (command.kind === "all" && !shown.size) return { kind: "refused", text: LIST_UNREADABLE };
  const outside = numbers.filter((n) => n > rows.length || n < 1);
  if (outside.length) return { kind: "refused", text: `There's no ${outside.join(", ")} on that list: it runs 1 to ${rows.length}. Nothing done yet.` };
  const targets = numbers.map((n) => ({ row: rows[n - 1], at: n - 1 }));
  const pending = targets.filter((t) => t.row.status === "pending");
  const settled = targets.length - pending.length;
  const marks = new Map<number, ListMark>();
  const offeredAfter = (done: Set<number>) => [...shown.keys()].filter((n) => rows[n - 1]?.status === "pending" && !done.has(n - 1) && !numbers.includes(n)).length;

  if (command.kind === "drop") {
    let failed = 0;
    for (const { row, at } of pending) {
      const { data, error } = await supabase.from("intake").update({ status: "rejected" }).eq("id", row.id).eq("member_id", member.id).eq("status", "pending").select("id");
      if (error) failed++;
      else if (data?.length) marks.set(at, "dropped");
    }
    const dropped = marks.size;
    const already = settled + pending.length - dropped - failed;
    const parts = [dropped ? `Cancelled ${dropped}` : null, count(already, "already settled"), failed ? `Couldn't cancel ${failed} — try again in a minute` : null, count(offeredAfter(new Set(marks.keys())), "still on the list")].filter(Boolean);
    return { kind: "done", marks, summary: dropped || failed ? `${parts.join(" · ")}.` : `Nothing to cancel${already ? `: ${already} already settled` : ""}.` };
  }

  // A day is for entries the SMS gave none: it is never put over a date the
  // bank's own text gave, and an entry without one is never recorded without it.
  const undated = pending.filter((t) => t.row.date_guessed);
  const named = command.kind === "all" ? "all" : numbers.join(", ");
  if (!command.date && undated.length) {
    return { kind: "refused", text: `${undated.length} ${undated.length === 1 ? "has" : "have"} no date in the SMS: say the day ${undated.length === 1 ? "it was" : "they were"} paid, like "${named} on 2 Oct". Nothing recorded yet.` };
  }
  // The payments came before the paste: a later day is a slip.
  const pastedOn = undated.map((t) => householdToday(new Date(t.row.created_at))).sort()[0];
  if (command.date && pastedOn && command.date > pastedOn) {
    return { kind: "refused", text: `They were pasted on ${day(pastedOn, today)}, so they were paid by then: say that day or an earlier one. Nothing recorded yet.` };
  }
  if (command.date && pending.length && !undated.length) {
    return { kind: "refused", text: `${pending.length === 1 ? "That one has its" : "These have their"} own dates from the SMS, so reply "${named}" without a day. Nothing recorded yet.` };
  }
  if (!shown.size) return { kind: "refused", text: LIST_UNREADABLE };
  const now = await currentLines(pending.map((t) => t.row));
  if (!now) return { kind: "refused", text: "Couldn't check those against the list just now. Nothing recorded — try again in a minute." };

  const days: string[] = [];
  let alreadyDone = settled;
  let failed = 0;
  const madeNow: string[] = [];
  for (const { row, at } of pending) {
    // Edited in the Inbox since the list was sent: left there.
    if (!isReadyForFastConfirm({ ...row, date_guessed: false }) || !now.get(row.id)?.includes(shown.get(at + 1) ?? "")) {
      marks.set(at, "changed");
      continue;
    }
    const when = row.date_guessed ? command.date! : row.parsed_date!;
    try {
      if (await findDuplicateTransaction(member.household_id, row.parsed_account_id, row.parsed_merchant, row.parsed_amount, when, madeNow)) {
        marks.set(at, "repeat");
        continue;
      }
      const { data, error } = await supabase.rpc("approve_intake", {
        p_intake_id: row.id,
        p_account_id: row.parsed_account_id,
        p_amount: row.parsed_amount,
        p_occurred_at: when,
        p_kind: (row.parsed_kind as IntakeKind | null) ?? "expense",
        p_category_id: row.parsed_category_id,
        p_currency: "AED",
        p_merchant: row.parsed_merchant,
        ...(row.date_guessed ? { p_date_confirmed: true } : {}),
      });
      if (error) {
        // Set aside, or approved, in the app since the rows were read.
        const { data: fresh } = await supabase.from("intake").select("status").eq("id", row.id).maybeSingle();
        if (fresh && fresh.status !== "pending") alreadyDone++;
        else failed++;
        continue;
      }
      const result = data as { transaction_id?: string; already_approved?: boolean } | null;
      if (result?.already_approved) {
        alreadyDone++;
        continue;
      }
      if (result?.transaction_id) madeNow.push(result.transaction_id);
      marks.set(at, "recorded");
      days.push(when);
    } catch {
      failed++;
    }
  }

  const recorded = days.length;
  const inbox = [...marks.values()].filter((m) => m === "changed" || m === "repeat").length;
  if (!recorded && !inbox && !failed) {
    return { kind: "done", marks, summary: `Nothing to record${alreadyDone ? `: ${alreadyDone} already settled` : ""}.` };
  }
  const oneDay = new Set(days).size === 1 ? ` on ${day(days[0], today)}` : "";
  const parts = [
    recorded ? `Recorded ${recorded}${oneDay}` : null,
    count(inbox, "in the Inbox"),
    count(alreadyDone, "already settled"),
    failed ? `Couldn't record ${failed} — try again in a minute` : null,
    count(offeredAfter(new Set(marks.keys())), "still on the list"),
  ].filter(Boolean);
  return { kind: "done", marks, summary: `${parts.join(" · ")}.` };
}

// Shows the list again as its entries now stand, with the buttons that fit
// what it still offers (batch.ts renderList). Read afresh, so an entry settled
// in the app since says so.
async function showList(chatId: number, listId: number, listText: string | null, member: { id: string; household_id: string }, marks: Map<number, ListMark>): Promise<void> {
  if (!listText) return;
  const rows = await batchForPrompt(member.household_id, member.id, chatId, listId);
  if (rows === "failed" || rows.length < 2) return;
  const view = renderList(listText, listState(rows), marks);
  if (!view) return;
  await edit(chatId, listId, view.text, view.offered.length ? listKeyboard(view.undated) : null);
}

function listState(rows: BatchRow[]): Array<{ status: string; undated: boolean; merchant: string | null }> {
  return rows.map((r) => ({ status: r.status, undated: r.date_guessed === true, merchant: r.parsed_merchant }));
}

// A reply to a list. "yes" reads as "all" when every entry it offers has its
// day; anything that is not a command is told how to answer.
export async function handleBatchReply(chatId: number, member: { id: string; household_id: string }, rows: BatchRow[], text: string, today: string, listText: string | null, listId: number): Promise<void> {
  let command = parseBatchReply(text, today);
  if (!command) {
    if (!isConfirmationText(text)) {
      await reply(chatId, BATCH_REPLY_HINT);
      return;
    }
    const view = renderList(listText ?? "", listState(rows), new Map());
    if (!view) {
      await reply(chatId, LIST_UNREADABLE);
      return;
    }
    if (!view.offered.length) {
      await reply(chatId, "Nothing left to record on that list.");
      return;
    }
    if (view.undated) {
      await reply(chatId, LIST_WHICH_DAY);
      return;
    }
    command = { kind: "all", date: null };
  }
  if (command.kind === "invalid") {
    await reply(chatId, `${command.reason} Nothing done yet.`);
    return;
  }
  const outcome = await actOnList(member, rows, command, today, listText);
  if (outcome.kind === "refused") {
    await reply(chatId, outcome.text);
    return;
  }
  await reply(chatId, outcome.summary);
  await showList(chatId, listId, listText, member, outcome.marks);
}

// A 👍 on a list. A reaction carries no text, so it cannot be checked against
// what the list showed, nor tell which of its buttons are there: it records
// nothing, and points to the list.
export async function handleListReaction(chatId: number, rows: BatchRow[]): Promise<void> {
  await reply(chatId, rows.some((r) => r.status === "pending") ? LIST_USE_BUTTONS : "Nothing left to record on that list.");
}

// A tap on one of the list's buttons (batch.ts). Only the member who pasted
// it, on the list itself, as Telegram sends it back: its text is what the
// entries are checked against. Always answered, so Telegram stops the
// button's spinner; a refusal comes as an alert, since it needs reading.
export async function handleListTap(callback: Record<string, unknown>, op: ListOp, mask: number): Promise<Response> {
  const from = callback.from as { id?: number } | undefined;
  const message = callback.message as { message_id?: number; chat?: Record<string, unknown>; text?: string } | undefined;
  const chatId = message?.chat?.id as number | undefined;
  const listId = message?.message_id;
  const toast = (text = "", alert = false) => tgCall("answerCallbackQuery", { callback_query_id: callback.id, ...(text ? { text } : {}), ...(alert ? { show_alert: true } : {}) }).catch(() => null);
  if (!from?.id || !chatId || !listId || !isPrivateChat(message?.chat) || chatId !== from.id) {
    await toast();
    return new Response("ok");
  }
  const { data: member, error } = await supabase.from("household_members").select("id, household_id").eq("telegram_user_id", from.id).maybeSingle();
  const rows = member ? await batchForPrompt(member.household_id, member.id, chatId, listId) : [];
  if (error || rows === "failed") {
    await toast(LIST_CHECK_FAILED);
    return new Response("ok");
  }
  if (!member || rows.length < 2) {
    await toast("That isn't one of yours.");
    return new Response("ok");
  }
  const listText = typeof message?.text === "string" ? message.text : "";
  const view = renderList(listText, listState(rows), new Map());
  if (!view) {
    await toast(LIST_UNREADABLE, true);
    return new Response("ok");
  }
  const markup = (keyboard: unknown) => tgCall("editMessageReplyMarkup", { chat_id: chatId, message_id: listId, reply_markup: keyboard ?? { inline_keyboard: [] } }).catch(() => null);
  // Settled since the list was last drawn (in the app, say): shown as it
  // stands, with the buttons that fit, rather than acted on.
  if (!view.offered.length) {
    await toast("Nothing left to record on that list.");
    await showList(chatId, listId, listText, member, new Map());
    return new Response("ok");
  }
  // Only entries the list still offers can be chosen.
  const offeredMask = view.offered.reduce((m, n) => m | (1 << (n - 1)), 0);
  if (mask & ~offeredMask) {
    await toast("The list changed. Look at it again.");
    await showList(chatId, listId, listText, member, new Map());
    return new Response("ok");
  }
  const shown = listedLines(listText);
  if (op === "b") {
    await toast();
    await markup(listKeyboard(view.undated));
    return new Response("ok");
  }
  if (op === "c" || op === "x") {
    const entries = view.offered.map((n) => ({ n, label: facts(...String(shown.get(n) ?? "").split(" · ").slice(0, 2)), undated: rows[n - 1].date_guessed === true }));
    await toast();
    await markup(chooseKeyboard(entries, op === "c" ? 0 : mask));
    return new Response("ok");
  }
  if (op === "o") {
    await toast(mask ? `Reply to the list with their numbers and the day, like "${listNumbers(mask).join(", ")} on 2 Oct".` : 'Reply to the list with the day, like "all on 2 Oct".', true);
    return new Response("ok");
  }
  const today = householdToday();
  const numbers = listNumbers(mask);
  const date = op === "t" ? today : op === "y" ? readBatchDate("yesterday", today) as string : null;
  const command: BatchCommand = op === "s" ? { kind: "drop", numbers } : numbers.length ? { kind: "some", numbers, date } : { kind: "all", date };
  if (op === "s" && !numbers.length) {
    await toast();
    return new Response("ok");
  }
  const outcome = await actOnList(member, rows, command, today, listText);
  if (outcome.kind === "refused") {
    await toast(outcome.text, true);
    return new Response("ok");
  }
  await toast(outcome.summary);
  await showList(chatId, listId, listText, member, outcome.marks);
  return new Response("ok");
}
