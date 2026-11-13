// Choosing a missing category or card with a tap (docs/decisions.md, "A
// missing category or card is chosen in Telegram"). An entry read in full
// but for its category or card used to wait in the Inbox for one tap there;
// the bot now asks with buttons under its reply. A tap saves the choice and
// turns the message into the usual "reply yes" prompt: it never records the
// expense itself.
//
// A button carries the entry's id and the choice's id, written compactly to
// fit Telegram's 64 bytes. Nothing in it is trusted: every tap is checked
// against the database (the member's own entry, still pending, a category
// or account of their household).
import { merchantMatches } from "../_shared/applib/merchants.js";
import { isPrivateChat } from "../_shared/applib/telegramChat.js";
import { isReadyForFastConfirm } from "../_shared/applib/telegramConfirm.js";
import { supabase } from "./env.ts";
import { type FileableCategory, findDuplicateTransaction, inboxReason, isSpendingAccount, loadCategoryKnowledge, loadFileableCategories } from "./intake.ts";
import { tgCall } from "./transport.ts";

export type ChoiceKind = "c" | "a" | "i";
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

// "c<entry><category>", "a<entry><account>" or "i<entry>" (leave it in the
// Inbox): 45 bytes at most.
export function encodeChoice(kind: ChoiceKind, intakeId: string, optionId: string | null = null): string {
  return `${kind}${uuidToB64(intakeId)}${optionId ? uuidToB64(optionId) : ""}`;
}

