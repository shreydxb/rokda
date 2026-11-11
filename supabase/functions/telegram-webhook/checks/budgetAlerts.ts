// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { monthActualsByCategory } from "../../_shared/applib/budget.js";
import { householdDay, householdYearMonth } from "../../_shared/applib/day.js";
import { supabase } from "../env.ts";
import { monthStartIso, transactionsBetween } from "../tools.ts";
import { sendToAll } from "../transport.ts";

export const BUDGET_THRESHOLDS = [100, 90, 80];


// Runs alongside runRecurringCheck (see the ?run_recurring_check=1 handler
// in index.ts), household-wide (budgets are set at the household level, not per
// member) for every category with a budget set this month: alerts the
// household once a threshold (80/90/100% used) is newly crossed.
// budget_alert_nudges dedupes per (household, category, month, threshold)
// -- a threshold already alerted isn't repeated, but a later, higher
// threshold crossed the same month still gets its own alert.
export async function runBudgetAlertCheck(): Promise<{ checked: number; nudged: number }> {
  const now = householdDay();
  const { year, month } = householdYearMonth(now);

  const { data: budgetRows, error: budgetError } = await supabase
    .from("budgets")
    .select("household_id, category_id, amount")
    .eq("year", year)
    .eq("month", month)
    .eq("alerts_enabled", true)
    .gt("amount", 0);
  // Not read is not "no budgets": nothing is checked, and tomorrow's run tries again.
  if (budgetError) return { checked: 0, nudged: 0 };

  let nudged = 0;
  for (const b of (budgetRows ?? []) as Array<{ household_id: string; category_id: string; amount: number }>) {
    try {
      const { data: category } = await supabase.from("categories").select("name").eq("id", b.category_id).maybeSingle();
      if (!category) continue;

      // A failed read throws, and this category is not alerted on today
      // rather than alerted on part of its spending.
      const transactions = await transactionsBetween(b.household_id, monthStartIso(year, month), monthStartIso(year, month + 1), b.category_id);
      const actual = monthActualsByCategory(transactions as never, year, month, null, now).get(b.category_id) ?? 0;
      const budgeted = Number(b.amount);
      const pct = (actual / budgeted) * 100;

      // Highest threshold reached, checked in descending order -- the
      // first one not yet sent gets sent, and the loop stops there (a
      // lower threshold that jumped straight past isn't backfilled; the
      // point is "you crossed X%", not a complete history).
      for (const threshold of BUDGET_THRESHOLDS) {
        if (pct < threshold) continue;
        const { data: alreadySent } = await supabase
          .from("budget_alert_nudges")
          .select("threshold")
          .eq("household_id", b.household_id)
          .eq("category_id", b.category_id)
          .eq("year", year)
          .eq("month", month)
          .eq("threshold", threshold)
          .maybeSingle();
        if (alreadySent) break;

        const { data: members } = await supabase.from("household_members").select("id, telegram_user_id").eq("household_id", b.household_id);
        const recipients = (members ?? []).filter((m: { telegram_user_id: number | null }) => m.telegram_user_id != null) as Array<{ telegram_user_id: number }>;

        const message =
          threshold >= 100
            ? `Budget alert: ${category.name} is over budget this month -- AED ${actual.toFixed(2)} spent of AED ${budgeted.toFixed(2)}.`
            : `Budget alert: ${category.name} has hit ${threshold}% of this month's budget (AED ${actual.toFixed(2)} of AED ${budgeted.toFixed(2)}).`;
        if (!(await sendToAll(recipients.map((m) => m.telegram_user_id), message))) break;

        await supabase.from("budget_alert_nudges").insert({ household_id: b.household_id, category_id: b.category_id, year, month, threshold });
        nudged++;
        break;
      }
    } catch {
      // One category's alert failing must never block the rest.
    }
  }
  return { checked: (budgetRows ?? []).length, nudged };
}
