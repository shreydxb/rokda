// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { accountValueAed } from "../../_shared/applib/accounts.js";
import { daysUntilDue, nextDueDate } from "../../_shared/applib/creditCard.js";
import { atDayOfMonth, householdDay, startOfDay } from "../../_shared/applib/day.js";
import { supabase } from "../env.ts";
import { sendToAll } from "../transport.ts";
import { prefEnabled, telegramPrefsMap } from "./recipients.ts";

// Runs alongside runRecurringCheck (see the ?run_recurring_check=1 handler
// below) across every credit-card account with a due day set: a reminder
// 1-2 days before (or on) the due date, and, if the balance still shows
// owing a few days after, an "did you pay this?" nudge. There is no "marked
// as paid" concept anywhere in this app -- a card's balance is simply
// updated (manually, or by import) when it changes -- so "overdue" here is
// the same proxy get_upcoming_bills already uses: balance still positive
// past the due date. credit_card_nudges dedupes per (account, due date,
// kind) so the same due date is never re-nagged on the next day's check.
export async function runCreditCardCheck(): Promise<{ checked: number; nudged: number }> {
  const today = householdDay();
  const [{ data: cards }, prefs] = await Promise.all([
    supabase
      .from("accounts")
      .select("id, household_id, name, owner_member_id, is_shared, balance, balance_aed, due_day")
      .eq("type", "credit_card")
      .is("archived_at", null)
      .not("due_day", "is", null),
    telegramPrefsMap(),
  ]);

  let nudged = 0;
  for (const a of (cards ?? []) as Array<{
    id: string;
    household_id: string;
    name: string;
    owner_member_id: string | null;
    is_shared: boolean;
    balance: number;
    balance_aed: number | null;
    currency: string;
    due_day: number;
  }>) {
    if (!prefEnabled(prefs, a.household_id, "credit_card_enabled")) continue;
    // A reminder that names an amount has to name a real one. With no AED
    // conversion there is no AED amount, and `balance_aed ?? balance` sent
    // the native number out as dirhams (QA #4). Skipping the card entirely
    // would trade a wrong number for a missed bill, so the nudge goes out
    // with the amount described in its own currency instead.
    const aed = accountValueAed(a);
    const bal = aed ?? Number(a.balance ?? 0);
    if (bal <= 0) continue; // nothing owed, nothing to nag about
    const owedLabel = aed === null ? `${a.currency} ${bal.toFixed(2)} (not converted to AED)` : `AED ${bal.toFixed(2)}`;

    try {
      // Two different due dates are in play, not one: the upcoming
      // occurrence (>= today, via nextDueDate -- the same helper
      // get_upcoming_bills already uses) for the "due soon" window, and the
      // most recently passed occurrence (one cadence back from that) for
      // the "still not paid" window. Reusing a single variable for both, by
      // substituting last month's date whenever this month's hasn't
      // happened yet, meant a genuinely upcoming due date got silently
      // replaced by an already-passed one -- so daysSinceDue could never
      // land in the pre-due window at all, and "1-2 days before" never
      // fired.
      const upcoming = nextDueDate(a.due_day, today)!;
      const daysUntil = daysUntilDue(a.due_day, today)!;
      const lastPassed = atDayOfMonth(upcoming.getFullYear(), upcoming.getMonth() - 1, a.due_day);
      const daysSincePassed = Math.round((startOfDay(today).getTime() - lastPassed.getTime()) / 86400000);

      let kind: "due_soon" | "overdue" | null = null;
      let dueDate: Date;
      if (daysUntil <= 2) {
        kind = "due_soon";
        dueDate = upcoming;
      } else if (daysSincePassed >= 3 && daysSincePassed <= 10) {
        kind = "overdue";
        dueDate = lastPassed;
      } else {
        continue;
      }

      const dueDateStr = dueDate.toISOString().slice(0, 10);
      const { data: alreadySent } = await supabase
        .from("credit_card_nudges")
        .select("account_id")
        .eq("account_id", a.id)
        .eq("due_date", dueDateStr)
        .eq("kind", kind)
        .maybeSingle();
      if (alreadySent) continue;

      const { data: members } = await supabase.from("household_members").select("id, telegram_user_id").eq("household_id", a.household_id);
      const recipients = (
        a.is_shared ? (members ?? []) : (members ?? []).filter((m: { id: string }) => m.id === a.owner_member_id)
      ).filter((m: { telegram_user_id: number | null }) => m.telegram_user_id != null) as Array<{ telegram_user_id: number }>;

      const message =
        kind === "due_soon"
          ? `${a.name} is due ${dueDateStr} -- outstanding balance ${owedLabel}.`
          : `${a.name} was due ${dueDateStr} and still shows ${owedLabel} owing -- paid it another way, or forgot?`;
      if (!(await sendToAll(recipients.map((m) => m.telegram_user_id), message))) continue;

      await supabase.from("credit_card_nudges").insert({ account_id: a.id, due_date: dueDateStr, kind });
      nudged++;
    } catch {
      // One card's nudge failing must never block the rest.
    }
  }
  return { checked: (cards ?? []).length, nudged };
}
