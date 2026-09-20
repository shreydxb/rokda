// SHR-236: receives Telegram Bot API webhook updates and turns them into
// intake rows for human review. Never writes a transaction directly — a
// linked member's message or photo always lands in `intake` with
// status='pending', exactly like the existing manual Inbox flow.
//
// Two things an unlinked sender can do: nothing, or redeem a link code
// generated in Settings -> Household. Nothing else is ever attributed to a
// household member who hasn't proven they own that Telegram account.
//
// SHR-239: once an intake row is captured, this also asks an LLM (via
// OpenRouter) to suggest merchant/amount/date/category. That suggestion is
// stored alongside the raw content, never in place of it, and every
// suggested category is checked against the household's real categories
// before being trusted — an unmatched or low-confidence guess is left
// uncategorised rather than inventing a plausible-sounding one. A parsing
// failure never blocks the intake row itself from being captured.
//
// SHR-240: a linked member can also just ask a question -- "how much did we
// spend on groceries this month", "what's our net worth", "when's the FAB Z
// card due". This never lets the LLM answer from its own knowledge: the
// model's only job is to pick one of a small set of real, read-only tool
// functions (backed by the exact same math the frontend screens use, copied
// into supabase/functions/_shared/applib) and the reply is phrased only from
// that tool's real result. A message that looks like an already-happened
// expense/income/refund still goes into `intake` for review, same as ever --
// this only adds a second path for a question, never a shortcut around
// human review for a transaction. This routing only applies to a plain text
// message (no photo/document attached); a photo is presumptively a receipt.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveScopeMemberId, scopedValue } from "../_shared/applib/scope.js";
import { isPrivateChat } from "../_shared/applib/telegramChat.js";
import { LINK_ATTEMPT_WINDOW_MS, linkAttemptRefusal, linkTokenFromMessage, looksLikeLinkToken } from "../_shared/applib/telegramLink.js";
import {
  ambiguousConfirmMessage,
  isConfirmationText,
  isReadyForFastConfirm,
  resolveConfirmTarget,
  resolveCorrectionTarget,
  unknownPromptMessage,
  lookupUnavailableMessage,
  PROMPT_UNADDRESSED,
  PROMPT_FOUND,
  PROMPT_UNKNOWN,
  PROMPT_FAILED,
  THUMBS_UP_EMOJIS,
} from "../_shared/applib/telegramConfirm.js";
import { netWorthSummary } from "../_shared/applib/overviewMath.js";
import { accountValueAed, unvaluedAccounts, unvaluedNote } from "../_shared/applib/accounts.js";
import { monthActualsByCategory } from "../_shared/applib/budget.js";
import { nextDueDate, daysUntilDue } from "../_shared/applib/creditCard.js";
import { lastDueOccurrence, upcomingItems } from "../_shared/applib/recurring.js";
import { isPosted, parseDay, atDayOfMonth, startOfDay, householdToday, householdYearMonth } from "../_shared/applib/day.js";
import { isSpendRow, spendDelta } from "../_shared/applib/transactionKind.js";
import { visibleHoldings, scopedHoldingValue, holdingGain, allocationByClass, portfolioValueChange } from "../_shared/applib/holdings.js";
import { cashCoverStatus, formatCashCoverLine } from "../_shared/applib/cashCover.js";
import { notableMoves } from "../_shared/applib/insights.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const PARSE_MODEL = "google/gemini-2.5-flash-lite";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function tgCall(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Returns the message_id Telegram assigned to what we just sent, or null if
// the send failed or the response did not carry one. The fast-confirm prompt
// is the one caller that needs it: that id is what a later "yes" reply or 👍
// reaction points back at, and so is what ties a confirmation to one specific
// intake rather than to whatever happens to be newest (QA #2).
async function reply(chatId: number, text: string): Promise<number | null> {
  const res = (await tgCall("sendMessage", { chat_id: chatId, text })) as
    | { result?: { message_id?: number } }
    | undefined;
  return res?.result?.message_id ?? null;
}

// QA #2, half two: Telegram redelivers an update whenever the webhook does not
// answer 200 in time, and every side effect below used to run again on that
// second delivery. For a "yes" confirmation that was not merely wasteful --
// the first delivery approved one entry, and by the time the second arrived
// "the newest pending entry" was a DIFFERENT one, so the retry approved that
// too.
//
// The primary key on telegram_update_log is the whole mechanism: the first
// delivery inserts, a redelivery raises 23505, and we stop. See that table's
// migration for why at-most-once is the right trade here.
//
// Returns true when this update has been seen before and must not be handled.
// A failure that is NOT a duplicate-key error (the table is unreachable, say)
// returns false: losing the dedupe is bad, but silently dropping the
// household's messages because a bookkeeping table is down is worse.
async function alreadyHandled(updateId: unknown): Promise<boolean> {
  if (typeof updateId !== "number") return false;
  const { error } = await supabase.from("telegram_update_log").insert({ update_id: updateId });
  return error?.code === "23505";
}

// Counts the rows; _shared/applib/telegramLink.js decides what they mean. See
// there for why an unlinked sender gets a bounded number of guesses at all.
async function linkAttemptBlocked(fromId: number): Promise<string | null> {
  const since = new Date(Date.now() - LINK_ATTEMPT_WINDOW_MS).toISOString();
  const [{ count: sender }, { count: global }] = await Promise.all([
    supabase
      .from("telegram_link_attempts")
      .select("id", { count: "exact", head: true })
      .eq("telegram_user_id", fromId)
      .gt("attempted_at", since),
    supabase.from("telegram_link_attempts").select("id", { count: "exact", head: true }).gt("attempted_at", since),
  ]);
  return linkAttemptRefusal({ sender, global });
}

async function recordLinkFailure(fromId: number): Promise<void> {
  try {
    await supabase.from("telegram_link_attempts").insert({ telegram_user_id: fromId });
  } catch {
    // Best-effort. A counter that failed to increment must not also refuse the
    // person a chance to type their code correctly.
  }
}

// A successful link ends the sender's history, so an ordinary member who
// mistypes once and then succeeds is not one failure closer to a lockout the
// next time they relink a device.
async function clearLinkFailures(fromId: number): Promise<void> {
  try {
    await supabase.from("telegram_link_attempts").delete().eq("telegram_user_id", fromId);
  } catch {
    // Best-effort.
  }
}

// telegram_update_log only has to outlive Telegram's own retry window, which
// is minutes. A week is generous and keeps the table from growing without
// bound. Runs with the other daily passes; a failure here is invisible and
// harmless, so it is swallowed rather than allowed to fail that request.
async function pruneTelegramUpdateLog(): Promise<void> {
  try {
    await supabase
      .from("telegram_update_log")
      .delete()
      .lt("received_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  } catch {
    // Best-effort housekeeping.
  }
  try {
    // Link attempts only matter inside their 15-minute window; a day is kept
    // so a burst is still legible afterwards rather than having erased itself.
    await supabase
      .from("telegram_link_attempts")
      .delete()
      .lt("attempted_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  } catch {
    // Best-effort housekeeping.
  }
}

type TelegramCallKind = "classify_and_route" | "parse_intake" | "phrase_answer";

// SHR-288: metadata about every OpenRouter call this bot makes -- model,
// token counts, latency, success/failure -- so volume and reliability can be
// seen without keeping the actual prompt/response content (which is the
// household's raw financial messages, and deliberately not duplicated here).
// Best-effort: a logging failure must never break the Telegram reply it's
// describing.
async function logTelegramCall(entry: {
  callKind: TelegramCallKind;
  householdId: string | null;
  memberId: string | null;
  model: string | null;
  latencyMs: number;
  success: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  errorType?: string | null;
}): Promise<void> {
  try {
    await supabase.from("telegram_call_log").insert({
      household_id: entry.householdId,
      member_id: entry.memberId,
      call_kind: entry.callKind,
      model: entry.model,
      prompt_tokens: entry.usage?.prompt_tokens ?? null,
      completion_tokens: entry.usage?.completion_tokens ?? null,
      total_tokens: entry.usage?.total_tokens ?? null,
      latency_ms: entry.latencyMs,
      success: entry.success,
      error_type: entry.errorType ?? null,
    });
  } catch {
    // Never let logging itself break the actual Telegram flow.
  }
}

// The shared secret every request to this function must present (see the
// check at the top of Deno.serve). Lives in Supabase Vault, not an
// environment variable -- read via a narrowly-scoped RPC only the
// service-role client this function already uses can call. A lookup
// failure (RPC error, or the secret genuinely unset) returns null, which
// the caller treats as "reject everything" rather than "skip the check".
async function getTelegramWebhookSecret(): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("get_telegram_webhook_secret");
    if (error || typeof data !== "string" || !data) return null;
    return data;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

type IntakeKind = "expense" | "income" | "refund";
const INTAKE_KIND_VALUES = new Set<IntakeKind>(["expense", "income", "refund"]);

type ParsedItem = {
  merchant: string | null;
  amount: number | null;
  currency: string | null;
  occurred_at: string | null;
  categoryName: string | null;
  cardLast4: string | null;
  accountHint: string | null;
  confidence: number;
  kind: IntakeKind;
};

function parseItemFields(parsed: Record<string, unknown>): ParsedItem {
  const amount = typeof parsed.amount === "number" && Number.isFinite(parsed.amount) ? parsed.amount : null;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  const occurredAt = typeof parsed.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.occurred_at) ? parsed.occurred_at : null;
  const currency = typeof parsed.currency === "string" && /^[A-Za-z]{3}$/.test(parsed.currency.trim()) ? parsed.currency.trim().toUpperCase() : null;
  const cardLast4 = typeof parsed.card_last4 === "string" && /^\d{4}$/.test(parsed.card_last4.trim()) ? parsed.card_last4.trim() : null;
  const accountHint = typeof parsed.account_hint === "string" && parsed.account_hint.trim() ? parsed.account_hint.trim() : null;
  // Defaults to 'expense' -- the model is asked for this explicitly (see the
  // prompt below), but an unrecognised or missing value must never silently
  // become something other than today's existing behaviour.
  const kind: IntakeKind = typeof parsed.kind === "string" && INTAKE_KIND_VALUES.has(parsed.kind as IntakeKind) ? (parsed.kind as IntakeKind) : "expense";

  return {
    merchant: typeof parsed.merchant === "string" && parsed.merchant.trim() ? parsed.merchant.trim() : null,
    amount,
    currency,
    occurred_at: occurredAt,
    categoryName: typeof parsed.category === "string" ? parsed.category : null,
    cardLast4,
    accountHint,
    confidence,
    kind,
  };
}

// Calls OpenRouter (Gemini 2.5 Flash Lite: cheap, vision-capable, reliable
// instruction-following) to extract structured line items from raw text
// and/or a receipt photo -- including a forwarded/copy-pasted bank SMS,
// which has its own fairly rigid format ("AED 38.80 spent on card ending
// 1234 at FILLI CAFE on 05-09-26") that the model is told about explicitly
// rather than left to guess at like free-form text. A message can describe
// more than one expense ("bought two plants for 260 and 50") -- this
// returns one item per distinct amount rather than summing or silently
// keeping only the first, which is what a single-object result used to do.
// Returns null on any failure -- the caller degrades to "raw content, no
// suggestions" rather than blocking on this.
async function parseIntakeWithAI(params: {
  rawText: string | null;
  imageBase64: string | null;
  imageMime: string | null;
  categoryNames: string[];
  householdId?: string | null;
  memberId?: string | null;
}): Promise<ParsedItem[] | null> {
  if (!OPENROUTER_API_KEY) return null;
  const { rawText, imageBase64, imageMime, categoryNames, householdId = null, memberId = null } = params;
  if (!rawText && !imageBase64) return null;

  // Dubai, not UTC. This is the date the parser dates an expense to, so
  // deriving it from a UTC runtime filed everything logged between
  // midnight and 04:00 Dubai under the previous day -- in the ledger,
  // permanently, with nothing downstream to notice.
  const today = householdToday();
  const instructions =
    `Extract ALL household expenses/income/refunds described in the message and/or receipt photo below. Most messages describe exactly one, but some describe several separate amounts (e.g. "bought two plants for 260 and 50" is TWO expenses -- never sum multiple amounts into one, and never drop any of them). ` +
    `The message may be free-form text, or a bank/card SMS notification copy-pasted verbatim (e.g. "AED 38.80 spent on your card ending 1234 at FILLI CAFE LLC DXB on 05-09-26 14:32") -- extract from either the same way; a bank SMS almost always describes exactly one. ` +
    `Today's date is ${today}. ` +
    `Respond with ONLY a JSON object, no markdown, matching exactly: ` +
    `{"items": [{"merchant": string|null, "amount": number|null, "currency": string|null, "occurred_at": "YYYY-MM-DD"|null, "category": string|null, "card_last4": string|null, "account_hint": string|null, "confidence": number, "kind": "expense"|"income"|"refund"}, ...]} ` +
    `One item per distinct amount. Shared details (date, account, merchant if it applies to all) should be repeated on every item rather than left null just because it was only stated once in the message. ` +
    `"kind" is "expense" if money left the account (a purchase, a bill paid, an EMI) -- this is the default for almost everything. "income" if money arrived that ISN'T tied to a specific earlier expense (a salary credit, a gift received, interest, cashback treated as a reward rather than a refund). "refund" if money came back specifically because an earlier purchase was returned, cancelled or reimbursed (e.g. "got a refund from Noon for the return", "airline refunded my ticket"). When genuinely unsure between income and refund, prefer "income" -- a refund wrongly filed as income is a smaller mistake than one that tries and fails to link to a specific past purchase. ` +
    `"currency" is the real currency of the amount if stated or clearly implied (e.g. "AED", "USD", "INR") -- null if genuinely unstated. Never assume AED just because the household is AED-based -- only state it if the message actually says or implies it. ` +
    `"card_last4" is the last 4 digits of a card mentioned (e.g. "card ending 1234", "card no. ...1234"), or null if none is mentioned. ` +
    `"account_hint" is the account/card NAME mentioned in the message, if any (e.g. "Wio", "FAB Z", "ENBD Noon", "FAB Islamic") -- a short free-text name, not digits, or null if no account/card is named. ` +
    `"category" MUST be exactly one of these household categories, verbatim, or null if none clearly fits -- never invent a category name: ` +
    `${JSON.stringify(categoryNames)}. ` +
    `This list mixes broad categories (e.g. "Transport") with specific subcategories of them (e.g. "Salik / Parking / Misc", "Car EMI", "Fuel" -- all under Transport). Always prefer the most specific one that clearly fits over its broader parent: a toll/parking charge is "Salik / Parking / Misc", not "Transport"; a car loan instalment is "Car EMI", not "Transport". Only fall back to the broad parent when nothing more specific applies (e.g. a taxi fare, which fits none of Transport's subcategories). ` +
    `Note: "Noon Minutes" (or "Minutes") is Noon's fast grocery delivery service, not its general marketplace -- categorise it as groceries, not shopping, if a groceries-like category exists. ` +
    `"confidence" is your own confidence in this extraction, 0 to 1. ` +
    `If you cannot determine a field, use null rather than guessing.`;

  const content: Array<Record<string, unknown>> = [{ type: "text", text: instructions }];
  if (rawText) content.push({ type: "text", text: `Message: ${rawText}` });
  if (imageBase64 && imageMime) {
    content.push({ type: "image_url", image_url: { url: `data:${imageMime};base64,${imageBase64}` } });
  }

  const startedAt = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PARSE_MODEL,
        messages: [{ role: "user", content }],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      await logTelegramCall({
        callKind: "parse_intake",
        householdId,
        memberId,
        model: PARSE_MODEL,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorType: `http_${res.status}`,
      });
      return null;
    }
    const body = await res.json();
    await logTelegramCall({
      callKind: "parse_intake",
      householdId,
      memberId,
      model: PARSE_MODEL,
      latencyMs: Date.now() - startedAt,
      success: true,
      usage: body?.usage,
    });
    const raw = body?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;
    const parsedBody = JSON.parse(raw);

    // Tolerate a flat single-object response (older shape, or the model
    // ignoring the wrapper) by treating it as a one-item array.
    const rawItems: unknown[] = Array.isArray(parsedBody?.items) ? parsedBody.items : [parsedBody];
    const items = rawItems
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map(parseItemFields)
      .filter((item) => item.amount !== null || item.merchant !== null);

    return items.length > 0 ? items : null;
  } catch {
    await logTelegramCall({
      callKind: "parse_intake",
      householdId,
      memberId,
      model: PARSE_MODEL,
      latencyMs: Date.now() - startedAt,
      success: false,
      errorType: "exception",
    });
    return null;
  }
}

