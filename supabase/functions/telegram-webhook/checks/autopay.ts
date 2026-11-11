// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { autopayCycle, autopayQuestion } from "../../_shared/applib/autopay.js";
import { householdDay, householdToday, parseDay } from "../../_shared/applib/day.js";
import { discardUnaskedProposal } from "../confirmations.ts";
import { supabase } from "../env.ts";
import { reply } from "../transport.ts";
import { prefEnabled, telegramPrefsMap } from "./recipients.ts";
import { paymentRecorded } from "./recurring.ts";

// Autopay bills (docs/decisions.md, "Autopay bills are confirmed, not
// entered"). Runs with the daily check at 09:00 Dubai. An outgoing bill on
// autopay, from an account, is asked about on its due date and each morning
// after until someone answers "paid" or it shows up in Rokda some other way,
// up to its next due date. One question per member per cycle (source_ref),
// re-sent each morning; every message that asked it can be answered.
export async function runAutopayCheck(): Promise<{ checked: number; asked: number }> {
  const now = new Date();
  const today = householdDay(now);
  const todayStr = householdToday(now);
  const [{ data: rows }, prefs] = await Promise.all([
    supabase
      .from("recurring")
      .select("id, household_id, name, owner_member_id, is_shared, amount, next_due_date, ends_on, cadence, interval_count, account_id, category_id, accounts(name)")
      .eq("active", true)
      .eq("autopay", true)
      .lt("amount", 0)
      .not("account_id", "is", null),
    telegramPrefsMap(),
  ]);

  let checked = 0;
  let asked = 0;
  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    const householdId = String(r.household_id);
    if (!prefEnabled(prefs, householdId, "recurring_enabled")) continue;
    const cycle = autopayCycle(r as { next_due_date: string; cadence: string; interval_count: number | null; ends_on: string | null }, today);
    if (!cycle) continue;
    checked++;
    try {
      const amount = Math.abs(Number(r.amount));
      // Already in Rokda: confirmed, or logged another way (a pasted bank
      // SMS, the app). The same match apply_bot_proposal() uses.
      const day = (offset: number) => {
        const d = parseDay(cycle.due);
        d.setDate(d.getDate() + offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      };
      const recorded = await paymentRecorded({
        householdId,
        accountId: String(r.account_id),
        categoryId: r.category_id ? String(r.category_id) : null,
        from: day(-5),
        to: day(5),
        amount,
      });
      if (recorded !== false) continue;

      const { data: members } = await supabase
        .from("household_members")
        .select("id, telegram_user_id")
        .eq("household_id", householdId);
      const recipients = ((members ?? []) as Array<{ id: string; telegram_user_id: number | null }>)
        .filter((m) => m.telegram_user_id != null && (r.is_shared || m.id === r.owner_member_id));
      const accountName = (r.accounts as { name?: string } | null)?.name ?? null;
      for (const m of recipients) {
        if (await askAutopay({
          id: String(r.id), householdId, name: String(r.name), amount, accountName,
          accountId: String(r.account_id), categoryId: r.category_id ? String(r.category_id) : null,
        }, m, cycle, todayStr)) asked++;
      }
    } catch {
      // One bill failing must never block the rest.
    }
  }
  return { checked, asked };
}


// Asks one member about one bill's cycle, once a day. True when a message
// went out.
export async function askAutopay(
  bill: { id: string; householdId: string; name: string; amount: number; accountName: string | null; accountId: string; categoryId: string | null },
  member: { id: string; telegram_user_id: number | null },
  cycle: { due: string; next: string },
  todayStr: string,
): Promise<boolean> {
  const chatId = Number(member.telegram_user_id);
  const sourceRef = `autopay:${bill.id}:${cycle.due}:${member.id}`;
  const { data: existing, error } = await supabase
    .from("bot_proposals")
    .select("id, status, payload, prompt_message_id")
    .eq("household_id", bill.householdId)
    .eq("source_ref", sourceRef)
    .maybeSingle();
  if (error) return false;

  type AutopayRow = { id: string; status: string; payload: Record<string, unknown>; prompt_message_id: number | null };
  let row = existing as AutopayRow | null;
  if (row && (row.status !== "proposed" || row.payload?.last_asked_on === todayStr)) return false;
  if (!row) {
    // Expires when the next cycle starts: until then an answer still counts.
    const inserted = await supabase
      .from("bot_proposals")
      .insert({
        household_id: bill.householdId,
        member_id: member.id,
        kind: "autopay_payment",
        // The account and category the question names go with it: a "yes"
        // after the bill moved to another account records nothing
        // (apply_bot_proposal; the outside review, D-05).
        payload: {
          recurring_id: bill.id, name: bill.name, amount: bill.amount, account_name: bill.accountName,
          account_id: bill.accountId, category_id: bill.categoryId, due_date: cycle.due, next_due: cycle.next, asked_message_ids: [],
        },
        chat_id: chatId,
        source_ref: sourceRef,
        expires_at: `${cycle.next}T00:00:00+04:00`,
      })
      .select("id, status, payload, prompt_message_id")
      .single();
    // 23505: another run of this check got there first.
    if (inserted.error || !inserted.data) return false;
    row = inserted.data as AutopayRow;
  }

  const reminder = row.prompt_message_id != null;
  let messageId: number | null = null;
  try {
    messageId = await reply(chatId, autopayQuestion({ name: bill.name, amount: Number(row.payload?.amount ?? bill.amount), accountName: bill.accountName, due: cycle.due }, { reminder, today: todayStr }));
  } catch {
    messageId = null;
  }
  if (messageId == null) {
    // Never asked: remove it, so tomorrow asks afresh. One already asked
    // stays, and is asked again tomorrow.
    if (!reminder) await discardUnaskedProposal(row.id);
    return false;
  }
  // The reminder names the bill's account as it is today, so the question
  // its answer is checked against is that one. When the bill moved account
  // or category since the last question, the earlier messages, which named
  // the old one, stop answering it: only this message does.
  const moved = row.payload?.account_id != null &&
    (row.payload.account_id !== bill.accountId || (row.payload.category_id ?? null) !== bill.categoryId);
  const askedIds = [...(moved ? [] : ((row.payload?.asked_message_ids as number[] | undefined) ?? [])), messageId];
  const payload = {
    ...row.payload, account_id: bill.accountId, category_id: bill.categoryId, account_name: bill.accountName,
    asked_message_ids: askedIds, last_asked_on: todayStr,
  };
  await supabase
    .from("bot_proposals")
    .update({ prompt_message_id: messageId, payload })
    .eq("id", row.id)
    .eq("status", "proposed");
  return true;
}
