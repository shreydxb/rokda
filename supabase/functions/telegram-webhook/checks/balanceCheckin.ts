// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). The check-in and the balances it asks for
// are written in the one format, with buttons (the revamp, phase 8c).
import { day, money } from "../../_shared/applib/botFormat.js";
import { householdToday } from "../../_shared/applib/day.js";
import { encodeChoice } from "../choices.ts";
import { discardUnaskedProposal, sendProposal } from "../confirmations.ts";
import { supabase } from "../env.ts";
import { pickAccountByHint } from "../intake.ts";
import { reply, tgCall } from "../transport.ts";
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


// An account as the check-in names it: "Bank (Sam)" for one person's, so two
// accounts called Bank can be told apart; a shared one by its name alone.
// All unchanged's outcome names them the same way.
export function checkinLabel(a: BalanceAccount, members: BalanceMember[]): string {
  if (a.is_shared || !a.owner_member_id) return a.name;
  return `${a.name} (${members.find((m) => m.id === a.owner_member_id)?.display_name ?? "?"})`;
}

// The month-end check-in (the revamp, phase 8c; review T13): the list, one
// line of how to reply, and All unchanged under it (runBalanceCheckin).
export function buildBalanceCheckinMessage(accounts: BalanceAccount[], members: BalanceMember[], monthLabel: string, today = householdToday()): string {
  // The example names a real member of the household, so it shows how to say
  // whose an account is; one with no Telegram is the likeliest to need it.
  const exampleOwner = members.find((m) => m.telegram_user_id == null)?.display_name ?? members[0]?.display_name ?? "Partner";
  const lines = accounts.map((a) => {
    // balance_as_of is a moment (timestamptz), so its day is read in Dubai:
    // a balance the bot set at 01:30 Dubai is stored as 21:30 UTC the day
    // before. A day picked in the account editor is stored as that day's UTC
    // midnight, 04:00 in Dubai, and keeps its date.
    const confirmed = a.balance_as_of ? `confirmed ${day(householdToday(new Date(a.balance_as_of)), today)}` : "never confirmed";
    return `${checkinLabel(a, members)} · ${balanceFigure(a)} · ${confirmed}`;
  });
  return [
    `${monthLabel} balances · what did each close at?`,
    ...lines,
    `Reply with what changed, like "Bank 10,500 · ${exampleOwner} bank 5,000 · Card 1,200 owed". I'll show the changes before saving them.`,
  ].join("\n");
}

// The check-in goes to each member as its own message after the morning
// one (review T23), and is recorded for the household once every member got
// theirs (a member who blocked the bot counts as done). One not delivered is
// tried again the next morning, up to the 3rd, and a member already sent
// theirs this month is not sent it again.
//
// All unchanged is the Save of a balance proposal made as the check-in is
// sent, holding each balance as the check-in shows it (the fresh review of
// 8c's second part): a tap confirms those figures, a balance changed in the
// app since is left alone and said so (apply_bot_proposal), and a tap
// Telegram delivers again, or a second one, finds it applied. A balance never
// set is left out: confirming the 0 it shows would make "unknown" read as
// nothing owed (QA-02). Only a reply to the check-in, never a bare "yes",
// answers it (openProposals).
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
        const outcome = await sendCheckin(householdId, m, mine, roster, buildBalanceCheckinMessage(mine, roster, monthLabel, today), periodKey);
        if (outcome === "retry") retry = true;
      }
      if (!asked || retry) continue;
      const { error } = await supabase.from("brief_sends").insert({ household_id: householdId, kind: "balance_checkin", period_key: periodKey });
      if (!error) sent++;
    } catch {
      // One household's check-in failing must never block the rest.
    }
  }
  return { sent };
}

// One member's check-in and the proposal behind its All unchanged. "sent"
// once it is out (or was this month already), "final" when Telegram refuses
// it for good, "retry" otherwise; a proposal whose message never went out is
// removed, so no tap can reach it.
async function sendCheckin(householdId: string, m: BalanceMember, mine: BalanceAccount[], roster: BalanceMember[], text: string, periodKey: string): Promise<"sent" | "final" | "retry"> {
  const chatId = Number(m.telegram_user_id);
  const sourceRef = `checkin:${periodKey}:${m.id}`;
  const { data: before } = await supabase.from("bot_proposals").select("id, prompt_message_id").eq("household_id", householdId).eq("source_ref", sourceRef).maybeSingle();
  if ((before as { prompt_message_id?: number | null } | null)?.prompt_message_id != null) return "sent";
  if (before) await supabase.from("bot_proposals").delete().eq("id", (before as { id: string }).id).is("prompt_message_id", null);

  const items = mine.filter((a) => a.balance_as_of != null).map((a) => {
    const balance = Number(a.balance ?? 0);
    return { account_id: a.id, name: a.name, label: checkinLabel(a, roster), type: a.type, currency: a.currency, old_balance: balance, new_balance: balance };
  });
  const neverSet = mine.filter((a) => a.balance_as_of == null).map((a) => checkinLabel(a, roster));
  let proposalId: string | null = null;
  if (items.length) {
    const { data, error } = await supabase
      .from("bot_proposals")
      .insert({
        household_id: householdId, member_id: m.id, kind: "account_balances", payload: { items, checkin: periodKey, never_set: neverSet },
        chat_id: chatId, source_ref: sourceRef, expires_at: new Date(Date.now() + CHECKIN_ANSWERABLE_MS).toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) return "retry";
    proposalId = String((data as { id: string }).id);
  }
  const keyboard = proposalId ? { inline_keyboard: [[{ text: "All unchanged", callback_data: encodeChoice("P", proposalId) }]] } : null;
  const res = (await tgCall("sendMessage", { chat_id: chatId, text, ...(keyboard ? { reply_markup: keyboard } : {}) }).catch(() => null)) as { ok?: boolean; error_code?: number; result?: { message_id?: number } } | null;
  const messageId = res?.ok ? res.result?.message_id ?? null : null;
  if (messageId == null) {
    if (proposalId) await discardUnaskedProposal(proposalId);
    return res && (res.error_code === 400 || res.error_code === 403) ? "final" : "retry";
  }
  if (proposalId) {
    let bound = await supabase.from("bot_proposals").update({ prompt_message_id: messageId }).eq("id", proposalId);
    if (bound.error) bound = await supabase.from("bot_proposals").update({ prompt_message_id: messageId }).eq("id", proposalId);
  }
  return "sent";
}

// All unchanged can be tapped for a week after the check-in.
const CHECKIN_ANSWERABLE_MS = 7 * 24 * 60 * 60 * 1000;


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