// A card account's name follows the "Name •1234" convention (see
// accountOptionLabel in the frontend) -- if a bank SMS names a card ending,
// match it against that suffix. Only trusted when it resolves to exactly
// one open account; otherwise the reviewer picks manually, same as today.
async function matchAccountByCardLast4(householdId: string, cardLast4: string | null): Promise<{ id: string; name: string } | null> {
  if (!cardLast4) return null;
  const { data: accounts } = await supabase.from("accounts").select("id, name").eq("household_id", householdId).is("archived_at", null);
  const matches = (accounts ?? []).filter((a: { name: string }) => a.name.includes(cardLast4));
  return matches.length === 1 ? matches[0] : null;
}

// An account name's own "•1234" card suffix is never what gets said out loud
// ("paid via FAB Z", not "paid via FAB Z bullet nine four one seven") -- strip
// it before comparing so the base name is what actually has to match.
function accountBaseName(name: string): string {
  return name.replace(/\s*•\s*\d+\s*$/, "").trim().toLowerCase();
}

// A plain account/card name mentioned in free text (e.g. "paid on Wio",
// "via FAB Z") -- with only one card per bank the last-4-digits suffix is
// rarely worth typing, so this matches on name alone. Deliberately
// one-directional (the account's own base name must contain the hint, never
// the reverse): "FAB Islamic" said in a message should match the account
// named "FAB Islamic Etihad" (a shortened mention of the fuller name), but
// "FAB Z" must NOT match a bare account named plain "FAB" just because "FAB"
// is a prefix of "FAB Z" -- the reverse direction would let a short, generic
// account name silently swallow a longer, more specific one. Same safety bar
// as the card-last4 match either way: only trusted when it resolves to
// exactly one open account, so a name two accounts share (the household
// currently has two bare "FAB" and two bare "WIO" accounts alongside the
// named cards) abstains rather than guessing which one.
async function matchAccountByNameHint(householdId: string, hint: string | null): Promise<{ id: string; name: string } | null> {
  const norm = hint?.trim().toLowerCase();
  if (!norm) return null;
  const { data: accounts } = await supabase.from("accounts").select("id, name").eq("household_id", householdId).is("archived_at", null);
  const matches = (accounts ?? []).filter((a: { name: string }) => {
    const base = accountBaseName(a.name);
    return base.length > 1 && base.includes(norm);
  });
  return matches.length === 1 ? matches[0] : null;
}

