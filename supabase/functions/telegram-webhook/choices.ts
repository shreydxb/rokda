// An expense's buttons (the revamp, phase 8b; docs/decisions.md, "A tap on
// Record records, with Undo for ten minutes", and "A missing category or card
// is chosen in Telegram"). An entry read in full is shown in two lines with
// Record, Category, Account and Discard. Record records it; the message then
// becomes one line with Undo, which for ten minutes puts it back where it was.
// Category and Account change it before it is recorded, Discard sets it
// aside. An entry read in full but for its category or card is asked about
// with the likely ones, and one that needs more waits in the Inbox, saying
// why.
//
// A button carries the entry's id and the choice's id, written compactly to
// fit Telegram's 64 bytes. Nothing in it is trusted: every tap is checked
// against the database (the member's own entry, still pending, a category
// or account of their household), and Record only records the entry this
// message shows, as it shows it.
import { merchantMatches } from "../_shared/applib/merchants.js";
import { isPrivateChat } from "../_shared/applib/telegramChat.js";
import { isConfirmable, isReadyForFastConfirm } from "../_shared/applib/telegramConfirm.js";
import { APP_URL, supabase } from "./env.ts";
import { askText, cancelledText, type ExpenseView, inboxReason, inboxText, readyText, recordedText, undoneText } from "./expenseMessages.ts";
import { type FileableCategory, findDuplicateTransaction, type IntakeKind, isSpendingAccount, loadCategoryKnowledge, loadFileableCategories } from "./intake.ts";
import { logFailure, recordAnswerTarget, recordedAnswerTarget, reply, tgCall } from "./transport.ts";

// c and a fill a missing category or card, k and m change one; i leaves the
// entry in the Inbox; r records, d discards; u undoes the transaction it
// names, the one the bot's own Record made; C and A open the category and
// account lists, b goes back to the entry. P, X, N and O name a proposal, not
// an entry: they apply it (an autopay bill's Paid), cancel it, say an autopay
// bill has not gone out yet, or ask for the amount that did (a month-end
// check-in's All unchanged is its balance proposal's P). S names a card
// statement, checked (proposalWords.ts, checks/statements.ts, taps.ts).
export type ChoiceKind = "c" | "a" | "k" | "m" | "i" | "r" | "d" | "u" | "C" | "A" | "b" | "P" | "X" | "N" | "O" | "S";
const WITH_OPTION = new Set(["c", "a", "k", "m", "u"]);
const WITHOUT_OPTION = new Set(["i", "r", "d", "C", "A", "b", "P", "X", "N", "O", "S"]);
export const INBOX_LABEL = "In the Inbox";
const CATEGORY_CHOICES = 6;
const ACCOUNT_CHOICES = 8;