export function decodeChoice(data: string): { kind: ChoiceKind; intakeId: string; optionId: string | null } | null {
  const kind = data[0];
  if (kind !== "c" && kind !== "a" && kind !== "i") return null;
  const intakeId = b64ToUuid(data.slice(1, 23));
  if (!intakeId) return null;
  if (kind === "i") return data.length === 23 ? { kind, intakeId, optionId: null } : null;
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

type Button = { text: string; callback_data: string };

function keyboard(buttons: Button[]): { inline_keyboard: Button[][] } {
  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
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

type PromptRow = ChoiceRow & { id: string; parsed_kind?: string | null };

async function accountName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.from("accounts").select("name").eq("id", id).maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

// The question and its buttons for an entry, or null when nothing is missing.
export async function choicePrompt(householdId: string, memberId: string, row: PromptRow): Promise<{ text: string; reply_markup: { inline_keyboard: Button[][] } } | null> {
  const ask = missingChoice(row);
  if (!ask) return null;
  const card = await accountName(row.parsed_account_id);
  const what = `AED ${Number(row.parsed_amount).toFixed(2)} at ${row.parsed_merchant}${card ? ` (${card})` : ""}`;
  const inbox = { text: INBOX_LABEL, callback_data: encodeChoice("i", row.id) };
  if (ask === "category") {
    const options = await categoryChoices(householdId, row.parsed_merchant, row.parsed_kind ?? "expense");
    return { text: `${what}. Which category?`, reply_markup: keyboard([...options.map((c) => ({ text: short(c.label), callback_data: encodeChoice("c", row.id, c.id) })), inbox]) };
  }
  const options = await accountChoices(householdId, memberId);
  return { text: `${what}. Which card or account was it paid from?`, reply_markup: keyboard([...options.map((a) => ({ text: short(a.name), callback_data: encodeChoice("a", row.id, a.id) })), inbox]) };
}

// Sends the question for an entry, when it is missing only its category or
// card. False when there was nothing to ask, so the caller replies as before.
export async function sendChoicePrompt(chatId: number, householdId: string, memberId: string, row: PromptRow, lead = ""): Promise<boolean> {
  const prompt = await choicePrompt(householdId, memberId, row).catch(() => null);
  if (!prompt) return false;
  const res = (await tgCall("sendMessage", { chat_id: chatId, text: `${lead}${prompt.text}`, reply_markup: prompt.reply_markup })) as { ok?: boolean } | undefined;
  return !!res?.ok;
}

const INTAKE_COLUMNS = "id, household_id, member_id, status, parsed_merchant, parsed_amount, parsed_date, date_guessed, parsed_category_id, parsed_account_id, parsed_currency, parsed_kind, confidence";

async function edit(chatId: number, messageId: number, text: string, replyMarkup: unknown = null): Promise<void> {
  await tgCall("editMessageText", { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }).catch(() => null);
}

// What the message says once nothing is missing: the yes prompt, bound to
// this message so a reply or 👍 to it records this entry; or why it waits.
async function settledText(householdId: string, chatId: number, messageId: number, row: PromptRow): Promise<string> {
  if (!isReadyForFastConfirm(row)) {
    return row.date_guessed
      ? "Saved. It had no date in the SMS, so it waits in the Inbox for the day it was paid."
      : inboxReason(row);
  }
  const duplicate = await findDuplicateTransaction(householdId, row.parsed_account_id, row.parsed_merchant, row.parsed_amount, row.parsed_date ?? null).catch(() => undefined);
  if (duplicate === undefined) return "Saved. It's in the Inbox to check and approve.";
  if (duplicate) return inboxReason(row, duplicate);
  const [card, category] = await Promise.all([
    accountName(row.parsed_account_id),
    supabase.from("categories").select("name").eq("id", row.parsed_category_id!).maybeSingle().then((r) => (r.data as { name?: string } | null)?.name ?? null),
  ]);
  const kindLabel = row.parsed_kind === "income" ? "income " : row.parsed_kind === "refund" ? "refund " : "";
  const { error } = await supabase.from("intake").update({ confirm_chat_id: chatId, confirm_message_id: messageId }).eq("id", row.id).eq("status", "pending");
  if (error) return "Saved. It's in the Inbox to check and approve.";
  return `Got it — AED ${Number(row.parsed_amount).toFixed(2)} ${kindLabel}at ${row.parsed_merchant} (${card ?? "account"}${category ? `, ${category}` : ""}) on ${row.parsed_date}. Everything matched, so reply "yes" to record it, or edit in the Inbox.`;
}

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
  const row = found as (PromptRow & { status: string }) | null;
  if (!member || !row) {
    await answer("That isn't one of your entries.");
    return new Response("ok");
  }
  if (row.status !== "pending") {
    await answer();
    await edit(chatId, messageId, "That one is already settled in the app.");
    return new Response("ok");
  }
  if (choice.kind === "i") {
    await answer();
    await edit(chatId, messageId, "Left in the Inbox to finish there.");
    return new Response("ok");
  }

  let patch: Record<string, string> | null = null;
  if (choice.kind === "c") {
    const fileable = await loadFileableCategories(member.household_id, row.parsed_kind === "income" ? "income" : "expense");
    if (fileable.some((c) => c.id === choice.optionId)) patch = { parsed_category_id: choice.optionId! };
  } else {
    const { data: acct } = await supabase.from("accounts").select("id, type").eq("id", choice.optionId!).eq("household_id", member.household_id).is("archived_at", null).maybeSingle();
    if (acct && isSpendingAccount(acct as { type: string })) patch = { parsed_account_id: choice.optionId! };
  }
  if (!patch) {
    await answer("That choice isn't available any more.");
    return new Response("ok");
  }
  const { data: updated, error } = await supabase.from("intake").update(patch).eq("id", row.id).eq("status", "pending").select(INTAKE_COLUMNS);
  if (error || !updated?.length) {
    await answer("Couldn't save that just now. Try again, or use the Inbox.");
    return new Response("ok");
  }
  await answer("Saved.");
  const next = updated[0] as PromptRow;
  const prompt = await choicePrompt(member.household_id, member.id, next).catch(() => null);
  if (prompt) await edit(chatId, messageId, prompt.text, prompt.reply_markup);
  else await edit(chatId, messageId, await settledText(member.household_id, chatId, messageId, next));
  return new Response("ok");
}