// The household's own past categorisation of a merchant outweighs a fresh
// guess: once "Moisturiser Alseer" has been approved under Shopping, a later
// message the model only extracts as "Alseer" should still inherit it rather
// than getting a fresh, possibly different guess. The model doesn't extract
// merchant names consistently, so this matches when the NEW merchant is a
// substring of a PAST one -- deliberately one-directional. The other
// direction (a short past merchant matching a longer new one) is NOT
// trusted: a household that once logged plain "Noon" under Shopping must
// never have that silently applied to "Noon Minutes" later, which is a
// genuinely different, groceries service the model already knows to
// distinguish (see the prompt hint above) -- a short generic name matching a
// longer, more specific one is exactly the false-positive this must avoid.
async function matchCategoryFromMerchantHistory(householdId: string, merchant: string | null): Promise<{ id: string; name: string } | null> {
  const norm = merchant?.trim().toLowerCase();
  if (!norm || norm.length < 3) return null;
  const { data: rows } = await supabase
    .from("transactions")
    .select("merchant, category_id")
    .eq("household_id", householdId)
    .not("merchant", "is", null)
    .not("category_id", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (!rows) return null;

  const counts = new Map<string, number>();
  for (const r of rows as Array<{ merchant: string; category_id: string }>) {
    const past = r.merchant.trim().toLowerCase();
    if (!past.includes(norm)) continue;
    counts.set(r.category_id, (counts.get(r.category_id) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const [topId] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

  const { data: category } = await supabase.from("categories").select("id, name").eq("id", topId).maybeSingle();
  return category ?? null;
}

// Same check as src/lib/duplicates.js findDuplicate (merchant + amount +
// account, within 3 days), ported server-side. The Inbox review screen
// already flags this, but the "yes"/reaction fast-confirm path skips the
// Inbox entirely -- without this, a resent message with everything already
// resolved could get confirmed straight into a second real transaction with
// no warning at all.
async function findDuplicateTransaction(
  householdId: string,
  accountId: string | null,
  merchant: string | null,
  amount: number | string | null,
  occurredAt: string | null
): Promise<{ id: string; amount: number; occurred_at: string } | null> {
  const normMerchant = merchant?.trim().toLowerCase();
  const numAmount = amount != null ? Number(amount) : null;
  if (!accountId || !normMerchant || !numAmount || !occurredAt) return null;
  const occurred = new Date(occurredAt).getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const { data: rows } = await supabase
    .from("transactions")
    .select("id, amount, merchant, occurred_at")
    .eq("household_id", householdId)
    .eq("account_id", accountId);

  const match = (rows ?? []).find((t: { amount: number; merchant: string | null; occurred_at: string }) => {
    if ((t.merchant ?? "").trim().toLowerCase() !== normMerchant) return false;
    if (Math.abs(Math.abs(Number(t.amount)) - numAmount) > 0.01) return false;
    const diffDays = Math.abs(new Date(t.occurred_at).getTime() - occurred) / DAY_MS;
    return diffDays <= 3;
  });
  return match ? { id: match.id, amount: Number(match.amount), occurred_at: match.occurred_at } : null;
}

const PENDING_WINDOW_MS = 20 * 60 * 1000;

// CONFIRM_REGEX, isReadyForFastConfirm, resolveConfirmTarget and
// ambiguousConfirmMessage all live in _shared/applib/telegramConfirm.js --
// see the import at the top of this file. They are pure, and they decide which
// entry a confirmation records, so they are kept where a unit test can reach
// them (QA #2).
type PendingIntakeRow = {
  id: string;
  status: string;
  raw_text: string | null;
  created_at: string;
  parsed_merchant: string | null;
  parsed_amount: number | string | null;
  parsed_date: string | null;
  parsed_category_id: string | null;
  parsed_account_id: string | null;
  parsed_currency: string | null;
  parsed_kind: string | null;
  confidence: number | string | null;
  // The bot's own fast-confirm prompt for this row, when one was sent. This
  // is what makes a confirmation refer to a specific entry (QA #2).
  confirm_chat_id: number | null;
  confirm_message_id: number | null;
};

const RECENT_INTAKE_COLUMNS =
  "id, status, raw_text, created_at, parsed_merchant, parsed_amount, parsed_date, parsed_category_id, parsed_account_id, parsed_currency, parsed_kind, confidence, confirm_chat_id, confirm_message_id";

// The intake whose fast-confirm prompt is THIS message, found by the prompt
// itself rather than by searching the recent list.
//
// This is the lookup intake_confirm_prompt_idx was created for, and for a
// while nothing performed it: the binding was resolved in memory over
// a capped, time-windowed recent list rather than by a query -- ten rows, a
// 20-minute window. A prompt outside either bound looked identical to a message
// that was never a prompt, so the handler fell through to the unaddressed rule
// and confirmed a DIFFERENT entry -- QA #2 again, in a narrower form. Reproduced
// by test: reply to a prompt not in the fetched list, and another entry was
// recorded.
//
// No window and no limit here on purpose. A prompt is a prompt however old it
// is, and the pair is unique enough that age adds nothing. Scoped to the
// member so one person's reply can never resolve to another's entry.
type PromptLookup = { kind: string; row: PendingIntakeRow | null };

async function intakeForPrompt(
  householdId: string,
  memberId: string,
  chatId: number,
  messageId: number | null
): Promise<PromptLookup> {
  // Nothing was aimed at. This is the ONLY outcome that may fall back to a
  // recent-candidate rule.
  if (messageId == null) return { kind: PROMPT_UNADDRESSED, row: null };

  const { data, error } = await supabase
    .from("intake")
    .select(RECENT_INTAKE_COLUMNS)
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .eq("confirm_chat_id", chatId)
    .eq("confirm_message_id", messageId)
    .maybeSingle();

  // The error used to be discarded, which made a failed query identical to
  // "no such prompt" -- and that fell through to the unaddressed rule and
  // confirmed an entry the member never named. A database error must never
  // be able to decide which expense gets recorded.
  if (error) return { kind: PROMPT_FAILED, row: null };
  if (!data) return { kind: PROMPT_UNKNOWN, row: null };
  return { kind: PROMPT_FOUND, row: data as PendingIntakeRow };
}

// Entries a bare, unaddressed "yes" could plausibly mean. Filtered to pending
// in SQL rather than fetched-then-filtered: the previous query deliberately
// included approved and rejected rows, so nine recent approvals could push a
// second pending entry past its cap of ten and make an ambiguous case look
// like a single obvious one -- a decision taken from an incomplete list, which
// is the shape of QA #2 itself. Asking for one more row than the cap is how
// truncation is detected rather than assumed away.
const CONFIRM_CANDIDATE_CAP = 25;

async function confirmCandidates(
  householdId: string,
  memberId: string
): Promise<{ rows: PendingIntakeRow[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from("intake")
    .select(RECENT_INTAKE_COLUMNS)
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .eq("status", "pending")
    .gt("created_at", new Date(Date.now() - PENDING_WINDOW_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(CONFIRM_CANDIDATE_CAP + 1);
  // A failed candidate query is reported as truncated, not as "none waiting":
  // an empty list from an error would silently mean "nothing to confirm".
  if (error) return { rows: [], truncated: true };
  const rows = (data ?? []) as PendingIntakeRow[];
  return { rows: rows.slice(0, CONFIRM_CANDIDATE_CAP), truncated: rows.length > CONFIRM_CANDIDATE_CAP };
}

// A word/emoji reply confirming a pending entry, or a 👍/✅ reaction on one of
// the bot's own prompts (see handleReaction below) -- both routes land in
// confirmPendingIntake below, so there is exactly one place that calls
// approve_intake for the fast-confirm path.

// Sends a fast-confirm prompt and records, on the intake it is about, which
// message that prompt turned out to be. Everything that later resolves a "yes"
// or a 👍 back to one specific entry depends on this write having happened
// (QA #2).
//
// The prompt is sent first and recorded second, so a failure to record costs
// the binding but never the message. Losing the binding degrades to the
// unaddressed case -- confirmable while it is the only entry waiting, refused
// with a question when it is not -- which is the safe direction.
async function sendFastConfirmPrompt(chatId: number, intakeId: string, text: string): Promise<void> {
  const messageId = await reply(chatId, text);
  if (messageId == null) return;
  await supabase
    .from("intake")
    .update({ confirm_chat_id: chatId, confirm_message_id: messageId })
    .eq("id", intakeId);
}

async function confirmPendingIntake(chatId: number, householdId: string, recentPending: PendingIntakeRow): Promise<void> {
  try {
    // A final safety check right before writing: the eligibility check that
    // offered this fast-confirm already ran a duplicate check at parse time,
    // but a duplicate could exist now that didn't then (e.g. entered
    // manually in the portal in between). Never silently record a second
    // real transaction -- fall back to the Inbox instead.
    const duplicate = await findDuplicateTransaction(
      householdId,
      recentPending.parsed_account_id,
      recentPending.parsed_merchant,
      recentPending.parsed_amount,
      recentPending.parsed_date
    );
    if (duplicate) {
      await reply(
        chatId,
        `Hold on -- this looks like it might duplicate an existing AED ${duplicate.amount.toFixed(2)} transaction on ${duplicate.occurred_at}. Please review it in the Inbox instead.`
      );
      return;
    }

    // Falls back to 'expense' for a row the parser never classified (e.g.
    // parsed_kind is null on an old row from before this column existed) --
    // exactly today's prior hardcoded behaviour, now just explicit about it.
    const kind = (recentPending.parsed_kind as IntakeKind | null) ?? "expense";
    const { error: approveError } = await supabase.rpc("approve_intake", {
      p_intake_id: recentPending.id,
      p_account_id: recentPending.parsed_account_id,
      p_amount: recentPending.parsed_amount,
      p_occurred_at: recentPending.parsed_date,
      p_kind: kind,
      p_category_id: recentPending.parsed_category_id,
      p_currency: "AED",
      p_merchant: recentPending.parsed_merchant,
    });
    if (approveError) throw approveError;
    const [{ data: acct }, { data: cat }] = await Promise.all([
      supabase.from("accounts").select("name").eq("id", recentPending.parsed_account_id).maybeSingle(),
      recentPending.parsed_category_id
        ? supabase.from("categories").select("name").eq("id", recentPending.parsed_category_id).maybeSingle()
        : Promise.resolve({ data: null as { name: string } | null }),
    ]);
    const kindLabel = kind === "income" ? "income " : kind === "refund" ? "refund " : "";
    await reply(
      chatId,
      `Recorded: AED ${Number(recentPending.parsed_amount).toFixed(2)} ${kindLabel}at ${recentPending.parsed_merchant} (${acct?.name ?? "account"}${cat?.name ? `, ${cat.name}` : ""}) on ${recentPending.parsed_date}.`
    );
  } catch {
    await reply(chatId, "Something went wrong confirming that -- please check the Inbox.");
  }
}

// A 👍/✅ reaction (long-press a message in Telegram, no typing needed) on one
// of the bot's own fast-confirm prompts. The reaction event carries the
// message_id it was placed on, which is exactly the id recorded on the intake
// when that prompt was sent -- so this route resolves to one specific entry
// rather than to whichever is newest. Requires the bot's webhook to be
// registered for "message_reaction" updates (see the ?setup=1 handler).
async function handleReaction(reaction: Record<string, unknown>): Promise<Response> {
  const chat = reaction.chat as Record<string, unknown> | undefined;
  const user = reaction.user as Record<string, unknown> | undefined;
  const chatId = chat?.id as number | undefined;
  const fromId = user?.id as number | undefined;
  const messageId = reaction.message_id as number | undefined;
  const newReaction = reaction.new_reaction as Array<{ type?: string; emoji?: string }> | undefined;
  if (!chatId || !fromId) return new Response("ok");
  // Same boundary as a typed message: a 👍 in a group must not record an
  // expense or draw a reply carrying an amount. Silently, since a reaction is
  // not addressed to anyone.
  if (!isPrivateChat(chat)) return new Response("ok");
  if (!(newReaction ?? []).some((r) => r.type === "emoji" && THUMBS_UP_EMOJIS.has(r.emoji ?? ""))) {
    return new Response("ok");
  }

  const { data: member } = await supabase
    .from("household_members")
    .select("id, household_id")
    .eq("telegram_user_id", fromId)
    .maybeSingle();
  if (!member) return new Response("ok");

  // Unlike a typed "yes", a reaction always names the message it is on, so
  // this route can always be exact. A 👍 on a message that isn't one of our
  // fast-confirm prompts confirms nothing at all now -- it used to approve
  // whatever was newest (QA #2).
  // A reaction always names the message it is on, so this route is ALWAYS
  // addressed -- there is no such thing as an unaddressed 👍. No candidate
  // list is fetched or passed: a reaction on something that is not one of our
  // prompts must confirm nothing, and the surest way to guarantee that is to
  // give the resolver nothing to fall back to. The previous code did pass a
  // recent list, and a 👍 on an unrelated message approved the sole pending
  // entry while a comment claimed it confirmed nothing.
  const look = await intakeForPrompt(member.household_id, member.id, chatId, messageId ?? null);
  const target = resolveConfirmTarget({ lookup: look.kind, row: look.row });
  if (target.kind === "one") await confirmPendingIntake(chatId, member.household_id, target.row);
  else if (target.kind === "unavailable") await reply(chatId, lookupUnavailableMessage());
  // 'unknown' and 'none' stay silent here: a reaction on an ordinary message
  // is not a question, and answering every stray 👍 would be noise.
  return new Response("ok");
}

// ---------------------------------------------------------------------------
// SHR-240: conversational query tools. Each one queries real household data
// and returns a plain structured result -- never a phrased sentence, never a
// number the tool itself didn't compute. phraseAnswer() is the only thing
// that turns a tool result into a sentence, and it is instructed to use only
// what's in that result.
// ---------------------------------------------------------------------------

const SCOPE_ENUM = ["me", "partner", "both"];

// update_last_expense is only offered when there's actually a recent pending
// entry to correct (see the caller) -- offering it unconditionally would
// invite the model to "correct" something that doesn't exist.
function buildTools(hasRecentPending: boolean) {
  const tools: unknown[] = [
    {
      type: "function",
      function: {
        name: "log_expense",
        description:
          "The message reports a real expense, income, or refund that already happened (e.g. 'spent 40 on lunch', 'got paid 500'). Call this so it can be captured for review -- never estimate or state the amount yourself.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
  ];
  if (hasRecentPending) {
    tools.push({
      type: "function",
      function: {
        name: "update_last_expense",
        description:
          "The message is explicitly correcting or amending the most recent pending entry just sent (not yet reviewed) -- e.g. 'actually it was 45 not 40', 'sorry I meant lunch', 'correction: ...'. Only use this for a clear, explicit correction signal on that specific recent entry. When in doubt, prefer log_expense instead -- a duplicate entry is caught and flagged for review anyway, but silently overwriting a different real expense is not recoverable.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    });
  }
  return [...tools, ...TOOLS_BASE];
}

const TOOLS_BASE = [
  {
    type: "function",
    function: {
      name: "get_category_spend",
      description: "Real spend in one household expense category over a period, e.g. 'how much did we spend on groceries this month'.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "The category name as the user said it." },
          period: { type: "string", enum: ["this_month", "last_month", "this_year"] },
          scope: {
            type: "string",
            enum: SCOPE_ENUM,
            description: "Whose spend: default 'me' unless the question clearly asks about the whole household ('both') or names the other person ('partner').",
          },
        },
        required: ["category", "period"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_net_worth",
      description: "Real current net worth (accounts + holdings, minus liabilities), e.g. 'what's our net worth'.",
      parameters: {
        type: "object",
        properties: { scope: { type: "string", enum: SCOPE_ENUM } },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account_balance",
      description: "Real current balance of one specific named account or card, e.g. 'FAB Z card' or 'WIO savings'.",
      parameters: {
        type: "object",
        properties: { account_name: { type: "string" } },
        required: ["account_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_upcoming_bills",
      description: "Real recurring bills and credit-card due dates in the next 14 days, e.g. 'when's the FAB Z card due' or 'what bills are coming up'.",
      parameters: {
        type: "object",
        properties: { scope: { type: "string", enum: SCOPE_ENUM } },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_budget_status",
      description: "Real budgeted amount vs actual spend so far this month for one category.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          scope: { type: "string", enum: SCOPE_ENUM },
        },
        required: ["category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_holdings",
      description:
        "Real investment/holdings data -- either the whole portfolio (total value, allocation by asset class, gain/loss) or one specific named holding (e.g. 'Apple stock', 'Bitcoin', 'HDFC mutual fund'). Use for any question about investments, stocks, crypto, mutual funds, or portfolio performance.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "A specific holding's name as the user said it, if they asked about one in particular. Omit for the whole portfolio.",
          },
          range: {
            type: "string",
            enum: ["1W", "1M", "3M", "6M", "YTD", "1Y"],
            description: "Only if asking how holdings have performed over a period, e.g. 'how are my investments doing this month'. Omit for a current snapshot.",
          },
          scope: { type: "string", enum: SCOPE_ENUM },
        },
        required: ["scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_goal_contribution",
      description:
        "The message reports money being put toward a savings or debt-payoff GOAL specifically (e.g. 'put 500 toward emergency fund', 'added 1000 to the house downpayment goal', 'paid 300 extra on the car loan goal'). This is a goal-tracking entry only -- it never touches any account balance or the ledger, so never also call log_expense for the same message. If the message is just an ordinary purchase or bill with no named goal, use log_expense instead.",
      parameters: {
        type: "object",
        properties: {
          goal_name: { type: "string", description: "The goal's name as the user said it." },
          amount: { type: "number", description: "The AED amount put toward the goal." },
          occurred_at: { type: "string", description: "YYYY-MM-DD if a date is stated; omit to use today." },
        },
        required: ["goal_name", "amount"],
      },
    },
  },
];

function resolveCategoryByName(categories: Array<{ id: string; name: string }>, name: string) {
  const norm = name.trim().toLowerCase();
  return categories.find((c) => c.name.toLowerCase() === norm) ?? null;
}

// monthActualsByCategory is month-scoped; this sums it across whichever
// months a period actually covers rather than re-deriving the arithmetic.
function categorySpendForPeriod(
  transactions: unknown[],
  categoryId: string,
  period: string,
  scopeMemberId: string | null,
  now: Date
): number {
  const { year, month } = householdYearMonth(now);
  if (period === "last_month") {
    const ly = month === 1 ? year - 1 : year;
    const lm = month === 1 ? 12 : month - 1;
    return monthActualsByCategory(transactions as never, ly, lm, scopeMemberId, now).get(categoryId) ?? 0;
  }
  if (period === "this_year") {
    let total = 0;
    for (let m = 1; m <= month; m++) {
      total += monthActualsByCategory(transactions as never, year, m, scopeMemberId, now).get(categoryId) ?? 0;
    }
    return total;
  }
  return monthActualsByCategory(transactions as never, year, month, scopeMemberId, now).get(categoryId) ?? 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function toolGetCategorySpend(householdId: string, scopeMemberId: string | null, args: Record<string, unknown>) {
  const { data: categories } = await supabase
    .from("categories")
    .select("id, name")
    .eq("household_id", householdId)
    .eq("kind", "expense")
    .eq("archived", false);
  const cat = resolveCategoryByName(categories ?? [], String(args.category ?? ""));
  if (!cat) return { error: "category_not_found", available: (categories ?? []).map((c) => c.name) };

  const { data: transactions } = await supabase
    .from("transactions")
    .select("amount, kind, occurred_at, category_id, is_shared, owner_member_id")
    .eq("household_id", householdId)
    .eq("category_id", cat.id);

  const spend = categorySpendForPeriod(transactions ?? [], cat.id, String(args.period ?? "this_month"), scopeMemberId, new Date());
  return { category: cat.name, period: args.period, spend_aed: round2(spend) };
}

async function toolGetNetWorth(householdId: string, scopeMemberId: string | null) {
  const [{ data: accounts }, { data: holdings }] = await Promise.all([
    supabase.from("accounts").select("*").eq("household_id", householdId),
    supabase.from("holdings").select("*").eq("household_id", householdId),
  ]);
  const summary = netWorthSummary((accounts ?? []) as never, scopeMemberId, (holdings ?? []) as never);
  // The count of accounts the total could not include travels with the
  // total. phraseAnswer is told to use only what a tool returns, so if this
  // is dropped here the bot cannot say the figure is incomplete -- and a net
  // worth quietly missing a foreign loan is the exact failure QA #4 found.
  return {
    net_worth_aed: round2(summary.netWorth),
    assets_aed: round2(summary.assets),
    liabilities_aed: round2(summary.liabilities),
    unconverted_accounts: summary.unvalued,
    ...(summary.unvalued > 0 ? { incomplete: unvaluedNote(summary.unvalued) } : {}),
  };
}

async function toolGetAccountBalance(householdId: string, args: Record<string, unknown>) {
  const { data: accounts } = await supabase.from("accounts").select("*").eq("household_id", householdId).is("archived_at", null);
  const norm = String(args.account_name ?? "").trim().toLowerCase();
  const matches = (accounts ?? []).filter((a: { name: string }) => a.name.toLowerCase().includes(norm));
  if (matches.length === 0) return { error: "account_not_found", available: (accounts ?? []).map((a: { name: string }) => a.name) };
  if (matches.length > 1) return { error: "ambiguous_account", matches: matches.map((a: { name: string }) => a.name) };
  const a = matches[0] as { name: string; balance: number; balance_aed: number | null; currency: string };
  const aed = accountValueAed(a);
  // No conversion yet: report the native balance as native rather than
  // relabelling it AED. `balance_aed ?? balance` answered "what's in the
  // India account" with "AED 20,000" when it holds 20,000 rupees (QA #4).
  if (aed === null) {
    return { account: a.name, balance: round2(Number(a.balance ?? 0)), currency: a.currency, balance_aed: null, note: "no AED conversion recorded for this account" };
  }
  return { account: a.name, balance_aed: round2(aed), currency: a.currency };
}

async function toolGetUpcomingBills(householdId: string, scopeMemberId: string | null) {
  const [{ data: recurring }, { data: accounts }] = await Promise.all([
    supabase.from("recurring").select("*").eq("household_id", householdId),
    supabase.from("accounts").select("*").eq("household_id", householdId).is("archived_at", null),
  ]);
  const now = new Date();
  const visibleRecurring = (recurring ?? []).filter(
    (r: { is_shared: boolean; owner_member_id: string | null }) => scopeMemberId === null || r.is_shared || r.owner_member_id === scopeMemberId
  );
  // A recurring row carries its own currency and there is no converted column
  // for it anywhere, so a non-AED bill has no AED amount -- the same position
  // a never-converted account is in. Labelling its native figure `amount_aed`
  // is the "10,000 rupees counted as 10,000 dirhams" defect (QA #4), and this
  // sum feeds the cash-cover verdict, so it is stated as unknown instead.
  const bills = upcomingItems(visibleRecurring as never, 14, now).map(
    (r: { name: string; amount: number; currency: string | null; dueDate: Date }) => {
      const native = round2(Math.abs(Number(r.amount)));
      const isAed = String(r.currency ?? "AED").toUpperCase() === "AED";
      return {
        name: r.name,
        amount_aed: isAed ? native : null,
        ...(isAed ? {} : { amount: native, currency: r.currency, note: "no AED conversion recorded" }),
        due_date: r.dueDate.toISOString().slice(0, 10),
      };
    }
  );

  const cardBills: Array<{ name: string; amount_owed_aed: number; due_date: string }> = [];
  for (const a of (accounts ?? []) as Array<{ type: string; is_shared: boolean; owner_member_id: string | null; name: string; balance: number; balance_aed: number | null; due_day: number | null }>) {
    if (a.type !== "credit_card") continue;
    if (!(scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId)) continue;
    // A card with no AED conversion has no AED amount owed. It is still a
    // bill, so it is still listed -- with its amount marked unknown rather
    // than with its native balance wearing an "_aed" label (QA #4).
    const aed = accountValueAed(a);
    if ((aed ?? Number(a.balance ?? 0)) <= 0) continue;
    const days = daysUntilDue(a.due_day, now);
    if (days === null || days < 0 || days > 14) continue;
    cardBills.push({
      name: a.name,
      amount_owed_aed: aed === null ? null : round2(aed),
      ...(aed === null ? { amount_owed: round2(Number(a.balance ?? 0)), currency: a.currency, note: "no AED conversion recorded" } : {}),
      due_date: nextDueDate(a.due_day, now)!.toISOString().slice(0, 10),
    } as never);
  }

  const unconverted = unvaluedAccounts((accounts ?? []) as never).length;
  return {
    recurring: bills,
    credit_cards: cardBills,
    ...(unconverted > 0 ? { unconverted_accounts: unconverted } : {}),
  };
}

// Household-wide (scope=null), like /brief -- "can we cover what's due" is a
// shared question, not a personal one. Reuses toolGetUpcomingBills's 14-day
// bill list rather than re-querying recurring/credit-card rows a second
// time; cashCoverStatus narrows it down to the tighter `days` window itself.
async function toolGetCashCover(householdId: string, days = 7) {
  const [{ data: accounts }, bills] = await Promise.all([
    supabase.from("accounts").select("*").eq("household_id", householdId).is("archived_at", null),
    toolGetUpcomingBills(householdId, null),
  ]);
  return cashCoverStatus((accounts ?? []) as never, bills as never, { days, today: parseDay(householdToday()) });
}

async function toolGetBudgetStatus(householdId: string, scopeMemberId: string | null, args: Record<string, unknown>) {
  const { data: categories } = await supabase
    .from("categories")
    .select("id, name")
    .eq("household_id", householdId)
    .eq("kind", "expense")
    .eq("archived", false);
  const cat = resolveCategoryByName(categories ?? [], String(args.category ?? ""));
  if (!cat) return { error: "category_not_found", available: (categories ?? []).map((c) => c.name) };

  const now = new Date();
  const { year, month } = householdYearMonth(now);
  const [{ data: budgetRow }, { data: transactions }] = await Promise.all([
    supabase.from("budgets").select("amount").eq("household_id", householdId).eq("category_id", cat.id).eq("year", year).eq("month", month).maybeSingle(),
    supabase.from("transactions").select("amount, kind, occurred_at, category_id, is_shared, owner_member_id").eq("household_id", householdId).eq("category_id", cat.id),
  ]);
  const actual = monthActualsByCategory((transactions ?? []) as never, year, month, scopeMemberId, now).get(cat.id) ?? 0;
  const budgeted = budgetRow ? Number(budgetRow.amount) : null;
  return {
    category: cat.name,
    budgeted_aed: budgeted !== null ? round2(budgeted) : null,
    actual_aed: round2(actual),
    remaining_aed: budgeted !== null ? round2(budgeted - actual) : null,
    note: budgeted === null ? "No budget set for this category this month." : null,
  };
}

// Named-holding lookup uses the same "must resolve to exactly one" bar as
// account/category matching elsewhere in this file -- a name two holdings
// share abstains rather than guessing which one. With no name, this returns
// a portfolio-level view instead: total value, allocation by asset class,
// and an invested-value-based gain (only over holdings that actually have a
// real invested figure -- see holdingGain, never a guessed cost basis).
async function toolGetHoldings(householdId: string, scopeMemberId: string | null, args: Record<string, unknown>) {
  const { data: holdings } = await supabase.from("holdings").select("*").eq("household_id", householdId);
  const visible = visibleHoldings((holdings ?? []) as never, scopeMemberId) as Array<{
    id: string;
    name: string;
    asset_class: string;
    quantity: number | null;
    value_aed: number;
    invested_value_aed: number | null;
    day_change_pct: number | null;
    priced_at: string | null;
    is_shared: boolean;
    owner_member_id: string | null;
  }>;

  const nameArg = typeof args.name === "string" ? args.name.trim() : "";
  if (nameArg) {
    const norm = nameArg.toLowerCase();
    const matches = visible.filter((h) => h.name.toLowerCase().includes(norm));
    if (matches.length === 0) return { error: "holding_not_found", available: visible.map((h) => h.name) };
    if (matches.length > 1) return { error: "ambiguous_holding", matches: matches.map((h) => h.name) };
    const h = matches[0];
    const gain = holdingGain(h as never, scopeMemberId);
    return {
      name: h.name,
      asset_class: h.asset_class,
      quantity: h.quantity,
      value_aed: round2(scopedHoldingValue(h as never, scopeMemberId)),
      day_change_pct: h.day_change_pct,
      gain_aed: gain ? round2(gain.absolute) : null,
      gain_pct: gain ? round2(gain.pct * 100) : null,
      priced_at: h.priced_at,
    };
  }

  const totalValue = visible.reduce((s, h) => s + scopedHoldingValue(h as never, scopeMemberId), 0);
  const allocation = allocationByClass(visible as never, scopeMemberId).map((a: { assetClass: string; value: number; share: number }) => ({
    asset_class: a.assetClass,
    value_aed: round2(a.value),
    share_pct: round2(a.share * 100),
  }));

  // Only holdings with a real invested_value_aed contribute to this --
  // mixing in holdings with no cost basis would silently understate the
  // gain rather than reflect an unknown one.
  let investedBasis = 0;
  let investedNowValue = 0;
  let anyInvested = false;
  for (const h of visible) {
    const gain = holdingGain(h as never, scopeMemberId);
    if (gain === null) continue;
    anyInvested = true;
    const nowValue = scopedHoldingValue(h as never, scopeMemberId);
    investedNowValue += nowValue;
    investedBasis += nowValue - gain.absolute;
  }
  const overallGain = anyInvested
    ? { gain_aed: round2(investedNowValue - investedBasis), gain_pct: investedBasis > 0 ? round2(((investedNowValue - investedBasis) / investedBasis) * 100) : null }
    : null;

  const result: Record<string, unknown> = {
    total_value_aed: round2(totalValue),
    allocation,
    overall_gain: overallGain,
  };

  const range = typeof args.range === "string" ? args.range : null;
  if (range) {
    const ids = visible.map((h) => h.id);
    const { data: history } = ids.length
      ? await supabase.from("holding_value_history").select("holding_id, as_of, value_aed").in("holding_id", ids)
      : { data: [] as Array<{ holding_id: string; as_of: string; value_aed: number }> };
    const change = portfolioValueChange(visible as never, (history ?? []) as never, range, scopeMemberId);
    result.range = range;
    // Deliberately not called "performance" any more. It moves when money is
    // added or withdrawn exactly as it moves on a price change, and
    // phraseAnswer may only use what a tool returns -- so if the caveat is not
    // in the result, the bot cannot help reporting a deposit as a gain
    // (QA #5).
    result.range_value_change = change.available
      ? {
          start_value_aed: round2(change.startTotal!),
          now_value_aed: round2(change.nowTotal),
          change_aed: round2(change.absolute!),
          change_pct: change.pct !== null ? round2(change.pct * 100) : null,
          includes_contributions: true,
          note: "Change in portfolio value. Includes money added or withdrawn during the range, so it is not investment return on its own.",
        }
      : { available: false, note: "Not enough price history to cover that range yet." };
  }

  return result;
}

// Writes straight to goal_contributions, the same table and same trust level
// the web Goal editor's own "Log a contribution" button already uses --
// there is no review queue for this table today (unlike an expense/income,
// it never touches an account balance or the ledger, so a mistake here is
// cheap to fix: delete the row and re-log). Same "must resolve to exactly
// one" bar as account/category/holding matching elsewhere in this file.
async function toolLogGoalContribution(householdId: string, args: Record<string, unknown>) {
  const { data: goals } = await supabase.from("goals").select("id, name").eq("household_id", householdId);
  const norm = String(args.goal_name ?? "").trim().toLowerCase();
  const matches = (goals ?? []).filter((g: { name: string }) => g.name.toLowerCase().includes(norm));
  if (matches.length === 0) return { error: "goal_not_found", available: (goals ?? []).map((g: { name: string }) => g.name) };
  if (matches.length > 1) return { error: "ambiguous_goal", matches: matches.map((g: { name: string }) => g.name) };

  const amount = Number(args.amount);
  if (!amount || amount <= 0) return { error: "invalid_amount" };
  const occurredAt = typeof args.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.occurred_at) ? args.occurred_at : householdToday();

  const goal = matches[0] as { id: string; name: string };
  const { error } = await supabase.from("goal_contributions").insert({ goal_id: goal.id, amount, occurred_at: occurredAt });
  if (error) return { error: "write_failed" };
  return { goal: goal.name, amount_aed: round2(amount), occurred_at: occurredAt };
}

// ---------------------------------------------------------------------------
// /brief digest -- deterministic, template-built from the same real tools
// above rather than another LLM call: cheaper, and there's no room for a
// phrasing pass to drift from the actual numbers on something meant to be
// glanced at daily. Household-wide (scope=null) rather than "me", since the
// point is a shared status check, not a personal one.
// ---------------------------------------------------------------------------

const BRIEF_TRIGGERS = new Set(["brief", "/brief", "digest", "/digest", "summary", "daily brief"]);

// Total spend for a given month across every category combined -- the tools
// above only ever total one category at a time, so this reuses the same
// scope/posted-only rules by hand rather than looping every category through
// monthActualsByCategory. Takes an explicit year/month (rather than always
// "now") so the month-end review can total the month that just ended, not
// whatever month it happens to be when the check runs.
async function toolGetMonthSpendTotalFor(householdId: string, year: number, month: number, scopeMemberId: string | null): Promise<number> {
  const { data: transactions } = await supabase
    .from("transactions")
    .select("amount, kind, occurred_at, is_shared, owner_member_id")
    .eq("household_id", householdId);
  const now = new Date();
  let total = 0;
  for (const t of (transactions ?? []) as Array<{ amount: number; kind: string; occurred_at: string; is_shared: boolean; owner_member_id: string | null }>) {
    const d = parseDay(t.occurred_at);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
    if (!(scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId)) continue;
    if (!isPosted(t, now)) continue;
    const v = scopedValue(t.amount, t, scopeMemberId);
    if (!isSpendRow(t, v)) continue;
    total += spendDelta(t, v);
  }
  return round2(total);
}

async function toolGetMonthSpendTotal(householdId: string, scopeMemberId: string | null): Promise<number> {
  const { year, month } = householdYearMonth(new Date());
  return toolGetMonthSpendTotalFor(householdId, year, month, scopeMemberId);
}

// Every category with a budget set this month that's at or over 90% used --
// the same threshold the frontend budget bars treat as "watch this".
async function toolGetBudgetAlerts(householdId: string, scopeMemberId: string | null): Promise<Array<{ category: string; pct: number }>> {
  const now = new Date();
  const { year, month } = householdYearMonth(now);
  const [{ data: budgetRows }, { data: categories }, { data: transactions }] = await Promise.all([
    supabase.from("budgets").select("category_id, amount").eq("household_id", householdId).eq("year", year).eq("month", month),
    supabase.from("categories").select("id, name").eq("household_id", householdId),
    supabase.from("transactions").select("amount, kind, occurred_at, category_id, is_shared, owner_member_id").eq("household_id", householdId),
  ]);
  const actualsMap = monthActualsByCategory((transactions ?? []) as never, year, month, scopeMemberId, now);
  const alerts: Array<{ category: string; pct: number }> = [];
  for (const b of (budgetRows ?? []) as Array<{ category_id: string; amount: number }>) {
    const budgeted = Number(b.amount);
    if (budgeted <= 0) continue;
    const cat = (categories ?? []).find((c: { id: string; name: string }) => c.id === b.category_id);
    if (!cat) continue;
    const actual = actualsMap.get(b.category_id) ?? 0;
    const pct = round2((actual / budgeted) * 100);
    if (pct >= 90) alerts.push({ category: cat.name, pct });
  }
  return alerts.sort((a, b) => b.pct - a.pct);
}

async function buildBriefMessage(householdId: string): Promise<string> {
  const [netWorth, monthSpend, bills, budgetAlerts, cashCover, pendingResult] = await Promise.all([
    toolGetNetWorth(householdId, null),
    toolGetMonthSpendTotal(householdId, null),
    toolGetUpcomingBills(householdId, null),
    toolGetBudgetAlerts(householdId, null),
    toolGetCashCover(householdId),
    supabase.from("intake").select("id", { count: "exact", head: true }).eq("household_id", householdId).eq("status", "pending"),
  ]);

  const lines: string[] = [];
  // The incompleteness rides on the same line as the figure it qualifies --
  // a separate footnote at the bottom of a digest is a footnote nobody reads
  // (QA #4).
  lines.push(
    `Net worth: AED ${netWorth.net_worth_aed.toLocaleString()}${netWorth.incomplete ? ` (${netWorth.incomplete})` : ""}`
  );
  lines.push(`Spent this month: AED ${monthSpend.toLocaleString()}`);

  const billLines = [
    ...bills.recurring.map((r: { name: string; amount_aed: number; due_date: string }) => `${r.name} AED ${r.amount_aed} (${r.due_date})`),
    ...bills.credit_cards.map((c: { name: string; amount_owed_aed: number | null; amount_owed?: number; currency?: string; due_date: string }) =>
      c.amount_owed_aed === null
        ? `${c.name} ${c.currency} ${c.amount_owed} not converted (${c.due_date})`
        : `${c.name} AED ${c.amount_owed_aed} (${c.due_date})`
    ),
  ];
  lines.push(billLines.length ? `Due in 14 days: ${billLines.join(", ")}` : "Nothing due in the next 14 days.");

  if (budgetAlerts.length) {
    lines.push(`Budget watch: ${budgetAlerts.map((a) => `${a.category} ${a.pct}%`).join(", ")}`);
  }

  lines.push(formatCashCoverLine(cashCover));

  const pendingCount = pendingResult.count ?? 0;
  lines.push(pendingCount ? `Inbox: ${pendingCount} item${pendingCount === 1 ? "" : "s"} to review.` : "Inbox is clear.");

  return lines.join("\n");
}

// Fires once, right after a month closes (see runMonthlyBriefCheck), summing
// up the month that just ended rather than "this month" -- by the time this
// runs, householdYearMonth(now) already names the new month.
async function buildMonthlyReviewMessage(householdId: string, year: number, month: number): Promise<string> {
  const [netWorth, monthSpend, cashCover] = await Promise.all([
    toolGetNetWorth(householdId, null),
    toolGetMonthSpendTotalFor(householdId, year, month, null),
    toolGetCashCover(householdId),
  ]);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const lines: string[] = [
    `${monthLabel} in review:`,
    `Spent: AED ${monthSpend.toLocaleString()}`,
    `Net worth now: AED ${netWorth.net_worth_aed.toLocaleString()}${netWorth.incomplete ? ` (${netWorth.incomplete})` : ""}`,
    formatCashCoverLine(cashCover),
  ];
  return lines.join("\n");
}

async function classifyAndRoute(
  rawText: string,
  categoryNames: string[],
  recentPending: { raw_text: string | null; created_at: string } | null,
  priorContext: { question: string; answer: string } | null,
  householdId: string | null = null,
  memberId: string | null = null
) {
  const system =
    `You are a household finance assistant for Rokda, chatting with a household member via Telegram. ` +
    `If their message reports a real expense/income/refund that already happened (e.g. "spent 40 on lunch", "paid the rent", "got paid my salary", "got a refund from Noon"), ALWAYS call log_expense immediately -- even if the category, merchant, or exact amount isn't fully clear. log_expense covers all three: the extraction step itself decides which one from the wording, you don't need to. ` +
    `EXCEPTION: if the message specifically says money is going toward a named savings or debt-payoff GOAL (e.g. "put 500 toward emergency fund", "added 1000 to the house downpayment goal"), call log_goal_contribution instead -- never log_expense for that message, since a goal contribution never touches an account balance or the ledger. An ordinary purchase or bill with no named goal is still log_expense. ` +
    `Never ask a clarifying question about an expense to log: category assignment happens later when a human reviews it, not in this chat, and an uncategorised expense is a completely normal, expected outcome -- do not treat that as ambiguity. ` +
    `Only treat a message as ambiguous, and only then reply in plain text with a short clarifying question instead of calling a tool, when it is a QUESTION whose target is genuinely unclear (e.g. asking about an account name that matches nothing, or a category that doesn't fit any real one) -- never for something being logged. ` +
    `If it asks a real question about their finances, call the matching tool to fetch the real number -- you must NEVER answer from your own knowledge or guess a figure; only a tool result is a real number. ` +
    `Known expense categories (for question tools only, not required for logging): ${JSON.stringify(categoryNames)}.` +
    (recentPending
      ? ` The member's most recently sent entry, still pending review, was: "${recentPending.raw_text}" (sent ${recentPending.created_at}). If and only if this new message is explicitly correcting/amending that same entry, call update_last_expense. A genuinely new, separate expense -- even one sent moments later -- should still call log_expense.`
      : "") +
    (priorContext
      ? ` A short-lived note: the member's previous question was "${priorContext.question}" and the real answer given was "${priorContext.answer}". If this new message is a brief follow-up to that (e.g. "compare that to last month", "what about groceries instead"), use it to fill in what's being asked -- but still only via a fresh tool call; never state a number from the previous answer directly. If this message is unrelated, ignore that note entirely.`
      : "");

  const messages: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  // The prior exchange is offered as real conversation turns (not just
  // described in the system prompt) so the model can naturally resolve a
  // pronoun or an implicit "instead of X" against it.
  if (priorContext) {
    messages.push({ role: "user", content: priorContext.question });
    messages.push({ role: "assistant", content: priorContext.answer });
  }
  messages.push({ role: "user", content: rawText });

  const startedAt = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: PARSE_MODEL,
        messages,
        tools: buildTools(recentPending !== null),
        tool_choice: "auto",
      }),
    });
    if (!res.ok) {
      await logTelegramCall({
        callKind: "classify_and_route",
        householdId,
        memberId,
        model: PARSE_MODEL,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorType: `http_${res.status}`,
      });
      return null;
    }
    const body = await res.json();
    await logTelegramCall({
      callKind: "classify_and_route",
      householdId,
      memberId,
      model: PARSE_MODEL,
      latencyMs: Date.now() - startedAt,
      success: true,
      usage: body?.usage,
    });
    return body;
  } catch (err) {
    // Logged, then re-thrown unchanged -- this function's own callers already
    // wrap it in a try/catch and must keep seeing an exception, not a value.
    await logTelegramCall({
      callKind: "classify_and_route",
      householdId,
      memberId,
      model: PARSE_MODEL,
      latencyMs: Date.now() - startedAt,
      success: false,
      errorType: "exception",
    });
    throw err;
  }
}

async function phraseAnswer(
  question: string,
  toolResult: unknown,
  householdId: string | null = null,
  memberId: string | null = null
): Promise<string | null> {
  const system =
    `Answer the user's question in one or two short sentences using ONLY the JSON data given below -- never state a number that isn't in it. ` +
    `If the data has an "error" field, explain the problem plainly (e.g. list what's in "available") and ask them to rephrase -- do not guess which one they meant. ` +
    `Amounts are AED unless the data says otherwise. Be direct and brief, like a text message, no markdown.`;
  const startedAt = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: PARSE_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Question: ${question}\nData: ${JSON.stringify(toolResult)}` },
        ],
      }),
    });
    if (!res.ok) {
      await logTelegramCall({
        callKind: "phrase_answer",
        householdId,
        memberId,
        model: PARSE_MODEL,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorType: `http_${res.status}`,
      });
      return null;
    }
    const body = await res.json();
    await logTelegramCall({
      callKind: "phrase_answer",
      householdId,
      memberId,
      model: PARSE_MODEL,
      latencyMs: Date.now() - startedAt,
      success: true,
      usage: body?.usage,
    });
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : null;
  } catch {
    await logTelegramCall({
      callKind: "phrase_answer",
      householdId,
      memberId,
      model: PARSE_MODEL,
      latencyMs: Date.now() - startedAt,
      success: false,
      errorType: "exception",
    });
    return null;
  }
}

// Runs once a day via pg_cron (see the ?run_recurring_check=1 handler below)
// across ALL households: an active recurring item whose due date passed a
// few days ago with nothing resembling it in `transactions` gets a one-time
// nudge to the member(s) it belongs to. recurring_nudges records that a
// nudge was already sent for a (recurring row, due date) pair so the same
// missed bill is never re-nagged on the next day's check.
async function runRecurringCheck(): Promise<{ checked: number; nudged: number }> {
  const today = new Date();
  const graceStart = new Date(today);
  graceStart.setDate(graceStart.getDate() - 10); // don't look back further than 10 days overdue
  const graceEnd = new Date(today);
  graceEnd.setDate(graceEnd.getDate() - 3); // give a few days of normal processing time before nudging
  const graceStartStr = graceStart.toISOString().slice(0, 10);
  const graceEndStr = graceEnd.toISOString().slice(0, 10);

  const [{ data: activeRows }, prefs] = await Promise.all([
    supabase
      .from("recurring")
      .select("id, household_id, name, owner_member_id, is_shared, amount, next_due_date, cadence, interval_count, account_id, category_id")
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
      cadence: string;
      interval_count: number;
      account_id: string | null;
      category_id: string | null;
    }>
  )
    .map((r) => {
      const due = lastDueOccurrence(r.next_due_date, r.cadence, today, r.interval_count);
      return due ? { ...r, dueDate: due.toISOString().slice(0, 10) } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null && r.dueDate >= graceStartStr && r.dueDate <= graceEndStr);

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
      const windowStart = new Date(r.dueDate);
      windowStart.setDate(windowStart.getDate() - 5);
      const windowEnd = new Date(r.dueDate);
      windowEnd.setDate(windowEnd.getDate() + 5);
      let nearbyQuery = supabase
        .from("transactions")
        .select("id, amount, account_id, category_id")
        .eq("household_id", r.household_id)
        .gte("occurred_at", windowStart.toISOString().slice(0, 10))
        .lte("occurred_at", windowEnd.toISOString().slice(0, 10));
      if (r.account_id) nearbyQuery = nearbyQuery.eq("account_id", r.account_id);
      if (r.category_id) nearbyQuery = nearbyQuery.eq("category_id", r.category_id);
      const { data: nearby } = await nearbyQuery;
      const amount = Math.abs(Number(r.amount));
      const matched = (nearby ?? []).some((t: { amount: number }) => Math.abs(Math.abs(Number(t.amount)) - amount) <= amount * 0.2);
      if (matched) continue;

      const { data: members } = await supabase
        .from("household_members")
        .select("id, telegram_user_id")
        .eq("household_id", r.household_id);
      const recipients = (
        r.is_shared
          ? (members ?? [])
          : (members ?? []).filter((m: { id: string }) => m.id === r.owner_member_id)
      ).filter((m: { telegram_user_id: number | null }) => m.telegram_user_id != null) as Array<{ telegram_user_id: number }>;

      for (const m of recipients) {
        await reply(
          m.telegram_user_id,
          `I don't see a transaction for "${r.name}" yet (usually around AED ${amount.toFixed(2)}, due ${r.dueDate}) -- forgot to log it, or paid another way?`
        );
      }
      await supabase.from("recurring_nudges").insert({ recurring_id: r.id, due_date: r.dueDate });
      nudged++;
    } catch {
      // One recurring row's nudge failing must never block the rest.
    }
  }
  return { checked: dueRows.length, nudged };
}

// Runs alongside runRecurringCheck (see the ?run_recurring_check=1 handler
// below) across every credit-card account with a due day set: a reminder
// 1-2 days before (or on) the due date, and, if the balance still shows
// owing a few days after, an "did you pay this?" nudge. There is no "marked
// as paid" concept anywhere in this app -- a card's balance is simply
// updated (manually, or by import) when it changes -- so "overdue" here is
// the same proxy get_upcoming_bills already uses: balance still positive
// past the due date. credit_card_nudges dedupes per (account, due date,
// kind) so the same due date is never re-nagged on the next day's check.
async function runCreditCardCheck(): Promise<{ checked: number; nudged: number }> {
  const today = new Date();
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
      for (const m of recipients) await reply(m.telegram_user_id, message);

      await supabase.from("credit_card_nudges").insert({ account_id: a.id, due_date: dueDateStr, kind });
      nudged++;
    } catch {
      // One card's nudge failing must never block the rest.
    }
  }
  return { checked: (cards ?? []).length, nudged };
}

const BUDGET_THRESHOLDS = [100, 90, 80];

// Runs alongside runRecurringCheck (see the ?run_recurring_check=1 handler
// below), household-wide (budgets are set at the household level, not per
// member) for every category with a budget set this month: alerts the
// household once a threshold (80/90/100% used) is newly crossed.
// budget_alert_nudges dedupes per (household, category, month, threshold)
// -- a threshold already alerted isn't repeated, but a later, higher
// threshold crossed the same month still gets its own alert.
async function runBudgetAlertCheck(): Promise<{ checked: number; nudged: number }> {
  const now = new Date();
  const { year, month } = householdYearMonth(now);

  const { data: budgetRows } = await supabase
    .from("budgets")
    .select("household_id, category_id, amount")
    .eq("year", year)
    .eq("month", month)
    .eq("alerts_enabled", true)
    .gt("amount", 0);

  let nudged = 0;
  for (const b of (budgetRows ?? []) as Array<{ household_id: string; category_id: string; amount: number }>) {
    try {
      const { data: category } = await supabase.from("categories").select("name").eq("id", b.category_id).maybeSingle();
      if (!category) continue;

      const { data: transactions } = await supabase
        .from("transactions")
        .select("amount, kind, occurred_at, category_id, is_shared, owner_member_id")
        .eq("household_id", b.household_id)
        .eq("category_id", b.category_id);
      const actual = monthActualsByCategory((transactions ?? []) as never, year, month, null, now).get(b.category_id) ?? 0;
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
        for (const m of recipients) await reply(m.telegram_user_id, message);

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

// Every household with at least one member who has ever linked Telegram --
// the target list for the checks below, same as how the nudge checks above
// find who to notify, just at the household level instead of per-item.
async function householdsWithLinkedTelegram(): Promise<string[]> {
  const { data } = await supabase.from("household_members").select("household_id").not("telegram_user_id", "is", null);
  return [...new Set((data ?? []).map((m: { household_id: string }) => m.household_id))];
}

async function telegramRecipients(householdId: string): Promise<number[]> {
  const { data } = await supabase.from("household_members").select("telegram_user_id").eq("household_id", householdId).not("telegram_user_id", "is", null);
  return (data ?? []).map((m: { telegram_user_id: number }) => m.telegram_user_id);
}

type TelegramPrefRow = {
  household_id: string;
  recurring_enabled: boolean;
  credit_card_enabled: boolean;
  cash_cover_enabled: boolean;
  brief_enabled: boolean;
  unusual_spend_enabled: boolean;
};
type TelegramPrefKey = "recurring_enabled" | "credit_card_enabled" | "cash_cover_enabled" | "brief_enabled" | "unusual_spend_enabled";

// Fetched once per check run (the table has one row per household, so this
// is cheap) rather than once per item/household inside a loop.
async function telegramPrefsMap(): Promise<Map<string, TelegramPrefRow>> {
  const { data } = await supabase.from("telegram_notification_prefs").select("*");
  const map = new Map<string, TelegramPrefRow>();
  for (const row of (data ?? []) as TelegramPrefRow[]) map.set(row.household_id, row);
  return map;
}

// No row for a household means every signal is on -- see this table's own
// migration comment for why (additive: nothing changes for a household that
// never visits the new Telegram settings tab).
function prefEnabled(prefs: Map<string, TelegramPrefRow>, householdId: string, key: TelegramPrefKey): boolean {
  return prefs.get(householdId)?.[key] ?? true;
}

// The Monday of the week a given calendar day falls in, as the same
// 'YYYY-MM-DD' shape used everywhere else in this file -- the dedupe key for
// the weekly brief and the cash-cover nudge, so either firing twice in the
// same week (a cron retry, a slow first run) is a no-op the second time.
function mondayOfWeek(dateStr: string): string {
  const d = parseDay(dateStr);
  const day = d.getDay(); // 0 = Sunday .. 6 = Saturday
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

// Runs daily alongside the other checks (see the ?run_recurring_check=1
// handler below) but only actually sends on a Monday -- the brief itself is
// weekly, the check for whether to send it doesn't need its own schedule.
// brief_sends dedupes per (household, 'weekly', that Monday's date) so a
// retry the same day is a no-op.
async function runWeeklyBriefCheck(): Promise<{ sent: number }> {
  const today = householdToday();
  if (parseDay(today).getDay() !== 1) return { sent: 0 };

  let sent = 0;
  const prefs = await telegramPrefsMap();
  for (const householdId of await householdsWithLinkedTelegram()) {
    if (!prefEnabled(prefs, householdId, "brief_enabled")) continue;
    try {
      const periodKey = mondayOfWeek(today);
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
      for (const chatId of recipients) await reply(chatId, `This week:\n${brief}`);
      await supabase.from("brief_sends").insert({ household_id: householdId, kind: "weekly", period_key: periodKey });
      sent++;
    } catch {
      // One household's brief failing must never block the rest.
    }
  }
  return { sent };
}

// Same pattern as the weekly check, but fires on the 1st of the month and
// summarises the month that just ended (see buildMonthlyReviewMessage) --
// by the time this runs, "this month" already names the new one.
async function runMonthlyBriefCheck(): Promise<{ sent: number }> {
  const today = householdToday();
  if (parseDay(today).getDate() !== 1) return { sent: 0 };

  // today is already a resolved 'YYYY-MM-DD' calendar day (see day.js) --
  // read year/month straight out of it rather than round-tripping back
  // through a Date and a second timezone-aware format.
  const [yearStr, monthStr] = today.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const periodKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

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
      for (const chatId of recipients) await reply(chatId, review);
      await supabase.from("brief_sends").insert({ household_id: householdId, kind: "monthly", period_key: periodKey });
      sent++;
    } catch {
      // One household's review failing must never block the rest.
    }
  }
  return { sent };
}

// Runs daily (unlike the weekly/monthly briefs above) since a shortfall is
// urgent, not a status update -- but only actually nudges once per week
// while it persists. cash_cover_nudges dedupes per (household, that week's
// Monday) so a household that's short all week hears about it once, not
// every morning; if the shortfall clears and later reopens the same week,
// it still stays quiet until the following Monday -- same tradeoff the
// budget-threshold nudge makes for a threshold that stays crossed.
async function runCashCoverCheck(): Promise<{ checked: number; nudged: number }> {
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
      for (const chatId of recipients) await reply(chatId, message);
      await supabase.from("cash_cover_nudges").insert({ household_id: householdId, period_key: periodKey });
      nudged++;
    } catch {
      // One household's cash-cover check failing must never block the rest.
    }
  }
  return { checked: households.length, nudged };
}

// A far more conservative bar than the web Insights screen's own
// "notable move" default (20% off average + AED 50) -- that screen is
// something a member glances at, this is a push notification, and a
// too-sensitive nudge trains the household to ignore it, which defeats
// the point (SHR-283). minPct: 2 means the category has to be running at
// least 3x its trailing average (avg + 2*avg); minAbsolute keeps a
// low-average category (a few AED) from being flagged by a single
// otherwise-ordinary purchase.
const UNUSUAL_SPEND_MIN_PCT = 2;
const UNUSUAL_SPEND_MIN_ABSOLUTE = 300;

// Runs daily alongside the other checks. Reuses the same trailing-average
// math the web Insights screen shows informationally (notableMoves), just
// with the much stricter bar above. unusual_spend_nudges dedupes per
// (household, category, month) -- flagged once, not re-nagged every day
// even if the category keeps climbing further past the bar.
async function runUnusualSpendCheck(): Promise<{ checked: number; nudged: number }> {
  const now = new Date();
  const { year, month } = householdYearMonth(now);
  const households = await householdsWithLinkedTelegram();
  const prefs = await telegramPrefsMap();

  let nudged = 0;
  for (const householdId of households) {
    if (!prefEnabled(prefs, householdId, "unusual_spend_enabled")) continue;
    try {
      const [{ data: transactions }, { data: categories }] = await Promise.all([
        supabase.from("transactions").select("amount, kind, occurred_at, category_id, is_shared, owner_member_id").eq("household_id", householdId),
        supabase.from("categories").select("id, name").eq("household_id", householdId),
      ]);
      const catById = new Map((categories ?? []).map((c: { id: string; name: string }) => [c.id, c]));

      const moves = notableMoves((transactions ?? []) as never, year, month, null, catById, now, {
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
        for (const chatId of recipients) await reply(chatId, message);

        await supabase.from("unusual_spend_nudges").insert({ household_id: householdId, category_id: move.categoryId, year, month });
        nudged++;
      }
    } catch {
      // One household's unusual-spend check failing must never block the rest.
    }
  }
  return { checked: households.length, nudged };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Every route this function serves -- a real Telegram update, the
  // one-time ?setup=1, and the daily ?run_recurring_check=1 pg_cron call --
  // requires this same shared secret, checked before anything else (before
  // parsing the body, before looking at any query param). Without this,
  // JWT verification being off (required, since Telegram calls this, not a
  // signed-in user) meant NOTHING verified a request actually came from
  // Telegram: an arbitrary POST claiming any from.id/chat.id would be
  // trusted as that household member, and the two GET routes were public
  // with no check at all. Telegram itself sends this back as
  // X-Telegram-Bot-Api-Secret-Token once registered via setWebhook's
  // secret_token (see the ?setup=1 handler below); the cron job sends the
  // same value as a header (see the recurring_check_cron migration).
  const expectedSecret = await getTelegramWebhookSecret();
  if (!expectedSecret || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  // One-time setup: registers this function's own URL as the bot's webhook,
  // including the secret_token so Telegram starts sending it back on every
  // future call. Meant to be hit once by whoever deploys this (with the
  // header already set to the same secret -- this route needs it too, same
  // as every other), not by Telegram itself.
  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    const result = await tgCall("setWebhook", {
      url: `${SUPABASE_URL}/functions/v1/telegram-webhook`,
      allowed_updates: ["message", "message_reaction"],
      secret_token: expectedSecret,
    });
    // getMe reports can_join_groups and can_read_all_group_messages, which are
    // BotFather settings with no API to set them and no other way to see them.
    // The handler refuses non-private chats regardless, so this is not the
    // control -- it is how whoever deploys this can check that the bot is also
    // not being invited into groups in the first place.
    const me = (await tgCall("getMe", {})) as { result?: { can_join_groups?: boolean; can_read_all_group_messages?: boolean } };
    return new Response(
      JSON.stringify({
        set_webhook: result,
        bot: me?.result ?? null,
        note: "can_join_groups should be false (BotFather -> /setjoingroups -> Disable). Financial replies are refused outside private chats either way.",
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // Daily proactive-reminder check, triggered by pg_cron. Covers six
  // independent things in one run: missed recurring bills, credit-card due
  // dates, budget thresholds, a weekly brief (Mondays only), a month-end
  // review (1st of the month only) and a cash-cover warning -- kept under
  // the same query param the existing pg_cron job already calls, rather
  // than adding new jobs for each. The weekly/monthly checks no-op on every
  // day but their own, so running them daily costs nothing.
  if (req.method === "GET" && url.searchParams.get("run_recurring_check") === "1") {
    const [recurring, creditCards, budgets, weeklyBrief, monthlyBrief, cashCover, unusualSpend] = await Promise.all([
      runRecurringCheck(),
      runCreditCardCheck(),
      runBudgetAlertCheck(),
      runWeeklyBriefCheck(),
      runMonthlyBriefCheck(),
      runCashCoverCheck(),
      runUnusualSpendCheck(),
    ]);
    // Housekeeping, not a check: nothing reports on it and nothing depends on
    // it having run today.
    await pruneTelegramUpdateLog();
    return new Response(
      JSON.stringify({
        recurring,
        credit_cards: creditCards,
        budgets,
        weekly_brief: weeklyBrief,
        monthly_brief: monthlyBrief,
        cash_cover: cashCover,
        unusual_spend: unusualSpend,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  // Before ANY side effect, and before the message/reaction split so both
  // routes are covered: a redelivered update is dropped here (QA #2).
  if (await alreadyHandled(update?.update_id)) return new Response("ok");

  const message = update?.message as Record<string, unknown> | undefined;
  if (!message) {
    const reaction = update?.message_reaction as Record<string, unknown> | undefined;
    if (reaction) return await handleReaction(reaction);
    return new Response("ok");
  }

  const chat = message.chat as Record<string, unknown> | undefined;
  const from = message.from as Record<string, unknown> | undefined;
  const chatId = chat?.id as number | undefined;
  const fromId = from?.id as number | undefined;
  const updateId = update.update_id;
  if (!chatId || !fromId) return new Response("ok");

  // Before the member lookup, so a group conversation never reaches anything
  // that reads or writes household data (see isPrivateChat). A command gets a
  // one-line answer so the sender knows why nothing happened; anything else is
  // ignored, because answering every message in a group is its own problem.
  if (!isPrivateChat(chat)) {
    const groupText = typeof message.text === "string" ? message.text.trim() : "";
    if (groupText.startsWith("/")) {
      await reply(chatId, "I only work in a direct message — open a private chat with me and try again there.");
    }
    return new Response("ok");
  }

  const { data: member } = await supabase
    .from("household_members")
    .select("id, household_id, display_name, telegram_last_question, telegram_last_answer, telegram_last_context_at")
    .eq("telegram_user_id", fromId)
    .maybeSingle();

  if (!member) {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    // A Telegram deep link (https://t.me/<bot>?start=<token>) arrives as
    // "/start <token>". The token is short enough to be a deep-link payload,
    // so accepting both shapes costs one line and means a link in Settings
    // would work without touching this again.
    const candidate = linkTokenFromMessage(text);

    if (candidate) {
      // Only token-shaped text is a guess, and only a guess is throttled or
      // counted. Ordinary chatter from somebody who has not generated a token
      // yet is answered with the instructions below and costs them nothing.
      const isGuess = looksLikeLinkToken(candidate);

      if (isGuess) {
        const blocked = await linkAttemptBlocked(fromId);
        if (blocked) {
          await reply(chatId, blocked);
          return new Response("ok");
        }
      }

      const { data: pending } = await supabase
        .from("household_members")
        .select("id, display_name")
        .eq("telegram_link_code", candidate)
        .gt("telegram_link_code_expires_at", new Date().toISOString())
        .maybeSingle();

      if (pending) {
        // Uses the service-role client, which the guard trigger on
        // household_members explicitly exempts (see the telegram_linking
        // migration) -- this is the one path allowed to set telegram_user_id.
        //
        // The code-qualified WHERE makes two simultaneous redemptions of one
        // token safe: only one can match. It did not make the LOSER honest --
        // the loser's update matched zero rows and was told "Linked" anyway,
        // because nothing read the result (QA #8). Selecting back the affected
        // row is what tells the two apart.
        const { data: linked } = await supabase
          .from("household_members")
          .update({ telegram_user_id: fromId, telegram_link_code: null, telegram_link_code_expires_at: null })
          .eq("id", pending.id)
          .eq("telegram_link_code", candidate)
          .select("id")
          .maybeSingle();

        if (linked) {
          await clearLinkFailures(fromId);
          await reply(
            chatId,
            `Linked as ${pending.display_name}. Send a receipt photo, a message like "42 aed carrefour groceries", or ask a question like "what's our net worth?" any time.`
          );
          return new Response("ok");
        }

        // The token was valid a moment ago and is not now: someone else
        // redeemed it, or it expired between the two statements. Saying so
        // beats claiming a link that does not exist.
        if (isGuess) await recordLinkFailure(fromId);
        await reply(chatId, "That code was just used or has expired. Generate a fresh one in Settings → Household.");
        return new Response("ok");
      }

      if (isGuess) await recordLinkFailure(fromId);
    }
    await reply(chatId, "This Telegram account isn't linked to a Rokda household yet. Generate a code in Settings → Household and send it to me.");
    return new Response("ok");
  }

  // Linked member from here on.
  const rawText = (typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : null);
  let photoPath: string | null = null;
  let photoBase64: string | null = null;
  let photoMime: string | null = null;

  const photos = message.photo as Array<{ file_id: string }> | undefined;
  const doc = message.document as { file_id: string } | undefined;
  const fileId = photos?.length ? photos[photos.length - 1].file_id : doc?.file_id;

  // "/brief" (and a few aliases) short-circuits straight to a template
  // digest -- no LLM call, so it's free, and it's checked before anything
  // else touches `intake` since it's never a question about a specific
  // entry.
  if (rawText && !fileId && BRIEF_TRIGGERS.has(rawText.trim().toLowerCase())) {
    const brief = await buildBriefMessage(member.household_id);
    await reply(chatId, brief);
    return new Response("ok");
  }

  // A recent, still-pending entry from this member -- checked below both as
  // a fast-confirm target (an exact "yes" reply) and, further down, offered
  // to the classifier as something a new message might be correcting rather
  // than a separate expense. 20 minutes: long enough to catch "wait,
  // actually ..." (or a delayed "yes") a moment later, short enough that
  // it's clearly the same exchange rather than a much later, unrelated
  // message.
  let recentPending: PendingIntakeRow | null = null;

  // Resolved once and shared by the confirmation and correction paths below,
  // because they have the SAME targeting problem. The correction path used to
  // take `recentRows.find(status === "pending")` -- the newest pending entry,
  // whatever the member had actually replied to -- so replying to A with
  // "actually 42" amended B.
  let promptLookup: PromptLookup = { kind: PROMPT_UNADDRESSED, row: null };
  let candidates: { rows: PendingIntakeRow[]; truncated: boolean } = { rows: [], truncated: false };

  if (rawText && !fileId) {
    const repliedTo = (message.reply_to_message as { message_id?: number } | undefined)?.message_id ?? null;
    [promptLookup, candidates] = await Promise.all([
      intakeForPrompt(member.household_id, member.id, chatId, repliedTo),
      confirmCandidates(member.household_id, member.id),
    ]);

    // What a correction would amend, decided by the same rules as a
    // confirmation: an addressed message amends what it names or nothing.
    const correction = resolveCorrectionTarget({
      lookup: promptLookup.kind,
      row: promptLookup.row,
      recent: candidates.rows,
      truncated: candidates.truncated,
    });
    recentPending = correction.kind === "one" ? correction.row : null;

    // A bare "yes" (or a typed 👍/✅ -- a long-press reaction on any message
    // is handled separately, see handleReaction) confirming a pending entry
    // that's already fully resolved -- account, category, currency, date,
    // all matched with high confidence -- records it immediately via the
    // same approve_intake RPC the Inbox itself calls when a human clicks
    // approve there. This still requires the member to explicitly confirm --
    // it skips the Inbox screen, never the confirmation itself. No LLM call
    // at all, so this costs nothing beyond a couple of small DB reads.
    //
    // WHICH entry it confirms comes from resolveConfirmTarget, not from
    // recency: a "yes" sent as a Telegram reply names its prompt, and an
    // unaddressed "yes" with several entries waiting is answered with a
    // question rather than a guess (QA #2).
    const trimmedText = rawText.trim();
    if (isConfirmationText(trimmedText)) {
      const target = resolveConfirmTarget({
        lookup: promptLookup.kind,
        row: promptLookup.row,
        recent: candidates.rows,
        truncated: candidates.truncated,
      });
      if (target.kind === "one") {
        await confirmPendingIntake(chatId, member.household_id, target.row);
        return new Response("ok");
      }
      if (target.kind === "ambiguous") {
        await reply(chatId, ambiguousConfirmMessage(target.rows));
        return new Response("ok");
      }
      // Addressed at a message that is not a prompt we hold -- most likely a
      // superseded one. Say so rather than falling through to a guess.
      if (target.kind === "unknown") {
        await reply(chatId, unknownPromptMessage());
        return new Response("ok");
      }
      if (target.kind === "unavailable") {
        await reply(chatId, lookupUnavailableMessage());
        return new Response("ok");
      }
      // kind === "none": nothing confirmable is waiting, so this "yes" is not
      // a confirmation at all. Fall through and let it be treated as ordinary
      // text, exactly as before.
    }
  }

  // SHR-240: a plain text message (no photo/document) might be a question
  // rather than something to log -- route it before ever touching `intake`.
  // A photo is presumptively a receipt, so this never runs for one.
  if (rawText && !fileId && OPENROUTER_API_KEY) {
    try {
      const { data: categories } = await supabase
        .from("categories")
        .select("id, name")
        .eq("household_id", member.household_id)
        .eq("kind", "expense")
        .eq("archived", false);

      // A short follow-up ("compare that to last month") only makes sense
      // in light of the previous exchange, and only when it was recent --
      // a message ten minutes later is probably still the same
      // conversation, an hour later is almost certainly a fresh one.
      const priorContext =
        member.telegram_last_question &&
        member.telegram_last_answer &&
        member.telegram_last_context_at &&
        Date.now() - new Date(member.telegram_last_context_at).getTime() < PENDING_WINDOW_MS
          ? { question: member.telegram_last_question as string, answer: member.telegram_last_answer as string }
          : null;

      const routed = await classifyAndRoute(rawText, (categories ?? []).map((c) => c.name), recentPending, priorContext, member.household_id, member.id);
      const choice = routed?.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];

      if (toolCall?.function?.name === "update_last_expense" && recentPending) {
        const combinedText = `${recentPending.raw_text ?? ""}\nCorrection: ${rawText}`;
        // A correction targets the one existing pending row, so only the
        // first extracted item is used even if the model finds more --
        // multi-item corrections aren't supported, same as before.
        const parsed =
          (await parseIntakeWithAI({
            rawText: combinedText,
            imageBase64: null,
            imageMime: null,
            categoryNames: (categories ?? []).map((c) => c.name),
            householdId: member.household_id,
            memberId: member.id,
          }))?.[0] ?? null;
        const matchedCategory = parsed
          ? (await matchCategoryFromMerchantHistory(member.household_id, parsed.merchant)) ??
            (parsed.categoryName ? (categories ?? []).find((c) => c.name.toLowerCase() === parsed.categoryName!.toLowerCase()) ?? null : null)
          : null;
        const matchedAccount = parsed
          ? (await matchAccountByCardLast4(member.household_id, parsed.cardLast4)) ?? (await matchAccountByNameHint(member.household_id, parsed.accountHint))
          : null;
        const updatedRow = {
          parsed_merchant: parsed?.merchant ?? null,
          parsed_amount: parsed?.amount ?? null,
          parsed_date: parsed?.occurred_at ?? null,
          parsed_category_id: matchedCategory?.id ?? null,
          parsed_currency: parsed?.currency ?? null,
          parsed_account_id: matchedAccount?.id ?? null,
          parsed_kind: parsed?.kind ?? null,
          confidence: parsed?.confidence ?? 0,
        };
        await supabase
          .from("intake")
          .update({ raw_text: combinedText, ...updatedRow })
          .eq("id", recentPending.id)
          .eq("status", "pending");

        const correctionDuplicate = isReadyForFastConfirm(updatedRow)
          ? await findDuplicateTransaction(member.household_id, updatedRow.parsed_account_id, updatedRow.parsed_merchant, updatedRow.parsed_amount, updatedRow.parsed_date)
          : null;
        if (isReadyForFastConfirm(updatedRow) && !correctionDuplicate) {
          await sendFastConfirmPrompt(
            chatId,
            recentPending.id,
            `Updated — AED ${Number(updatedRow.parsed_amount).toFixed(2)} at ${updatedRow.parsed_merchant}. Everything matched, so reply "yes" to record it, or edit in the Inbox.`
          );
        } else {
          await reply(chatId, "Updated your last pending entry — check the Inbox.");
        }
        return new Response("ok");
      }

      if (toolCall && toolCall.function?.name !== "log_expense") {
        const args = JSON.parse(toolCall.function.arguments || "{}");
        const { data: members } = await supabase.from("household_members").select("id, display_name").eq("household_id", member.household_id);
        const scopeMemberId = resolveScopeMemberId(args.scope ?? "me", member, members ?? []);

        let result: unknown;
        switch (toolCall.function.name) {
          case "get_category_spend":
            result = await toolGetCategorySpend(member.household_id, scopeMemberId, args);
            break;
          case "get_net_worth":
            result = await toolGetNetWorth(member.household_id, scopeMemberId);
            break;
          case "get_account_balance":
            result = await toolGetAccountBalance(member.household_id, args);
            break;
          case "get_upcoming_bills":
            result = await toolGetUpcomingBills(member.household_id, scopeMemberId);
            break;
          case "get_budget_status":
            result = await toolGetBudgetStatus(member.household_id, scopeMemberId, args);
            break;
          case "get_holdings":
            result = await toolGetHoldings(member.household_id, scopeMemberId, args);
            break;
          case "log_goal_contribution":
            result = await toolLogGoalContribution(member.household_id, args);
            break;
          default:
            result = { error: "unknown_tool" };
        }

        const answer = await phraseAnswer(rawText, result, member.household_id, member.id);
        await reply(chatId, answer ?? "I found the data but couldn't phrase a reply — please try rephrasing.");
        if (answer) {
          // Remembered briefly so a short follow-up ("what about groceries
          // instead") can be resolved against it -- see priorContext above.
          // Best-effort and isolated: this must never fall through to the
          // catch below, which would otherwise treat the already-answered
          // question as an unrouted message and capture it into intake too.
          try {
            await supabase
              .from("household_members")
              .update({ telegram_last_question: rawText, telegram_last_answer: answer, telegram_last_context_at: new Date().toISOString() })
              .eq("id", member.id);
          } catch {
            // Not remembering this exchange is fine -- the reply already sent.
          }
        }
        return new Response("ok");
      }

      if (!toolCall && choice?.message?.content) {
        // No tool call: the model's own text is a clarifying question (or a
        // decline) -- never a financial answer, since only a tool call can
        // produce a real number.
        await reply(chatId, choice.message.content);
        return new Response("ok");
      }
      // toolCall.function.name === "log_expense", or routing produced
      // nothing usable: fall through to intake capture below.
    } catch {
      // Routing failed -- fall through to intake capture rather than
      // losing the message.
    }
  }

  if (fileId) {
    try {
      const fileInfo = await tgCall("getFile", { file_id: fileId });
      const filePath = fileInfo?.result?.file_path as string | undefined;
      if (filePath) {
        const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
        const bytes = new Uint8Array(await fileRes.arrayBuffer());
        const contentType = fileRes.headers.get("content-type") ?? "image/jpeg";
        const ext = filePath.split(".").pop() || "jpg";
        const storagePath = `${member.household_id}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("telegram-receipts")
          .upload(storagePath, bytes, { contentType });
        if (!uploadError) {
          photoPath = storagePath;
          // Only images go to the vision model -- a forwarded PDF or other
          // document still gets stored and reviewed, just without parsing.
          if (contentType.startsWith("image/") && bytes.length < 15_000_000) {
            photoBase64 = bytesToBase64(bytes);
            photoMime = contentType;
          }
        }
      }
    } catch {
      // Photo storage failed -- fall through with whatever text/caption exists.
    }
  }

  if (!rawText && !photoPath) return new Response("ok"); // nothing usable (a sticker, a reaction, ...)

  const { data: inserted, error: insertError } = await supabase
    .from("intake")
    .insert({
      household_id: member.household_id,
      member_id: member.id,
      source: "telegram",
      source_ref: String(updateId),
      raw_text: rawText,
      photo_path: photoPath,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code !== "23505") {
      // Anything other than 23505 (unique_violation on source_ref, meaning
      // Telegram redelivered an update already captured) is a real failure.
      await reply(chatId, "Something went wrong saving that — please try again.");
    }
    return new Response("ok");
  }

  // Parsing is a convenience layered on top of a capture that already
  // succeeded -- its failure must never surface as this message's failure.
  let fastConfirmSummary: string | null = null;
  const multiItemSummaries: string[] = [];
  try {
    const { data: categories } = await supabase
      .from("categories")
      .select("id, name")
      .eq("household_id", member.household_id)
      .eq("archived", false);

    const items = await parseIntakeWithAI({
      rawText,
      imageBase64: photoBase64,
      imageMime: photoMime,
      categoryNames: (categories ?? []).map((c) => c.name),
      householdId: member.household_id,
      memberId: member.id,
    });

    // A message can describe more than one expense ("bought two plants for
    // 260 and 50") -- the first item updates the row already inserted
    // above, and each additional item gets its OWN new intake row rather
    // than being summed or dropped, which is what used to happen when only
    // a single amount was ever extracted. Each item's own DB work is
    // wrapped separately so one item's failure (a bad category/account
    // lookup) never costs the others.
    for (let i = 0; i < (items?.length ?? 0); i++) {
      const item = items![i];
      try {
        const matchedCategory =
          (await matchCategoryFromMerchantHistory(member.household_id, item.merchant)) ??
          (item.categoryName ? (categories ?? []).find((c) => c.name.toLowerCase() === item.categoryName!.toLowerCase()) ?? null : null);
        const matchedAccount =
          (await matchAccountByCardLast4(member.household_id, item.cardLast4)) ?? (await matchAccountByNameHint(member.household_id, item.accountHint));
        const updatedRow = {
          parsed_merchant: item.merchant,
          parsed_amount: item.amount,
          parsed_date: item.occurred_at,
          parsed_category_id: matchedCategory?.id ?? null,
          parsed_currency: item.currency,
          parsed_account_id: matchedAccount?.id ?? null,
          parsed_kind: item.kind,
          confidence: item.confidence,
        };

        if (i === 0) {
          await supabase.from("intake").update(updatedRow).eq("id", inserted.id);
        } else {
          await supabase.from("intake").insert({
            household_id: member.household_id,
            member_id: member.id,
            source: "telegram",
            source_ref: `${updateId}#${i}`,
            raw_text: rawText,
            photo_path: photoPath,
            status: "pending",
            ...updatedRow,
          });
        }

        if (items!.length === 1) {
          // Same bar as the fast-confirm "yes" path above: only invite it
          // when account, category, currency and date are all already
          // resolved, not just when the model's own confidence is high --
          // and only when it doesn't look like something already recorded.
          // Multiple items in one message always go to the Inbox instead --
          // one "yes" confirming several different amounts at once is its
          // own source of mistakes.
          if (isReadyForFastConfirm(updatedRow)) {
            const duplicate = await findDuplicateTransaction(member.household_id, updatedRow.parsed_account_id, item.merchant, item.amount, item.occurred_at);
            if (!duplicate) {
              const kindLabel = item.kind === "income" ? "income " : item.kind === "refund" ? "refund " : "";
              fastConfirmSummary = `AED ${Number(item.amount).toFixed(2)} ${kindLabel}at ${item.merchant} (${matchedAccount!.name}${matchedCategory ? `, ${matchedCategory.name}` : ""}) on ${item.occurred_at}`;
            }
          }
        } else {
          multiItemSummaries.push(`AED ${Number(item.amount ?? 0).toFixed(2)}${item.merchant ? ` at ${item.merchant}` : ""}`);
        }
      } catch {
        // This one item's lookups/writes failed -- move on to the rest
        // rather than losing the whole message.
      }
    }
  } catch {
    // Leave the intake row exactly as captured -- raw content, no suggestions.
  }

  if (fastConfirmSummary) {
    // fastConfirmSummary is only ever set for a single-item message, whose one
    // item is the row inserted above -- so that is the intake this prompt is
    // about. A multi-item message deliberately offers no fast confirm at all.
    await sendFastConfirmPrompt(
      chatId,
      inserted.id,
      `Got it — ${fastConfirmSummary}. Everything matched, so reply "yes" to record it, or edit in the Inbox.`
    );
  } else {
    await reply(
      chatId,
      multiItemSummaries.length > 1
        ? `Got it — ${multiItemSummaries.length} expenses captured (${multiItemSummaries.join(", ")}). Check the Inbox to review each.`
        : "Got it — check the Inbox to review."
    );
  }
  return new Response("ok");
});
