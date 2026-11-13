// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdToday } from "../../_shared/applib/day.js";
import { supabase } from "../env.ts";
import { buildBriefMessage, buildMonthlyReviewMessage } from "../tools.ts";
import { type Digest, DIGEST_ORDER } from "./digest.ts";
import { householdsWithLinkedTelegram, prefEnabled, sendablePeriod, telegramPrefsMap, telegramRecipients } from "./recipients.ts";

// Runs daily alongside the other checks (see the ?run_recurring_check=1
// handler in index.ts) but only sends from Monday, catching up until Wednesday
// (sendablePeriod) -- the brief itself is weekly, the check for whether to
// send it doesn't need its own schedule. brief_sends dedupes per (household,
// 'weekly', that Monday's date) so a later run the same week is a no-op.
// It heads that morning's digest (digest.ts): the reminder lines follow it.
export async function runWeeklyBriefCheck(digest: Digest): Promise<{ sent: number }> {
  const today = householdToday();
  const periodKey = sendablePeriod(today, "weekly");
  if (!periodKey) return { sent: 0 };

  let sent = 0;
  const prefs = await telegramPrefsMap();
  for (const householdId of await householdsWithLinkedTelegram()) {
    if (!prefEnabled(prefs, householdId, "brief_enabled")) continue;
    try {
      const { data: alreadySent } = await supabase
        .from("brief_sends")
        .select("household_id")
        .eq("household_id", householdId)
        .eq("kind", "weekly")
        .eq("period_key", periodKey)
        .maybeSingle();
      if (alreadySent) continue;

      const recipients = await telegramRecipients(householdId);
      if (!recipients.length) continue;

      const brief = await buildBriefMessage(householdId);
      digest.head(recipients, `This week:\n${brief}`, DIGEST_ORDER.weeklyBrief, () =>
        supabase.from("brief_sends").insert({ household_id: householdId, kind: "weekly", period_key: periodKey })
      );
      sent++;
    } catch {
      // One household's brief failing must never block the rest.
    }
  }
  return { sent };
}


// Same pattern as the weekly check, but fires from the 1st of the month
// (catching up until the 3rd) and summarises the month that just ended (see
// buildMonthlyReviewMessage) -- by the time this runs, "this month" already
// names the new one.
// It heads that morning's digest, with the balance check-in after it.
export async function runMonthlyBriefCheck(digest: Digest): Promise<{ sent: number }> {
  const periodKey = sendablePeriod(householdToday(), "monthly");
  if (!periodKey) return { sent: 0 };
  const [prevYear, prevMonth] = periodKey.split("-").map(Number);

  let sent = 0;
  const prefs = await telegramPrefsMap();
  for (const householdId of await householdsWithLinkedTelegram()) {
    if (!prefEnabled(prefs, householdId, "brief_enabled")) continue;
    try {
      const { data: alreadySent } = await supabase
        .from("brief_sends")
        .select("household_id")
        .eq("household_id", householdId)
        .eq("kind", "monthly")
        .eq("period_key", periodKey)
        .maybeSingle();
      if (alreadySent) continue;

      const recipients = await telegramRecipients(householdId);
      if (!recipients.length) continue;

      const review = await buildMonthlyReviewMessage(householdId, prevYear, prevMonth);
      digest.head(recipients, review, DIGEST_ORDER.monthlyReview, () =>
        supabase.from("brief_sends").insert({ household_id: householdId, kind: "monthly", period_key: periodKey })
      );
      sent++;
    } catch {
      // One household's review failing must never block the rest.
    }
  }
  return { sent };
}