function uuidToB64(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64ToUuid(b64: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(b64)) return null;
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "==");
  const hex = [...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// "c<entry><category>", "r<entry>" and so on: 45 bytes at most.
export function encodeChoice(kind: ChoiceKind, intakeId: string, optionId: string | null = null): string {
  return `${kind}${uuidToB64(intakeId)}${optionId ? uuidToB64(optionId) : ""}`;
}

export function decodeChoice(data: string): { kind: ChoiceKind; intakeId: string; optionId: string | null } | null {
  const kind = data[0] as ChoiceKind;
  if (!WITH_OPTION.has(kind) && !WITHOUT_OPTION.has(kind)) return null;
  const intakeId = b64ToUuid(data.slice(1, 23));
  if (!intakeId) return null;
  if (WITHOUT_OPTION.has(kind)) return data.length === 23 ? { kind, intakeId, optionId: null } : null;
  const optionId = b64ToUuid(data.slice(23));
  return optionId ? { kind, intakeId, optionId } : null;
}

type ChoiceRow = {
  parsed_merchant: string | null;
  parsed_amount: number | string | null;
  parsed_date?: string | null;
  date_guessed?: boolean | null;
  parsed_category_id: string | null;
  parsed_account_id: string | null;
  parsed_currency: string | null;
  confidence: number | string | null;
};

// What to ask about, or null: only an entry read in full apart from its
// category and card (its date may still be missing: the Inbox asks for that).
export function missingChoice(row: ChoiceRow): "category" | "account" | null {
  const filled = { ...row, parsed_category_id: row.parsed_category_id ?? "x", parsed_account_id: row.parsed_account_id ?? "x", date_guessed: false, parsed_date: row.parsed_date ?? "x" };
  if (!isReadyForFastConfirm(filled)) return null;
  if (!row.parsed_category_id) return "category";
  if (!row.parsed_account_id) return "account";
  return null;
}

type Button = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = { inline_keyboard: Button[][] };

function keyboard(buttons: Button[]): Keyboard {
  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

const tap = (text: string, kind: ChoiceKind, id: string, option: string | null = null): Button => ({ text, callback_data: encodeChoice(kind, id, option) });

export function readyKeyboard(id: string): Keyboard {
  return keyboard([tap("Record", "r", id), tap("Category", "C", id), tap("Account", "A", id), tap("Discard", "d", id)]);
}

// Undo names the transaction the bot recorded, so it can never take back an
// approval made in the app (undo_intake_approval).
export function undoKeyboard(id: string, transactionId: string): Keyboard {
  return keyboard([tap("Undo", "u", id, transactionId)]);
}

// "Open Inbox", when the app's address is set (env.ts).
export function inboxKeyboard(): Keyboard | null {
  return APP_URL ? keyboard([{ text: "Open Inbox", url: `${APP_URL}/inbox` }]) : null;
}

function short(label: string): string {
  return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}

// The categories this merchant was filed under, most used first, then the
// household's most used, then the rest; subcategories only.
async function categoryChoices(householdId: string, merchant: string | null, kind: string): Promise<FileableCategory[]> {
  const [fileable, knowledge] = await Promise.all([loadFileableCategories(householdId, kind === "income" ? "income" : "expense"), loadCategoryKnowledge(householdId)]);
  const score = new Map<string, number>();
  for (const h of knowledge.history as Array<{ merchant: string; category_id: string; uses: number }>) {
    const weight = merchant && merchantMatches(merchant, h.merchant) ? 1_000_000 : 1;
    score.set(h.category_id, (score.get(h.category_id) ?? 0) + weight * Number(h.uses || 0));
  }
  return [...fileable].sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || a.label.localeCompare(b.label)).slice(0, CATEGORY_CHOICES);
}

async function accountChoices(householdId: string, memberId: string): Promise<Array<{ id: string; name: string }>> {
  const { data } = await supabase.from("accounts").select("id, name, type, owner_member_id").eq("household_id", householdId).is("archived_at", null);
  return ((data ?? []) as Array<{ id: string; name: string; type: string; owner_member_id: string | null }>)
    .filter((a) => isSpendingAccount(a))
    .sort((a, b) => Number(b.owner_member_id === memberId) - Number(a.owner_member_id === memberId) || a.name.localeCompare(b.name))
    .slice(0, ACCOUNT_CHOICES);
}

export type EntryRow = ChoiceRow & {
  id: string;
  status?: string;
  transaction_id?: string | null;
  parsed_kind?: string | null;
  confirm_chat_id?: number | string | null;
  confirm_message_id?: number | string | null;
};

async function nameOf(table: "accounts" | "categories", id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.from(table).select("name").eq("id", id).maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

// An entry as its message shows it: names, not ids.
export async function viewOf(row: EntryRow): Promise<ExpenseView> {
  const [account, category] = await Promise.all([nameOf("accounts", row.parsed_account_id), nameOf("categories", row.parsed_category_id)]);
  return { merchant: row.parsed_merchant, amount: row.parsed_amount, currency: row.parsed_currency, date: row.parsed_date ?? null, kind: row.parsed_kind ?? "expense", account, category };
}

// A recorded entry as its record has it: approved in the app, it may carry
// another amount, category or card than the bot read.
export async function recordedView(row: EntryRow): Promise<ExpenseView> {
  const { data } = row.transaction_id
    ? await supabase.from("transactions").select("merchant, amount, currency, occurred_at, kind, account_id, category_id").eq("id", row.transaction_id).maybeSingle()
    : { data: null };
  const t = data as { merchant: string | null; amount: number | string; currency: string | null; occurred_at: string; kind: string; account_id: string; category_id: string | null } | null;
  if (!t) return await viewOf(row);
  const [account, category] = await Promise.all([nameOf("accounts", t.account_id), nameOf("categories", t.category_id)]);
  return { merchant: t.merchant, amount: Math.abs(Number(t.amount)), currency: t.currency, date: t.occurred_at, kind: t.kind, account, category };
}

// The same without reading names, for a reply sent when the database or
// Telegram is failing.
export function plainView(row: EntryRow): ExpenseView {
  return { merchant: row.parsed_merchant, amount: row.parsed_amount, currency: row.parsed_currency, date: row.parsed_date ?? null, kind: row.parsed_kind ?? "expense" };
}

type Shown = { text: string; reply_markup: Keyboard | null; ready: boolean; view: ExpenseView };

// What a message about a pending entry shows now: Record and the rest when
// it can be recorded as it is, the question when only its category or card
// is missing, or where it waits and why. notes are lines added at the end.
async function renderPending(householdId: string, memberId: string, row: EntryRow, notes: string[] = []): Promise<Shown> {
  const view = await viewOf(row);
  const tail = notes.length ? `\n${notes.join("\n")}` : "";
  const ask = missingChoice(row);
  if (ask) {
    const options = ask === "category"
      ? (await categoryChoices(householdId, row.parsed_merchant, row.parsed_kind ?? "expense")).map((c) => tap(short(c.label), "c", row.id, c.id))
      : (await accountChoices(householdId, memberId)).map((a) => tap(short(a.name), "a", row.id, a.id));
    const undated = row.date_guessed ? "\nIt had no date: set the day it was paid in the Inbox." : "";
    return { text: `${askText(view, ask)}${undated}${tail}`, reply_markup: keyboard([...options, tap(INBOX_LABEL, "i", row.id)]), ready: false, view };
  }
  if (isReadyForFastConfirm(row)) {
    // A check that could not run is not a clean check: it waits in the Inbox.
    const duplicate = await findDuplicateTransaction(householdId, row.parsed_account_id, row.parsed_merchant, row.parsed_amount, row.parsed_date ?? null).catch(() => undefined);
    if (duplicate === null) return { text: `${readyText(view)}${tail}`, reply_markup: readyKeyboard(row.id), ready: true, view };
    return { text: `${inboxText(view, duplicate ? inboxReason(row, duplicate) : { reason: "to check and approve", note: null })}${tail}`, reply_markup: inboxKeyboard(), ready: false, view };
  }
  return { text: `${inboxText(view, inboxReason(row))}${tail}`, reply_markup: inboxKeyboard(), ready: false, view };
}

// Ties an entry to the message that shows it, so that message's Record, a
// "yes" sent as a reply to it, or a 👍 on it records this entry. Only while
// pending.
async function bind(id: string, chatId: number, messageId: number): Promise<boolean> {
  const { error } = await supabase.from("intake").update({ confirm_chat_id: chatId, confirm_message_id: messageId }).eq("id", id).eq("status", "pending");
  return !error;
}

// Unties it from this message, when the message no longer offers Record.
async function unbind(id: string, chatId: number, messageId: number): Promise<void> {
  await supabase.from("intake").update({ confirm_chat_id: null, confirm_message_id: null }).eq("id", id).eq("confirm_chat_id", chatId).eq("confirm_message_id", messageId);
}

// Sends the message about one pending entry, with its buttons. False when it
// could not be sent: the caller then replies in plain words, and nothing
// throws, since a failed update would have Telegram deliver the whole message
// again.
export async function sendEntryPrompt(chatId: number, householdId: string, memberId: string, row: EntryRow, notes: string[] = []): Promise<boolean> {
  try {
    const shown = await renderPending(householdId, memberId, row, notes);
    const res = (await tgCall("sendMessage", { chat_id: chatId, text: shown.text, ...(shown.reply_markup ? { reply_markup: shown.reply_markup } : {}) })) as { ok?: boolean; result?: { message_id?: number } } | undefined;
    const messageId = res?.ok ? res.result?.message_id : null;
    if (!messageId) return false;
    // Recorded second: a failure to record costs the binding, not the
    // message, and a Record tapped on it then shows the entry again first.
    if (shown.ready) await bind(row.id, chatId, messageId);
    return true;
  } catch {
    return false;
  }
}

// The question for an entry of a pasted list missing only its category or
// card; false when there is nothing to ask.
export async function sendChoicePrompt(chatId: number, householdId: string, memberId: string, row: EntryRow): Promise<boolean> {
  if (!missingChoice(row)) return false;
  return await sendEntryPrompt(chatId, householdId, memberId, row);
}

const INTAKE_COLUMNS = "id, household_id, member_id, status, transaction_id, parsed_merchant, parsed_amount, parsed_date, date_guessed, parsed_category_id, parsed_account_id, parsed_currency, parsed_kind, confidence, confirm_chat_id, confirm_message_id";

// Whether the message now shows this: Telegram's "message is not modified"
// means it already did.
export async function edit(chatId: number, messageId: number, text: string, replyMarkup: Keyboard | null = null): Promise<boolean> {
  const res = (await tgCall("editMessageText", { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }).catch(() => null)) as { ok?: boolean; description?: string } | null;
  return res?.ok === true || /message is not modified/i.test(String(res?.description ?? ""));
}

// Turns this message into what the pending entry shows now, tied to it when
// it offers Record and untied when it no longer does.
// The tie follows what the message is seen to show: made only once the edit
// worked, and undone when it did not, so Record can never record figures the
// message failed to show (the fresh review of 8b). A tie that fails to save
// leaves Record showing the entry again on its next tap.
async function showPending(chatId: number, messageId: number, householdId: string, memberId: string, row: EntryRow): Promise<void> {
  const shown = await renderPending(householdId, memberId, row);
  const edited = await edit(chatId, messageId, shown.text, shown.reply_markup);
  if (shown.ready && edited) await bind(row.id, chatId, messageId);
  else await unbind(row.id, chatId, messageId);
}

export type RecordOutcome =
  | { kind: "recorded"; transactionId: string }
  | { kind: "already" }
  | { kind: "failed" }
  | { kind: "unchecked" }
  | { kind: "duplicate"; duplicate: { id: string; amount: number; occurred_at: string } };

// Records a pending entry read in full, as its message shows it: the one
// place a tap, a "yes" or a 👍 records an expense from the bot. A last look
// for the same expense recorded in the meantime (in the app, say) comes
// first: one found is never recorded twice. memberId is the member who sent
// the entry, whose /undo may take it back.
export async function recordEntry(householdId: string, memberId: string, row: EntryRow): Promise<RecordOutcome> {
  let duplicate;
  try {
    duplicate = await findDuplicateTransaction(householdId, row.parsed_account_id, row.parsed_merchant, row.parsed_amount, row.parsed_date ?? null);
  } catch {
    return { kind: "unchecked" };
  }
  if (duplicate) return { kind: "duplicate", duplicate };
  // An entry the parser never classified is an expense, as it always was.
  const kind = (row.parsed_kind as IntakeKind | null) ?? "expense";
  const { data, error } = await supabase.rpc("approve_intake", {
    p_intake_id: row.id,
    p_account_id: row.parsed_account_id,
    p_amount: row.parsed_amount,
    p_occurred_at: row.parsed_date,
    p_kind: kind,
    p_category_id: row.parsed_category_id,
    p_currency: "AED",
    p_merchant: row.parsed_merchant,
  });
  if (error || !data) return { kind: "failed" };
  // Only a transaction this call made is the bot's to undo: one approved
  // already (in the app, or by a tap a moment earlier) is not offered Undo.
  const result = data as { already_approved?: boolean; transaction_id?: string | null };
  if (result.already_approved || !result.transaction_id) return { kind: "already" };
  await noteRecording(householdId, memberId, row.id, result.transaction_id);
  return { kind: "recorded", transactionId: result.transaction_id };
}

// Undo lasts ten minutes, as undo_intake_approval checks.
const UNDO_WINDOW_MS = 10 * 60_000;

// Notes what this Record made, for /undo (undoLatest, below): only a row
// written here is the bot's to take back. A row that fails to save costs
// /undo, never the Record or its Undo button, and is logged. The daily job
// clears rows older than a day (pruneTelegramUpdateLog), which /undo never
// reaches.
async function noteRecording(householdId: string, memberId: string, intakeId: string, transactionId: string): Promise<void> {
  const { error } = await supabase
    .from("bot_recordings")
    .upsert({ household_id: householdId, intake_id: intakeId, member_id: memberId, transaction_id: transactionId, recorded_at: new Date().toISOString() }, { onConflict: "household_id,intake_id" });
  if (error) logFailure("noteRecording", null, error);
}

export const RECORD_FAILED = "Couldn't record that. Nothing saved — try again in a minute.";
export const RECORD_UNCHECKED = "Couldn't check it isn't recorded already. Nothing saved — try again in a minute.";

// A tap on one of the buttons. Always answered, so Telegram stops the
// button's spinner; anything that does not check out changes nothing.
export async function handleChoiceTap(callback: Record<string, unknown>): Promise<Response> {
  const from = callback.from as { id?: number } | undefined;
  const message = callback.message as { message_id?: number; chat?: Record<string, unknown> } | undefined;
  const chatId = message?.chat?.id as number | undefined;
  const messageId = message?.message_id;
  const answer = (text = "") => tgCall("answerCallbackQuery", { callback_query_id: callback.id, ...(text ? { text } : {}) }).catch(() => null);
  const choice = decodeChoice(String(callback.data ?? ""));
  if (!from?.id || !chatId || !messageId || !choice || !isPrivateChat(message?.chat) || chatId !== from.id) {
    await answer();
    return new Response("ok");
  }
  const { data: member } = await supabase.from("household_members").select("id, household_id").eq("telegram_user_id", from.id).maybeSingle();
  const { data: found } = member
    ? await supabase.from("intake").select(INTAKE_COLUMNS).eq("id", choice.intakeId).eq("household_id", member.household_id).eq("member_id", member.id).maybeSingle()
    : { data: null };
  const row = found as (EntryRow & { status: string }) | null;
  if (!member || !row) {
    await answer("That isn't one of your entries.");
    return new Response("ok");
  }
  const householdId = member.household_id as string;
  // Whether this message is the one the entry is tied to: only that one
  // shows it as it is.
  const bound = Number(row.confirm_chat_id) === chatId && Number(row.confirm_message_id) === messageId;

  if (choice.kind === "u") {
    await undoTap(answer, chatId, messageId, householdId, member.id, row, bound, choice.optionId!);
    return new Response("ok");
  }

  // Settled already: shown as its record has it, with no Undo, since what
  // the bot did not record here is not the bot's to take back.
  if (row.status !== "pending") {
    await answer(row.status === "approved" ? "Already recorded." : "Already cancelled.");
    await edit(chatId, messageId, row.status === "approved" ? recordedText(await recordedView(row)) : cancelledText(await viewOf(row)));
    return new Response("ok");
  }

  if (choice.kind === "r") {
    // Only the message the entry is tied to, showing it as it is, records
    // it. Another (an older question, or one whose tie was never saved) is
    // shown the entry as it is now first, and records on the next tap.
    if (!bound || !isConfirmable(row)) {
      await answer("It changed since. Check it, then tap Record.");
      await showPending(chatId, messageId, householdId, member.id, row);
      return new Response("ok");
    }
    const outcome = await recordEntry(householdId, member.id, row);
    if (outcome.kind === "failed" || outcome.kind === "unchecked") {
      await answer(outcome.kind === "failed" ? RECORD_FAILED : RECORD_UNCHECKED);
      return new Response("ok");
    }
    const view = await viewOf(row);
    if (outcome.kind === "duplicate") {
      await answer("It looks recorded already, so it's in the Inbox.");
      await unbind(row.id, chatId, messageId);
      await edit(chatId, messageId, inboxText(view, inboxReason(row, outcome.duplicate)), inboxKeyboard());
      return new Response("ok");
    }
    if (outcome.kind === "recorded") {
      await answer("Recorded.");
      await edit(chatId, messageId, recordedText(view), undoKeyboard(row.id, outcome.transactionId));
    } else {
      await answer("Already recorded.");
      await edit(chatId, messageId, recordedText(await recordedView({ ...row, transaction_id: null, ...(await freshTransactionId(row.id)) })));
    }
    return new Response("ok");
  }

  if (choice.kind === "d") {
    const { data: discarded, error } = await supabase.from("intake").update({ status: "rejected" }).eq("id", row.id).eq("member_id", member.id).eq("status", "pending").select("id");
    if (error) {
      await answer("Couldn't discard that. Try again in a minute.");
      return new Response("ok");
    }
    const view = await viewOf(row);
    if (!discarded?.length) {
      await answer("It was settled in the app.");
      return new Response("ok");
    }
    await answer("Cancelled.");
    await edit(chatId, messageId, cancelledText(view));
    return new Response("ok");
  }

  if (choice.kind === "C" || choice.kind === "A") {
    const options = choice.kind === "C"
      ? (await categoryChoices(householdId, row.parsed_merchant, row.parsed_kind ?? "expense")).map((c) => tap(short(c.label), "k", row.id, c.id))
      : (await accountChoices(householdId, member.id)).map((a) => tap(short(a.name), "m", row.id, a.id));
    await answer();
    await tgCall("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: keyboard([...options, tap("Back", "b", row.id)]) }).catch(() => null);
    return new Response("ok");
  }

  if (choice.kind === "b") {
    await answer();
    await showPending(chatId, messageId, householdId, member.id, row);
    return new Response("ok");
  }

  if (choice.kind === "i") {
    await answer();
    // A choice made before may have tied this message to Record: it no
    // longer offers that, so a "yes" to it must record nothing.
    await unbind(row.id, chatId, messageId);
    await edit(chatId, messageId, inboxText(await viewOf(row), inboxReason(row)), inboxKeyboard());
    return new Response("ok");
  }

  // A category or card: c and a fill one still empty, so a choice made in
  // the app since the question was asked is not overwritten by an old
  // button; k and m change one, from the lists Category and Account open.
  const isCategory = choice.kind === "c" || choice.kind === "k";
  const field = isCategory ? "parsed_category_id" : "parsed_account_id";
  let patch: Record<string, string> | null = null;
  if (isCategory) {
    const fileable = await loadFileableCategories(householdId, row.parsed_kind === "income" ? "income" : "expense");
    if (fileable.some((c) => c.id === choice.optionId)) patch = { parsed_category_id: choice.optionId! };
  } else {
    const { data: acct } = await supabase.from("accounts").select("id, type").eq("id", choice.optionId!).eq("household_id", householdId).is("archived_at", null).maybeSingle();
    if (acct && isSpendingAccount(acct as { type: string })) patch = { parsed_account_id: choice.optionId! };
  }
  if (!patch) {
    await answer("That choice isn't available any more.");
    return new Response("ok");
  }
  let update = supabase.from("intake").update(patch).eq("id", row.id).eq("status", "pending");
  if (choice.kind === "c" || choice.kind === "a") update = update.is(field, null);
  const { data: updated, error } = await update.select(INTAKE_COLUMNS);
  if (error) {
    await answer("Couldn't save that just now. Try again, or use the Inbox.");
    return new Response("ok");
  }
  if (!updated?.length) {
    await answer("That was already set in the app.");
    return new Response("ok");
  }
  await answer("Saved.");
  await showPending(chatId, messageId, householdId, member.id, updated[0] as EntryRow);
  return new Response("ok");
}

// Undo: the database puts the entry back only for its sender, within ten
// minutes, and while nobody has changed it (undo_intake_approval). Undone,
// the message shows the entry with its buttons again.
async function undoTap(
  answer: (text?: string) => Promise<unknown>,
  chatId: number,
  messageId: number,
  householdId: string,
  memberId: string,
  row: EntryRow & { status: string },
  bound: boolean,
  transactionId: string,
): Promise<void> {
  if (!bound) {
    await answer("Use the latest message about it, or the app.");
    return;
  }
  const { data, error } = await supabase.rpc("undo_intake_approval", { p_intake_id: row.id, p_member_id: memberId, p_transaction_id: transactionId });
  const outcome = !error && data && typeof data === "object" ? String((data as { outcome?: unknown }).outcome ?? "") : "";
  if (outcome === "undone" || outcome === "not_recorded") {
    const { data: fresh } = await supabase.from("intake").select(INTAKE_COLUMNS).eq("id", row.id).maybeSingle();
    const now = (fresh as (EntryRow & { status: string }) | null) ?? row;
    await answer(outcome === "undone" ? "Undone." : "");
    if (now.status === "pending") await showPending(chatId, messageId, householdId, memberId, now);
    else if (now.status === "rejected") await edit(chatId, messageId, cancelledText(await viewOf(now)));
    return;
  }
  if (outcome === "too_late" || outcome === "changed") {
    await answer(outcome === "too_late" ? UNDO_TOO_LATE : UNDO_CHANGED);
    await edit(chatId, messageId, recordedText(await recordedView(row)));
    return;
  }
  if (outcome === "not_yours" || outcome === "not_found") {
    await answer("That isn't one of your entries.");
    return;
  }
  await answer(UNDO_FAILED);
}

const UNDO_TOO_LATE = "Undo lasts ten minutes. Change it in the app.";
const UNDO_CHANGED = "It was changed in the app, so it stays. Change it there.";
const UNDO_FAILED = "Couldn't undo that just now. Try again in a minute.";
export const NOTHING_TO_UNDO = "No expense recorded in the last ten minutes to undo.";
const NOTHING_THERE = "That message has no expense to undo.";

type Noted = { intake_id: string; transaction_id: string };

// The note of what the bot's Record made of this member's entry, if any.
async function notedFor(member: { id: string; household_id: string }, intakeId: string): Promise<Noted | null> {
  const { data, error } = await supabase.from("bot_recordings").select("intake_id, transaction_id").eq("household_id", member.household_id).eq("member_id", member.id).eq("intake_id", intakeId).maybeSingle();
  if (error) throw new Error(`reading a Record's note failed (${error.code ?? "no code"})`);
  return data as Noted | null;
}

// /undo (commands.ts): the member's latest Record from the last ten minutes,
// or, sent as a reply, the Record that message shows, taken back through the
// same database check as the Undo button. Only what the bot's own Record
// noted is looked for (noteRecording), so an approval made in the app, or the
// other member's Record, is never taken back. Undone, the line that said it
// was recorded says Undone and loses its button, and the entry is sent again
// under the /undo with its buttons, as a typed "yes" gets its answer as a new
// message. Left recorded, the line loses its Undo and the reply says why. A
// latest Record changed in the app stays the latest: /undo says so for its
// ten minutes rather than reaching past it to an older one.
//
// The entry chosen is kept with the update before anything is undone, so a
// delivery Telegram sends again (the first died part way) is about the same
// entry, never the Record before it.
export async function undoLatest(chatId: number, member: { id: string; household_id: string }, updateId: unknown, repliedTo: number | null): Promise<void> {
  const before = await recordedAnswerTarget(updateId);
  let noted: Noted | null = null;
  if (before?.kind === "intake") {
    noted = await notedFor(member, before.id);
    if (!noted) {
      // Undone by the first delivery, whose note went with the transaction:
      // only the entry's message may still be owed.
      const { data: fresh } = await supabase.from("intake").select(INTAKE_COLUMNS).eq("id", before.id).eq("household_id", member.household_id).eq("member_id", member.id).maybeSingle();
      const now = fresh as (EntryRow & { status: string }) | null;
      if (now?.status === "pending") await sendEntryPrompt(chatId, member.household_id, member.id, now, ["Undone."]);
      return;
    }
  } else if (repliedTo != null) {
    // The entry that message shows, when it is the member's.
    const { data: shown } = await supabase.from("intake").select("id").eq("household_id", member.household_id).eq("member_id", member.id).eq("confirm_chat_id", chatId).eq("confirm_message_id", repliedTo).maybeSingle();
    noted = shown ? await notedFor(member, (shown as { id: string }).id) : null;
    if (!noted) {
      await reply(chatId, NOTHING_THERE);
      return;
    }
  } else {
    const { data: latest, error } = await supabase
      .from("bot_recordings")
      .select("intake_id, transaction_id")
      .eq("household_id", member.household_id)
      .eq("member_id", member.id)
      .gte("recorded_at", new Date(Date.now() - UNDO_WINDOW_MS).toISOString())
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      await reply(chatId, UNDO_FAILED);
      return;
    }
    noted = latest as Noted | null;
  }
  const { data: found } = noted
    ? await supabase.from("intake").select(INTAKE_COLUMNS).eq("id", noted.intake_id).eq("household_id", member.household_id).eq("member_id", member.id).maybeSingle()
    : { data: null };
  const row = found as (EntryRow & { status: string }) | null;
  if (!noted || !row) {
    await reply(chatId, NOTHING_TO_UNDO);
    return;
  }
  await recordAnswerTarget(updateId, { kind: "intake", id: row.id });
  // The message that says it was recorded, when it is in this chat.
  const shownIn = Number(row.confirm_chat_id) === chatId && row.confirm_message_id != null ? Number(row.confirm_message_id) : null;
  const { data, error: undoError } = await supabase.rpc("undo_intake_approval", { p_intake_id: row.id, p_member_id: member.id, p_transaction_id: noted.transaction_id });
  const outcome = !undoError && data && typeof data === "object" ? String((data as { outcome?: unknown }).outcome ?? "") : "";
  if (outcome === "undone") {
    if (shownIn) {
      // Untied first: that line no longer offers Record, so a "yes" to it
      // must record nothing.
      await unbind(row.id, chatId, shownIn);
      await edit(chatId, shownIn, undoneText(await viewOf(row)));
    }
    const { data: fresh } = await supabase.from("intake").select(INTAKE_COLUMNS).eq("id", row.id).maybeSingle();
    const now = fresh as (EntryRow & { status: string }) | null;
    const sent = now?.status === "pending" && (await sendEntryPrompt(chatId, member.household_id, member.id, now, ["Undone."]));
    // Never silent: undone, it waits in the Inbox either way.
    if (!sent) await reply(chatId, "Undone. It's in the Inbox.").catch(() => null);
    return;
  }
  if (outcome === "too_late" || outcome === "changed") {
    await reply(chatId, outcome === "too_late" ? UNDO_TOO_LATE : UNDO_CHANGED);
    if (shownIn) await edit(chatId, shownIn, recordedText(await recordedView(row)));
    return;
  }
  await reply(chatId, outcome ? NOTHING_TO_UNDO : UNDO_FAILED);
}

// The transaction an entry was recorded as, read afresh: one approved a
// moment ago by someone else is not in the row read before.
async function freshTransactionId(id: string): Promise<{ transaction_id?: string | null }> {
  const { data } = await supabase.from("intake").select("transaction_id").eq("id", id).maybeSingle();
  return (data as { transaction_id?: string | null } | null) ?? {};
}
