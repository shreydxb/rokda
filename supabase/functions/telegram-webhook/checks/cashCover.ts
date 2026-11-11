// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { formatCashCoverLine } from "../../_shared/applib/cashCover.js";
import { householdToday } from "../../_shared/applib/day.js";
import { supabase } from "../env.ts";
import { toolGetCashCover } from "../tools.ts";
import { sendToAll } from "../transport.ts";
import { householdsWithLinkedTelegram, mondayOfWeek, prefEnabled, telegramPrefsMap, telegramRecipients } from "./recipients.ts";

// Runs daily (unlike the weekly/monthly briefs above) since a shortfall is
// urgent, not a status update -- but only actually nudges once per week
// while it persists. cash_cover_nudges dedupes per (household, that week's
// Monday) so a household that's short all week hears about it once, not
// every morning; if the shortfall clears and later reopens the same week,
// it still stays quiet until the following Monday -- same tradeoff the
// budget-threshold nudge makes for a threshold that stays crossed.
export async function runCashCoverCheck(): Promise<{ checked: number; nudged: number }> {
  const today = householdToday();
  const periodKey = mondayOfWeek(today);

  let nudged = 0;
  const households = await householdsWithLinkedTelegram();
  const prefs = await telegramPrefsMap();
  for (const householdId of households) {
    if (!prefEnabled(prefs, householdId, "cash_cover_enabled")) continue;
    try {
      const status = await toolGetCashCover(householdId);
      // A "covered" built on a due total that is missing an unknown amount
      // must not silence the warning -- that is the one direction where being
      // wrong stops someone acting (QA #4).
      if (status.covered && status.certain) continue;

      const { data: alreadySent } = await supabase
        .from("cash_cover_nudges")
        .select("household_id")
        .eq("household_id", householdId)
        .eq("period_key", periodKey)
        .maybeSingle();
      if (alreadySent) continue;

      const recipients = await telegramRecipients(householdId);
      if (!recipients.length) continue;

      const message = `${formatCashCoverLine(status)} Might be worth checking before those bills land.`;
      if (!(await sendToAll(recipients, message))) continue;
      await supabase.from("cash_cover_nudges").insert({ household_id: householdId, period_key: periodKey });
      nudged++;
    } catch {
      // One household's cash-cover check failing must never block the rest.
    }
  }
  return { checked: households.length, nudged };
}
