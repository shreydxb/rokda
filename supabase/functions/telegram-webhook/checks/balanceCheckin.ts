// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdToday } from "../../_shared/applib/day.js";
import { sendProposal } from "../confirmations.ts";
import { supabase } from "../env.ts";
import { pickAccountByHint } from "../intake.ts";
import { ANSWER_HINT } from "../trades.ts";
import { reply, sendReminder } from "../transport.ts";
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
export function balanceFigure(a: BalanceAccount): string {
  const currency = String(a.currency ?? "AED").toUpperCase();
  const value = Number(a.balance ?? 0);
  const amount = Math.abs(value).toLocaleString(currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (OWED_TYPES.has(a.type)) return `${currency} ${amount}${value < 0 ? " in credit" : " owed"}`;
  return `${currency} ${value < 0 ? "-" : ""}${amount}`;
}


export function buildBalanceCheckinMessage(accounts: BalanceAccount[], members: BalanceMember[], monthLabel: string): string {
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
    const confirmed = a.balance_as_of ? `confirmed ${householdToday(new Date(a.balance_as_of))}` : "never confirmed";
    return `• ${a.name}${whose}: ${balanceFigure(a)}, ${confirmed}`;
  });
  return (
    `Month-end check-in for ${monthLabel}. What did each of these close at?\n\n${lines.join("\n")}\n\n` +
    `Reply in one message, e.g. "Bank 10,000 · ${exampleOwner} bank 5,000 · Card 1,000 owed · Pension 3,00,000" -- cards and loans as the amount owed (a card in credit is set in the app), ` +
    `other currencies in their own, and whose it is when two share a name. Anything you leave out stays as it is. I'll show you the changes before saving them.`
  );
}


export async function runBalanceCheckin(): Promise<{ sent: number }> {
  // From the 1st, catching up until the 3rd while unsent (sendablePeriod).
  const periodKey = sendablePeriod(householdToday(), "monthly");
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
      let any = false;
      let undelivered = false;
      for (const m of roster.filter((r) => r.telegram_user_id != null)) {
        const mine = accountsForCheckin((accounts ?? []) as BalanceAccount[], roster, m.id);
        if (!mine.length) continue;
        if ((await sendReminder(m.telegram_user_id!, buildBalanceCheckinMessage(mine, roster, monthLabel))) === "retry") undelivered = true;
        any = true;
      }
      if (!any || undelivered) continue;
      await supabase.from("brief_sends").insert({ household_id: householdId, kind: "balance_checkin", period_key: periodKey });
      sent++;
    } catch {
      // One household's check-in failing must never block the rest.
    }
  }
  return { sent };
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
    ? `Not matched -- no single account matches ${missed.map((m) => `"${m}"`).join(", ")}. Name it as it appears in the app.`
    : "";
  if (!changes.size) {
    await reply(chatId, missedNote || "Nothing to update.");
    return;
  }

  const lines: string[] = [];
  const payloadItems: Array<Record<string, unknown>> = [];
  for (const { account, stored } of changes.values()) {
    const old = account.balance == null ? null : Number(account.balance);
    lines.push(
      old === stored
        ? `• ${account.name}: ${balanceFigure(account)}, unchanged (confirms it today)`
        : `• ${account.name}: ${balanceFigure(account)} → ${balanceFigure({ ...account, balance: stored })}`
    );
    payloadItems.push({ account_id: account.id, name: account.name, type: account.type, currency: account.currency, old_balance: old, new_balance: stored });
  }
  const prompt = [`Set ${changes.size === 1 ? "this balance" : "these balances"}? Nothing changes until you say yes.\n${lines.join("\n")}`, missedNote, ANSWER_HINT]
    .filter(Boolean)
    .join("\n\n");
  await sendProposal(chatId, householdId, memberId, "account_balances", { items: payloadItems }, prompt, updateId);
}
