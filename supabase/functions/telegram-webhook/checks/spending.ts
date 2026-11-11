// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdDay, householdYearMonth } from "../../_shared/applib/day.js";
import { notableMoves } from "../../_shared/applib/insights.js";
import { supabase } from "../env.ts";
import { allRowsOf, householdRows, monthStartIso, transactionsBetween } from "../tools.ts";
import { splitQuestion } from "../trades.ts";
import { reply, sendToAll } from "../transport.ts";
import { householdsWithLinkedTelegram, prefEnabled, telegramPrefsMap, telegramRecipients } from "./recipients.ts";

// A far more conservative bar than the web Insights screen's own
// "notable move" default (20% off average + AED 50) -- that screen is
// something a member glances at, this is a push notification, and a
// too-sensitive nudge trains the household to ignore it, which defeats
// the point (SHR-283). minPct: 2 means the category has to be running at
// least 3x its trailing average (avg + 2*avg); minAbsolute keeps a
// low-average category (a few AED) from being flagged by a single
// otherwise-ordinary purchase.
export const UNUSUAL_SPEND_MIN_PCT = 2;

export const UNUSUAL_SPEND_MIN_ABSOLUTE = 300;

// The months before this one its usual is averaged over (notableMoves' default).
export const UNUSUAL_SPEND_MONTHS_BACK = 6;


// Runs daily alongside the other checks. Reuses the same trailing-average
// math the web Insights screen shows informationally (notableMoves), just
// with the much stricter bar above. unusual_spend_nudges dedupes per
// (household, category, month) -- flagged once, not re-nagged every day
// even if the category keeps climbing further past the bar.
// A traded holding whose value moved by more than this between its last two
// price days, with no trade between them, is asked about: an unrecorded split
// shows as a fall like that (spec 9).
export const SPLIT_MOVE_PCT = 40;


// Asks each traded holding's owner whether a large move was a split, once for
// that value point (split_asked_for, set only once the question reached
// them). The move is read from the holding's own value history, not the price
// feed's day change: a provider adjusts its previous close for a split, so a
// split day does not show as a move there. Its units are the same at both
// points (no trade between), so the value moved with the price. A holding
// never traded, or sold out, is not asked about.
export async function runSplitCheck(): Promise<{ checked: number; asked: number }> {
  let holdings: Array<{ id: string; name: string; owner_member_id: string | null; split_asked_for: string | null }>;
  try {
    holdings = await allRowsOf("holdings", () =>
      supabase.from("holdings").select("id, name, owner_member_id, split_asked_for").gt("trades_version", 0).gt("quantity", 0).order("id")
    );
  } catch {
    return { checked: 0, asked: 0 };
  }
  let asked = 0;
  for (const h of holdings) {
    if (!h.owner_member_id) continue;
    try {
      const { data: points, error } = await supabase.from("holding_value_history").select("as_of, value_aed")
        .eq("holding_id", h.id).order("as_of", { ascending: false }).limit(2);
      if (error || !points || points.length < 2) continue;
      const [latest, before] = points as Array<{ as_of: string; value_aed: number }>;
      if (h.split_asked_for === latest.as_of || !(Number(before.value_aed) > 0)) continue;
      // A trade dated or recorded since the earlier point moved the value
      // itself.
      const { data: trades, error: tradesError } = await supabase.from("holding_trades").select("id").eq("holding_id", h.id)
        .or(`trade_date.gt.${before.as_of},created_at.gt.${before.as_of}`).limit(1);
      if (tradesError || trades?.length) continue;
      const pct = (Number(latest.value_aed) / Number(before.value_aed) - 1) * 100;
      if (!(Math.abs(pct) > SPLIT_MOVE_PCT)) continue;
      const { data: owner } = await supabase.from("household_members").select("telegram_user_id").eq("id", h.owner_member_id).maybeSingle();
      const chatId = (owner as { telegram_user_id: number | null } | null)?.telegram_user_id;
      if (!chatId) continue;
      if ((await reply(chatId, splitQuestion(h.name, pct))) == null) continue;
      await supabase.from("holdings").update({ split_asked_for: latest.as_of }).eq("id", h.id);
      asked++;
    } catch {
      // One holding's question failing must never block the rest.
    }
  }
  return { checked: holdings.length, asked };
}


export async function runUnusualSpendCheck(): Promise<{ checked: number; nudged: number }> {
  const now = householdDay();
  const { year, month } = householdYearMonth(now);
  const households = await householdsWithLinkedTelegram();
  const prefs = await telegramPrefsMap();

  let nudged = 0;
  for (const householdId of households) {
    if (!prefEnabled(prefs, householdId, "unusual_spend_enabled")) continue;
    try {
      // This month and the six before it, which is what notableMoves averages
      // over. A failed read throws, and the household is skipped today rather
      // than compared against part of its history.
      const [transactions, categories] = await Promise.all([
        transactionsBetween(householdId, monthStartIso(year, month - UNUSUAL_SPEND_MONTHS_BACK), monthStartIso(year, month + 1)),
        householdRows<{ id: string; name: string }>("categories", householdId, "id, name"),
      ]);
      const catById = new Map(categories.map((c) => [c.id, c]));

      const moves = notableMoves(transactions as never, year, month, null, catById, now, {
        monthsBack: UNUSUAL_SPEND_MONTHS_BACK,
        minPct: UNUSUAL_SPEND_MIN_PCT,
        minAbsolute: UNUSUAL_SPEND_MIN_ABSOLUTE,
      });
      if (!moves.length) continue;

      const recipients = await telegramRecipients(householdId);
      if (!recipients.length) continue;

      for (const move of moves as Array<{ categoryId: string; categoryName: string; actual: number; avg: number; evidence: Array<{ merchant: string; amount: number }> }>) {
        const { data: alreadySent } = await supabase
          .from("unusual_spend_nudges")
          .select("household_id")
          .eq("household_id", householdId)
          .eq("category_id", move.categoryId)
          .eq("year", year)
          .eq("month", month)
          .maybeSingle();
        if (alreadySent) continue;

        const biggest = move.evidence[0];
        const evidenceNote = biggest ? ` The biggest single hit was AED ${biggest.amount.toFixed(2)} at ${biggest.merchant}.` : "";
        const message = `Unusual spend: ${move.categoryName} is at AED ${move.actual.toFixed(2)} this month, well above its usual AED ${move.avg.toFixed(2)}.${evidenceNote}`;
        if (!(await sendToAll(recipients, message))) continue;

        await supabase.from("unusual_spend_nudges").insert({ household_id: householdId, category_id: move.categoryId, year, month });
        nudged++;
      }
    } catch {
      // One household's unusual-spend check failing must never block the rest.
    }
  }
  return { checked: households.length, nudged };
}
