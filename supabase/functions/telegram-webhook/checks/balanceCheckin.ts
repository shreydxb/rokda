// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). The check-in and the balances it asks for
// are written in the one format, with buttons (the revamp, phase 8c).
import { day, money } from "../../_shared/applib/botFormat.js";
import { householdToday } from "../../_shared/applib/day.js";
import { isPrivateChat } from "../../_shared/applib/telegramChat.js";
import { edit, encodeChoice, type Keyboard, RECORD_FAILED } from "../choices.ts";
import { PROPOSAL_COLUMNS, proposalOutcomeMessage, sendProposal } from "../confirmations.ts";
import { supabase } from "../env.ts";
import { pickAccountByHint } from "../intake.ts";
import { reply, sendReminder, tgCall } from "../transport.ts";
import { householdsWithLinkedTelegram, prefEnabled, sendablePeriod, telegramPrefsMap } from "./recipients.ts";

// ---------------------------------------------------------------------------
// Monthly balance check-in
// ---------------------------------------------------------------------------
//
// Balances are entered by hand and never derived from transactions, so they
// go stale unless someone is asked. On the 1st (or by the 3rd) the bot sends each linked
// member the accounts they look after, with what is on record, and asks for
// the closing figures; any reply stating balances goes to
// update_account_balances, which works on any day, not only after a
// check-in.

export type BalanceAccount = {
  id: string;
  name: string;
  type: string;
  currency: string | null;
  balance: number | null;
  balance_as_of: string | null;
  owner_member_id: string | null;
  is_shared: boolean;
};

export type BalanceMember = { id: string; display_name: string; telegram_user_id: number | null };


export const OWED_TYPES = new Set(["credit_card", "loan"]);


// The accounts a member reports on: shared ones, their own, and those of a
// member with no Telegram link (who would otherwise never be asked). An FD's
// balance is computed, never entered, so it is left out.
export function accountsForCheckin<T extends BalanceAccount>(accounts: T[], members: BalanceMember[], memberId: string): T[] {
  const unlinked = new Set(members.filter((m) => m.telegram_user_id == null).map((m) => m.id));
  return accounts.filter(
    (a) => a.type !== "fd" && (a.is_shared || a.owner_member_id == null || a.owner_member_id === memberId || unlinked.has(a.owner_member_id)),
  );
}


// A card or loan is shown as what is owed, or as "in credit" when its stored
// balance is negative. Anything else keeps its sign. Either way a figure the
// model read with the wrong sign cannot pass for the same figure in the
// question that asks to save it.
// In the bot's one format (botFormat.js): "AED 1,000 owed", "−AED 500".
export function balanceFigure(a: BalanceAccount): string {
  const currency = String(a.currency ?? "AED").toUpperCase();
  const value = Number(a.balance ?? 0);
  if (OWED_TYPES.has(a.type)) return `${money(Math.abs(value), currency)}${value < 0 ? " in credit" : " owed"}`;
  return money(value, currency);
}


// The month-end check-in (the revamp, phase 8c; review T13): the list, one
// line of how to reply, and All unchanged under it (checkinKeyboard).
export function buildBalanceCheckinMessage(accounts: BalanceAccount[], members: BalanceMember[], monthLabel: string, today = householdToday()): string {
  const owner = new Map(members.map((m) => [m.id, m.display_name]));
  // The example names a real member of the household, so it shows how to say
  // whose an account is; one with no Telegram is the likeliest to need it.
  const exampleOwner = members.find((m) => m.telegram_user_id == null)?.display_name ?? members[0]?.display_name ?? "Partner";
  const lines = accounts.map((a) => {
    const whose = a.is_shared || !a.owner_member_id ? "" : ` (${owner.get(a.owner_member_id) ?? "?"})`;
    // balance_as_of is a moment (timestamptz), so its day is read in Dubai:
    // a balance the bot set at 01:30 Dubai is stored as 21:30 UTC the day
    // before. A day picked in the account editor is stored as that day's UTC
    // midnight, 04:00 in Dubai, and keeps its date.
    const confirmed = a.balance_as_of ? `confirmed ${day(householdToday(new Date(a.balance_as_of)), today)}` : "never confirmed";
    return `${a.name}${whose} · ${balanceFigure(a)} · ${confirmed}`;
  });
  return [
    `${monthLabel} balances · what did each close at?`,
    ...lines,
    `Reply with what changed, like "Bank 10,500 · ${exampleOwner} bank 5,000 · Card 1,200 owed". I'll show the changes before saving them.`,
  ].join("\n");
}

// All unchanged confirms every balance the check-in listed as it is today.
// It names the member it was sent to, and only they can tap it.
export function checkinKeyboard(memberId: string): Keyboard {
  return { inline_keyboard: [[{ text: "All unchanged", callback_data: encodeChoice("B", memberId) }]] };
}

