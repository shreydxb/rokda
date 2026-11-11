// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdDay } from "../../_shared/applib/day.js";
import { lastDueOccurrence, matchWindowDays } from "../../_shared/applib/recurring.js";
import { supabase } from "../env.ts";
import { sendToAll } from "../transport.ts";
import { prefEnabled, telegramPrefsMap } from "./recipients.ts";

// Runs once a day via pg_cron (see the ?run_recurring_check=1 handler below)
// across ALL households: an active recurring item whose due date passed a
// few days ago with nothing resembling it in `transactions` gets a one-time
// nudge to the member(s) it belongs to. recurring_nudges records that a
// nudge was already sent for a (recurring row, due date) pair so the same
// missed bill is never re-nagged on the next day's check.
export async function runRecurringCheck(): Promise<{ checked: number; nudged: number }> {
  const today = householdDay();
  // A bill is nudged 3 to 10 days after its date. Income moves with bank
  // holidays, so it is only nudged once its whole window (matchWindowDays)
  // has passed, and looked for a week after that.
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const nudgeWindow = (r: { amount: number }) => {
    const wait = Number(r.amount) > 0 ? matchWindowDays(r) : 3;
    return { from: daysAgo(wait + 7), to: daysAgo(wait) };
  };

  const [{ data: activeRows }, prefs] = await Promise.all([
    supabase
      .from("recurring")
      .select("id, household_id, name, owner_member_id, is_shared, amount, next_due_date, ends_on, cadence, interval_count, account_id, category_id, autopay")
      .eq("active", true),
    telegramPrefsMap(),
  ]);

  // next_due_date is a "last known" anchor, not a live field -- nothing
  // advances it automatically, and the household is expected to hand-edit it
  // only when they get around to it (see the recurring table's own migration
  // comment). Filtering on it directly, as this used to, meant a bill's due
  // date scrolling more than graceStart days into the past made this check
  // stop seeing it forever, silently, even though the bill keeps recurring
  // every cadence after that. lastDueOccurrence rolls the stored anchor
  // forward to whichever cycle is ACTUALLY due right now -- the same way
  // upcomingItems/billStatus already do everywhere else this app shows a due
  // date -- so a stale anchor no longer matters.
  const dueRows = (
    (activeRows ?? []) as Array<{
      id: string;
      household_id: string;
      name: string;
      owner_member_id: string | null;
      is_shared: boolean;
      amount: number;
      next_due_date: string;
      ends_on: string | null;
      cadence: string;
      interval_count: number;
      account_id: string | null;
      category_id: string | null;
      autopay: boolean;
    }>
  )
    // An outgoing bill on autopay is asked about on its due date and every
    // morning after instead (runAutopayCheck), not nudged once here.
    .filter((r) => !(r.autopay && Number(r.amount) < 0 && r.account_id))
    .map((r) => {
      const due = lastDueOccurrence(r.next_due_date, r.cadence, today, r.interval_count);
      return due ? { ...r, dueDate: due.toISOString().slice(0, 10) } : null;
    })
    // Nothing is due after a schedule's last date (the final EMI or premium).
    .filter((r): r is NonNullable<typeof r> => r !== null && r.dueDate >= nudgeWindow(r).from && r.dueDate <= nudgeWindow(r).to && (!r.ends_on || r.dueDate <= r.ends_on));

  let nudged = 0;
  for (const r of dueRows) {
    if (!prefEnabled(prefs, r.household_id, "recurring_enabled")) continue;
    try {
      const { data: alreadySent } = await supabase
        .from("recurring_nudges")
        .select("recurring_id")
        .eq("recurring_id", r.id)
        .eq("due_date", r.dueDate)
        .maybeSingle();
      if (alreadySent) continue;

      // What counts as "this bill was paid".
      //
      // Amount and timing alone are not a fair bar, whatever the previous
      // comment here claimed (QA pass 3, §15). A 20% tolerance on a 6,500
      // rent matches anything from 5,200 to 7,800, and the window is eleven
      // days wide, so a single card purchase in that range silently stood in
      // for the rent -- and the nudge that should have said "I don't see the
      // rent" never went out. A false match is the expensive direction here:
      // it suppresses the one message whose entire job is to catch a payment
      // nobody logged.
      //
      // So the structured fields the recurring row already carries have to
      // agree too. They are ids, not fuzzy text: an exact comparison with no
      // new ways to be wrong. Merchant text stays out for the reason given
      // before -- a bank SMS and a hand-typed entry rarely agree.
      //
      // Each only applies when the recurring row actually names one. A bill
      // paid from a different account than configured now nudges, which is
      // the right way round: an extra "forgot to log it, or paid another
      // way?" costs a message, a missed one costs a payment.
      const windowDays = matchWindowDays(r);
      const windowStart = new Date(r.dueDate);
      windowStart.setDate(windowStart.getDate() - windowDays);
      const windowEnd = new Date(r.dueDate);
      windowEnd.setDate(windowEnd.getDate() + windowDays);
      const amount = Math.abs(Number(r.amount));
      const matched = await paymentRecorded({
        householdId: r.household_id,
        accountId: r.account_id ?? null,
        categoryId: r.category_id ?? null,
        from: windowStart.toISOString().slice(0, 10),
        to: windowEnd.toISOString().slice(0, 10),
        amount,
      });
      // Unread is not unmatched: no "did you pay this?" on a failed read.
      if (matched !== false) continue;

      const { data: members } = await supabase
        .from("household_members")
        .select("id, telegram_user_id")
        .eq("household_id", r.household_id);
      const recipients = (
        r.is_shared
          ? (members ?? [])
          : (members ?? []).filter((m: { id: string }) => m.id === r.owner_member_id)
      ).filter((m: { telegram_user_id: number | null }) => m.telegram_user_id != null) as Array<{ telegram_user_id: number }>;

      const delivered = await sendToAll(
        recipients.map((m) => m.telegram_user_id),
        `I don't see a transaction for "${r.name}" yet (usually around AED ${amount.toFixed(2)}, due ${r.dueDate}) -- forgot to log it, or paid another way?`
      );
      if (!delivered) continue;
      await supabase.from("recurring_nudges").insert({ recurring_id: r.id, due_date: r.dueDate });
      nudged++;
    } catch {
      // One recurring row's nudge failing must never block the rest.
    }
  }
  return { checked: dueRows.length, nudged };
}


// Whether a record for about a bill's amount (within 20%, either way) is in
// Rokda over a window: how both daily checks decide a bill was paid, the
// same test apply_bot_proposal() uses. Asked of the database as "is there
// one", so it is exact however many other records the window holds; reading
// the window and matching it here searched only the first page of it (QA,
// 17 October). Null when it could not be read: unread is not unpaid.
export async function paymentRecorded(q: { householdId: string; accountId: string | null; categoryId: string | null; from: string; to: string; amount: number }): Promise<boolean | null> {
  const lo = q.amount * 0.8;
  const hi = q.amount * 1.2;
  for (const [min, max] of [[-hi, -lo], [lo, hi]]) {
    let query = supabase
      .from("transactions")
      .select("id")
      .eq("household_id", q.householdId)
      .gte("occurred_at", q.from)
      .lte("occurred_at", q.to)
      .gte("amount", min)
      .lte("amount", max)
      .limit(1);
    if (q.accountId) query = query.eq("account_id", q.accountId);
    if (q.categoryId) query = query.eq("category_id", q.categoryId);
    const { data, error } = await query;
    if (error) return null;
    if ((data ?? []).length > 0) return true;
  }
  return false;
}
