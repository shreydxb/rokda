// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { parseDay } from "../../_shared/applib/day.js";
import { supabase } from "../env.ts";

// Every household with at least one member who has ever linked Telegram --
// the target list for the household-wide checks (the briefs, cash cover,
// unusual spend, the balance check-in), where the per-item nudges find who
// to notify item by item.
export async function householdsWithLinkedTelegram(): Promise<string[]> {
  const { data } = await supabase.from("household_members").select("household_id").not("telegram_user_id", "is", null);
  return [...new Set((data ?? []).map((m: { household_id: string }) => m.household_id))];
}


export async function telegramRecipients(householdId: string): Promise<number[]> {
  const { data } = await supabase.from("household_members").select("telegram_user_id").eq("household_id", householdId).not("telegram_user_id", "is", null);
  return (data ?? []).map((m: { telegram_user_id: number }) => m.telegram_user_id);
}


export type TelegramPrefRow = {
  household_id: string;
  recurring_enabled: boolean;
  credit_card_enabled: boolean;
  cash_cover_enabled: boolean;
  brief_enabled: boolean;
  unusual_spend_enabled: boolean;
  balance_checkin_enabled: boolean;
  statement_enabled: boolean;
  dividends_enabled: boolean;
};

export type TelegramPrefKey = "recurring_enabled" | "credit_card_enabled" | "cash_cover_enabled" | "brief_enabled" | "unusual_spend_enabled" | "balance_checkin_enabled" | "statement_enabled" | "dividends_enabled";


// Fetched once per check run (the table has one row per household, so this
// is cheap) rather than once per item/household inside a loop.
export async function telegramPrefsMap(): Promise<Map<string, TelegramPrefRow>> {
  const { data } = await supabase.from("telegram_notification_prefs").select("*");
  const map = new Map<string, TelegramPrefRow>();
  for (const row of (data ?? []) as TelegramPrefRow[]) map.set(row.household_id, row);
  return map;
}


// No row for a household means every signal is on -- see this table's own
// migration comment for why (additive: nothing changes for a household that
// never visits the new Telegram settings tab).
export function prefEnabled(prefs: Map<string, TelegramPrefRow>, householdId: string, key: TelegramPrefKey): boolean {
  return prefs.get(householdId)?.[key] ?? true;
}


// The Monday of the week a given calendar day falls in, as the same
// 'YYYY-MM-DD' shape used everywhere else in the bot -- the dedupe key for
// the weekly brief and the cash-cover nudge, so either firing twice in the
// same week (a cron retry, a slow first run) is a no-op the second time.
export function mondayOfWeek(dateStr: string): string {
  const d = parseDay(dateStr);
  const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}


// The period a weekly or monthly message is for, on a day it may still go
// out: the brief from its Monday, the review and the balance check-in from
// the 1st, and on the two days after while it is unsent (brief_sends keeps
// it to once a period). The job runs once a day, so a message tried only on
// its own day and refused for now then was never sent (the fresh review of
// round 2). Null on any other day.
export const CATCH_UP_DAYS = 3;

export function sendablePeriod(today: string, kind: "weekly" | "monthly"): string | null {
  const day = parseDay(today);
  if (kind === "weekly") {
    const weekday = day.getDay(); // 0 = Sunday .. 6 = Saturday
    return weekday >= 1 && weekday <= CATCH_UP_DAYS ? mondayOfWeek(today) : null;
  }
  if (day.getDate() > CATCH_UP_DAYS) return null;
  const [year, month] = today.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}