// The check-in goes to each member as its own message after the morning
// one, with its button (review T23), and is recorded for the household once
// every member got theirs (a member who blocked the bot counts as done). One
// not delivered is tried again the next morning, up to the 3rd.
export async function runBalanceCheckin(today = householdToday()): Promise<{ sent: number }> {
  // From the 1st, catching up until the 3rd while unsent (sendablePeriod).
  const periodKey = sendablePeriod(today, "monthly");
  if (!periodKey) return { sent: 0 };
  const [prevYear, prevMonth] = periodKey.split("-").map(Number);
  const monthLabel = new Date(Date.UTC(prevYear, prevMonth - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  let sent = 0;
  const prefs = await telegramPrefsMap();
  for (const householdId of await householdsWithLinkedTelegram()) {
    if (!prefEnabled(prefs, householdId, "balance_checkin_enabled")) continue;
    try {
      const { data: alreadySent } = await supabase
        .from("brief_sends")
        .select("household_id")
        .eq("household_id", householdId)
        .eq("kind", "balance_checkin")
        .eq("period_key", periodKey)
        .maybeSingle();
      if (alreadySent) continue;

      const [{ data: accounts }, { data: members }] = await Promise.all([
        supabase.from("accounts").select("id, name, type, currency, balance, balance_as_of, owner_member_id, is_shared").eq("household_id", householdId).is("archived_at", null).order("created_at"),
        supabase.from("household_members").select("id, display_name, telegram_user_id").eq("household_id", householdId),
      ]);
      const roster = (members ?? []) as BalanceMember[];
      let asked = 0;
      let retry = false;
      for (const m of roster.filter((r) => r.telegram_user_id != null)) {
        const mine = accountsForCheckin((accounts ?? []) as BalanceAccount[], roster, m.id);
        if (!mine.length) continue;
        asked++;
        const outcome = await sendReminder(m.telegram_user_id!, buildBalanceCheckinMessage(mine, roster, monthLabel, today), checkinKeyboard(m.id)).catch(() => "retry" as const);
        if (outcome === "retry") retry = true;
      }
      if (!asked || retry) continue;
      await supabase.from("brief_sends").insert({ household_id: householdId, kind: "balance_checkin", period_key: periodKey });
      sent++;
    } catch {
      // One household's check-in failing must never block the rest.
    }
  }
  return { sent };
}

// A tap on All unchanged: every balance the check-in lists for this member is
// confirmed as it is today, through a balance proposal applied at once (the
// tap is the answer, and nothing changes but the date each was confirmed). A
// balance changed in the app since is left alone and said so, as for any
// balance proposal. A tap Telegram delivers again finds the proposal it made.
export async function handleCheckinTap(callback: Record<string, unknown>, memberId: string, updateId: unknown): Promise<Response> {
  const from = callback.from as { id?: number } | undefined;
  const message = callback.message as { message_id?: number; chat?: Record<string, unknown> } | undefined;
  const chatId = message?.chat?.id as number | undefined;
  const messageId = message?.message_id;
  const toast = (text = "") => tgCall("answerCallbackQuery", { callback_query_id: callback.id, ...(text ? { text } : {}) }).catch(() => null);
  if (!from?.id || !chatId || !messageId || !isPrivateChat(message?.chat) || chatId !== from.id) {
    await toast();
    return new Response("ok");
  }
  const { data: member } = await supabase.from("household_members").select("id, household_id").eq("telegram_user_id", from.id).maybeSingle();
  if (!member || member.id !== memberId) {
    await toast("That isn't one of yours.");
    return new Response("ok");
  }
  const householdId = member.household_id as string;
  const sourceRef = `unchanged:${String(updateId)}`;
  let { data: row } = await supabase.from("bot_proposals").select(PROPOSAL_COLUMNS).eq("household_id", householdId).eq("source_ref", sourceRef).maybeSingle();
  if (!row) {
    const [{ data: accounts, error: accountsError }, { data: members, error: membersError }] = await Promise.all([
      supabase.from("accounts").select("id, name, type, currency, balance, balance_as_of, owner_member_id, is_shared").eq("household_id", householdId).is("archived_at", null).order("created_at"),
      supabase.from("household_members").select("id, display_name, telegram_user_id").eq("household_id", householdId),
    ]);
    if (accountsError || membersError) {
      await toast(RECORD_FAILED);
      return new Response("ok");
    }
    const mine = accountsForCheckin((accounts ?? []) as BalanceAccount[], (members ?? []) as BalanceMember[], member.id);
    if (!mine.length) {
      await toast("Nothing to confirm.");
      return new Response("ok");
    }
    const items = mine.map((a) => {
      const balance = a.balance == null ? null : Number(a.balance);
      return { account_id: a.id, name: a.name, type: a.type, currency: a.currency, old_balance: balance, new_balance: balance ?? 0 };
    });
    const inserted = await supabase
      .from("bot_proposals")
      .insert({ household_id: householdId, member_id: member.id, kind: "account_balances", payload: { items }, chat_id: chatId, source_ref: sourceRef, prompt_message_id: messageId })
      .select(PROPOSAL_COLUMNS)
      .single();
    if (inserted.error || !inserted.data) {
      await toast(RECORD_FAILED);
      return new Response("ok");
    }
    row = inserted.data;
  }
  const { data, error } = await supabase.rpc("apply_bot_proposal", { p_proposal_id: (row as { id: string }).id, p_member_id: member.id });
  if (error || !data || typeof data !== "object" || (data as { outcome?: string }).outcome !== "applied") {
    await toast(RECORD_FAILED);
    return new Response("ok");
  }
  const result = data as Record<string, unknown>;
  const repeat = result.result != null;
  await toast(repeat ? "Already confirmed." : "Confirmed.");
  await edit(chatId, messageId, `✓ All unchanged, confirmed today\n${proposalOutcomeMessage(repeat ? { outcome: "applied", ...(result.result as Record<string, unknown>) } : result)}`);
  return new Response("ok");
}


// Which account a stated balance is for. Two members can each have an
// account of the same name ("Bank"): a hint that names its owner ("Sam
// bank", "Sam's bank") looks only at that member's accounts; one that names
// no one prefers the sender's own when the name alone matches several.
export function pickCheckinAccount<T extends BalanceAccount>(accounts: T[], members: BalanceMember[], memberId: string, hint: string): T | null {
  const lower = hint.toLowerCase();
  const named = members.find((m) => m.display_name && new RegExp(`\\b${m.display_name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}('s)?\\b`).test(lower));
  if (named) {
    const theirs = accounts.filter((a) => a.owner_member_id === named.id);
    const rest = lower.replace(new RegExp(`\\b${named.display_name.toLowerCase()}('s)?\\b`), " ").trim();
    return pickAccountByHint(theirs, rest || hint) ?? pickAccountByHint(theirs, hint);
  }
  return pickAccountByHint(accounts, hint) ?? pickAccountByHint(accounts.filter((a) => a.owner_member_id === memberId), hint);
}


// Proposes the balances a member stated; nothing is written until they say
// yes (see "Proposals" in confirmations.ts). Each name is resolved among the accounts that
// member reports on, exactly as a card is named in an expense
// (pickAccountByHint), and only when it names exactly one. A card or loan is
// stored as the amount owed. The question shows every change with its old
// figure, so a misread is caught before it is saved.
export async function proposeAccountBalances(
  chatId: number,
  householdId: string,
  memberId: string,
  args: { balances?: Array<{ account?: unknown; balance?: unknown }> },
  updateId: unknown,
): Promise<void> {
  const items = Array.isArray(args?.balances) ? args.balances : [];
  if (!items.length) {
    await reply(chatId, "I couldn't find a balance in that. Try e.g. \"Bank 10,000 · Card 1,000 owed\".");
    return;
  }
  const [{ data: accounts }, { data: members }] = await Promise.all([
    supabase.from("accounts").select("id, name, type, currency, balance, balance_as_of, owner_member_id, is_shared").eq("household_id", householdId).is("archived_at", null),
    supabase.from("household_members").select("id, display_name, telegram_user_id").eq("household_id", householdId),
  ]);
  const roster = (members ?? []) as BalanceMember[];
  const mine = accountsForCheckin((accounts ?? []) as BalanceAccount[], roster, memberId);
  // One change per account: a name given twice keeps its last figure.
  const changes = new Map<string, { account: BalanceAccount; stored: number }>();
  const missed: string[] = [];
  for (const item of items) {
    const name = typeof item.account === "string" ? item.account.trim() : "";
    const value = Number(item.balance);
    if (!name || !Number.isFinite(value)) continue;
    const account = pickCheckinAccount(mine, roster, memberId, name);
    if (!account) {
      missed.push(name);
      continue;
    }
    changes.set(account.id, { account, stored: OWED_TYPES.has(account.type) ? Math.abs(value) : value });
  }

  const missedNote = missed.length
    ? `Not matched: ${missed.map((m) => `"${m}"`).join(", ")}. Name it as the app does.`
    : "";
  if (!changes.size) {
    await reply(chatId, missedNote || "Nothing to update.");
    return;
  }

  // The changes, old → new, under Save and Cancel (proposalWords.ts).
  const lines: string[] = [];
  const payloadItems: Array<Record<string, unknown>> = [];
  for (const { account, stored } of changes.values()) {
    const old = account.balance == null ? null : Number(account.balance);
    lines.push(
      old === stored
        ? `${account.name} · ${balanceFigure(account)} · unchanged, confirms it today`
        : `${account.name} · ${balanceFigure(account)} → ${balanceFigure({ ...account, balance: stored })}`
    );
    payloadItems.push({ account_id: account.id, name: account.name, type: account.type, currency: account.currency, old_balance: old, new_balance: stored });
  }
  const prompt = [`Set ${changes.size === 1 ? "this balance" : "these balances"}?`, ...lines, missedNote].filter(Boolean).join("\n");
  await sendProposal(chatId, householdId, memberId, "account_balances", { items: payloadItems }, prompt, updateId);
}
