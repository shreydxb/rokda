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
import { netWorthSummary } from "../_shared/applib/overviewMath.js";
import { monthActualsByCategory } from "../_shared/applib/budget.js";
import { nextDueDate, daysUntilDue } from "../_shared/applib/creditCard.js";
import { upcomingItems } from "../_shared/applib/recurring.js";
import { isPosted, parseDay, atDayOfMonth, startOfDay } from "../_shared/applib/day.js";
import { isSpendRow, spendDelta } from "../_shared/applib/transactionKind.js";
import { visibleHoldings, scopedHoldingValue, holdingGain, allocationByClass, portfolioGain } from "../_shared/applib/holdings.js";

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

async function reply(chatId: number, text: string) {
  await tgCall("sendMessage", { chat_id: chatId, text });
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

type ParsedItem = {
  merchant: string | null;
  amount: number | null;
  currency: string | null;
  occurred_at: string | null;
  categoryName: string | null;
  cardLast4: string | null;
  accountHint: string | null;
  confidence: number;
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

  return {
    merchant: typeof parsed.merchant === "string" && parsed.merchant.trim() ? parsed.merchant.trim() : null,
    amount,
    currency,
    occurred_at: occurredAt,
    categoryName: typeof parsed.category === "string" ? parsed.category : null,
    cardLast4,
    accountHint,
    confidence,
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
}): Promise<ParsedItem[] | null> {
  if (!OPENROUTER_API_KEY) return null;
  const { rawText, imageBase64, imageMime, categoryNames } = params;
  if (!rawText && !imageBase64) return null;

  const today = new Date().toISOString().slice(0, 10);
  const instructions =
    `Extract ALL household expenses/income described in the message and/or receipt photo below. Most messages describe exactly one, but some describe several separate amounts (e.g. "bought two plants for 260 and 50" is TWO expenses -- never sum multiple amounts into one, and never drop any of them). ` +
    `The message may be free-form text, or a bank/card SMS notification copy-pasted verbatim (e.g. "AED 38.80 spent on your card ending 1234 at FILLI CAFE LLC DXB on 05-09-26 14:32") -- extract from either the same way; a bank SMS almost always describes exactly one. ` +
    `Today's date is ${today}. ` +
    `Respond with ONLY a JSON object, no markdown, matching exactly: ` +
    `{"items": [{"merchant": string|null, "amount": number|null, "currency": string|null, "occurred_at": "YYYY-MM-DD"|null, "category": string|null, "card_last4": string|null, "account_hint": string|null, "confidence": number}, ...]} ` +
    `One item per distinct amount. Shared details (date, account, merchant if it applies to all) should be repeated on every item rather than left null just because it was only stated once in the message. ` +
    `"currency" is the real currency of the amount if stated or clearly implied (e.g. "AED", "USD", "INR") -- null if genuinely unstated. Never assume AED just because the household is AED-based -- only state it if the message actually says or implies it. ` +
    `"card_last4" is the last 4 digits of a card mentioned (e.g. "card ending 1234", "card no. ...1234"), or null if none is mentioned. ` +
    `"account_hint" is the account/card NAME mentioned in the message, if any (e.g. "Wio", "FAB Z", "ENBD Noon", "FAB Islamic") -- a short free-text name, not digits, or null if no account/card is named. ` +
    `"category" MUST be exactly one of these household categories, verbatim, or null if none clearly fits -- never invent a category name: ` +
    `${JSON.stringify(categoryNames)}. ` +
    `Note: "Noon Minutes" (or "Minutes") is Noon's fast grocery delivery service, not its general marketplace -- categorise it as groceries, not shopping, if a groceries-like category exists. ` +
    `"confidence" is your own confidence in this extraction, 0 to 1. ` +
    `If you cannot determine a field, use null rather than guessing.`;

  const content: Array<Record<string, unknown>> = [{ type: "text", text: instructions }];
  if (rawText) content.push({ type: "text", text: `Message: ${rawText}` });
  if (imageBase64 && imageMime) {
    content.push({ type: "image_url", image_url: { url: `data:${imageMime};base64,${imageBase64}` } });
  }

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
    if (!res.ok) return null;
    const body = await res.json();
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

// A short, near-exact "yes" to a fast-confirm prompt (see the bottom of
// Deno.serve) -- deliberately strict so a real message that happens to start
// with "yes" (e.g. "yes I know, also spent 40 on lunch") is never mistaken
// for confirming a pending entry.
const CONFIRM_REGEX = /^(yes|y|yep|yeah|confirm|ok|okay|sure|correct|go ahead|do it|record it)[.!]?$/i;

// Instant recording (skipping the Inbox entirely) is only offered when every
// field approve_intake actually requires is already resolved with no
// guesswork -- account and category matched, currency AED or unstated, and
// the parser's own confidence high. Confidence alone was never a safe gate
// for this: it only ever reflected the model's certainty about
// merchant/amount/date, never whether an account or category was found, so
// those are checked separately here rather than folded into one fuzzy number.
type PendingIntakeRow = {
  id: string;
  raw_text: string | null;
  created_at: string;
  parsed_merchant: string | null;
  parsed_amount: number | string | null;
  parsed_date: string | null;
  parsed_category_id: string | null;
  parsed_account_id: string | null;
  parsed_currency: string | null;
  confidence: number | string | null;
};

function isReadyForFastConfirm(row: {
  parsed_merchant: string | null;
  parsed_amount: number | string | null;
  parsed_date: string | null;
  parsed_category_id: string | null;
  parsed_account_id: string | null;
  parsed_currency: string | null;
  confidence: number | string | null;
}): boolean {
  return (
    !!row.parsed_merchant &&
    row.parsed_amount != null &&
    Number(row.parsed_amount) > 0 &&
    !!row.parsed_date &&
    !!row.parsed_category_id &&
    !!row.parsed_account_id &&
    (row.parsed_currency == null || row.parsed_currency === "AED") &&
    Number(row.confidence ?? 0) >= 0.85
  );
}

// A word/emoji reply confirming a pending entry, or a 👍/✅ reaction on any
// message in the chat (see handleReaction below) -- both routes land here so
// there is exactly one place that calls approve_intake for the fast-confirm
// path.
const THUMBS_UP_EMOJIS = new Set(["\u{1F44D}", "✅"]);

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

    const { error: approveError } = await supabase.rpc("approve_intake", {
      p_intake_id: recentPending.id,
      p_account_id: recentPending.parsed_account_id,
      p_amount: recentPending.parsed_amount,
      p_occurred_at: recentPending.parsed_date,
      p_kind: "expense",
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
    await reply(
      chatId,
      `Recorded: AED ${Number(recentPending.parsed_amount).toFixed(2)} at ${recentPending.parsed_merchant} (${acct?.name ?? "account"}${cat?.name ? `, ${cat.name}` : ""}) on ${recentPending.parsed_date}.`
    );
  } catch {
    await reply(chatId, "Something went wrong confirming that -- please check the Inbox.");
  }
}

// A 👍/✅ reaction (long-press a message in Telegram, no typing needed) on
// ANY message in the chat -- Telegram's reaction event doesn't carry which
// pending entry it was meant for, so this trusts the same single signal the
// "yes" reply already trusts: is there exactly one recent, fully-resolved
// pending entry for this member right now. Requires the bot's webhook to be
// registered for "message_reaction" updates (see the ?setup=1 handler).
async function handleReaction(reaction: Record<string, unknown>): Promise<Response> {
  const chat = reaction.chat as Record<string, unknown> | undefined;
  const user = reaction.user as Record<string, unknown> | undefined;
  const chatId = chat?.id as number | undefined;
  const fromId = user?.id as number | undefined;
  const newReaction = reaction.new_reaction as Array<{ type?: string; emoji?: string }> | undefined;
  if (!chatId || !fromId) return new Response("ok");
  if (!(newReaction ?? []).some((r) => r.type === "emoji" && THUMBS_UP_EMOJIS.has(r.emoji ?? ""))) {
    return new Response("ok");
  }

  const { data: member } = await supabase
    .from("household_members")
    .select("id, household_id")
    .eq("telegram_user_id", fromId)
    .maybeSingle();
  if (!member) return new Response("ok");

  const { data: recentPendingRows } = await supabase
    .from("intake")
    .select(
      "id, raw_text, created_at, parsed_merchant, parsed_amount, parsed_date, parsed_category_id, parsed_account_id, parsed_currency, confidence"
    )
    .eq("household_id", member.household_id)
    .eq("member_id", member.id)
    .eq("status", "pending")
    .gt("created_at", new Date(Date.now() - PENDING_WINDOW_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  const recentPending = recentPendingRows?.[0] ?? null;
  if (!recentPending || !isReadyForFastConfirm(recentPending)) return new Response("ok");

  await confirmPendingIntake(chatId, member.household_id, recentPending);
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
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
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
  return {
    net_worth_aed: round2(summary.netWorth),
    assets_aed: round2(summary.assets),
    liabilities_aed: round2(summary.liabilities),
  };
}

async function toolGetAccountBalance(householdId: string, args: Record<string, unknown>) {
  const { data: accounts } = await supabase.from("accounts").select("*").eq("household_id", householdId).is("archived_at", null);
  const norm = String(args.account_name ?? "").trim().toLowerCase();
  const matches = (accounts ?? []).filter((a: { name: string }) => a.name.toLowerCase().includes(norm));
  if (matches.length === 0) return { error: "account_not_found", available: (accounts ?? []).map((a: { name: string }) => a.name) };
  if (matches.length > 1) return { error: "ambiguous_account", matches: matches.map((a: { name: string }) => a.name) };
  const a = matches[0] as { name: string; balance: number; balance_aed: number | null; currency: string };
  return { account: a.name, balance_aed: round2(Number(a.balance_aed ?? a.balance)), currency: a.currency };
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
  const bills = upcomingItems(visibleRecurring as never, 14, now).map((r: { name: string; amount: number; dueDate: Date }) => ({
    name: r.name,
    amount_aed: round2(Math.abs(Number(r.amount))),
    due_date: r.dueDate.toISOString().slice(0, 10),
  }));

  const cardBills: Array<{ name: string; amount_owed_aed: number; due_date: string }> = [];
  for (const a of (accounts ?? []) as Array<{ type: string; is_shared: boolean; owner_member_id: string | null; name: string; balance: number; balance_aed: number | null; due_day: number | null }>) {
    if (a.type !== "credit_card") continue;
    if (!(scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId)) continue;
    const bal = Number(a.balance_aed ?? a.balance);
    if (bal <= 0) continue;
    const days = daysUntilDue(a.due_day, now);
    if (days === null || days < 0 || days > 14) continue;
    cardBills.push({ name: a.name, amount_owed_aed: round2(bal), due_date: nextDueDate(a.due_day, now)!.toISOString().slice(0, 10) });
  }

  return { recurring: bills, credit_cards: cardBills };
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
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
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
    const perf = portfolioGain(visible as never, (history ?? []) as never, range, scopeMemberId);
    result.range = range;
    result.range_performance = perf.available
      ? {
          start_value_aed: round2(perf.startTotal!),
          now_value_aed: round2(perf.nowTotal),
          change_aed: round2(perf.absolute!),
          change_pct: perf.pct !== null ? round2(perf.pct * 100) : null,
        }
      : { available: false, note: "Not enough price history to cover that range yet." };
  }

  return result;
}

// ---------------------------------------------------------------------------
// /brief digest -- deterministic, template-built from the same real tools
// above rather than another LLM call: cheaper, and there's no room for a
// phrasing pass to drift from the actual numbers on something meant to be
// glanced at daily. Household-wide (scope=null) rather than "me", since the
// point is a shared status check, not a personal one.
// ---------------------------------------------------------------------------

const BRIEF_TRIGGERS = new Set(["brief", "/brief", "digest", "/digest", "summary", "daily brief"]);

// Total spend this month across every category combined -- the tools above
// only ever total one category at a time, so this reuses the same
// scope/posted-only rules by hand rather than looping every category through
// monthActualsByCategory.
async function toolGetMonthSpendTotal(householdId: string, scopeMemberId: string | null): Promise<number> {
  const { data: transactions } = await supabase
    .from("transactions")
    .select("amount, kind, occurred_at, is_shared, owner_member_id")
    .eq("household_id", householdId);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
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

// Every category with a budget set this month that's at or over 90% used --
// the same threshold the frontend budget bars treat as "watch this".
async function toolGetBudgetAlerts(householdId: string, scopeMemberId: string | null): Promise<Array<{ category: string; pct: number }>> {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
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
  const [netWorth, monthSpend, bills, budgetAlerts, pendingResult] = await Promise.all([
    toolGetNetWorth(householdId, null),
    toolGetMonthSpendTotal(householdId, null),
    toolGetUpcomingBills(householdId, null),
    toolGetBudgetAlerts(householdId, null),
    supabase.from("intake").select("id", { count: "exact", head: true }).eq("household_id", householdId).eq("status", "pending"),
  ]);

  const lines: string[] = [];
  lines.push(`Net worth: AED ${netWorth.net_worth_aed.toLocaleString()}`);
  lines.push(`Spent this month: AED ${monthSpend.toLocaleString()}`);

  const billLines = [
    ...bills.recurring.map((r: { name: string; amount_aed: number; due_date: string }) => `${r.name} AED ${r.amount_aed} (${r.due_date})`),
    ...bills.credit_cards.map((c: { name: string; amount_owed_aed: number; due_date: string }) => `${c.name} AED ${c.amount_owed_aed} (${c.due_date})`),
  ];
  lines.push(billLines.length ? `Due in 14 days: ${billLines.join(", ")}` : "Nothing due in the next 14 days.");

  if (budgetAlerts.length) {
    lines.push(`Budget watch: ${budgetAlerts.map((a) => `${a.category} ${a.pct}%`).join(", ")}`);
  }

  const pendingCount = pendingResult.count ?? 0;
  lines.push(pendingCount ? `Inbox: ${pendingCount} item${pendingCount === 1 ? "" : "s"} to review.` : "Inbox is clear.");

  return lines.join("\n");
}

async function classifyAndRoute(
  rawText: string,
  categoryNames: string[],
  recentPending: { raw_text: string | null; created_at: string } | null,
  priorContext: { question: string; answer: string } | null
) {
  const system =
    `You are a household finance assistant for Rokda, chatting with a household member via Telegram. ` +
    `If their message reports a real expense/income/refund that already happened (e.g. "spent 40 on lunch", "paid the rent"), ALWAYS call log_expense immediately -- even if the category, merchant, or exact amount isn't fully clear. ` +
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
  if (!res.ok) return null;
  return res.json();
}

async function phraseAnswer(question: string, toolResult: unknown): Promise<string | null> {
  const system =
    `Answer the user's question in one or two short sentences using ONLY the JSON data given below -- never state a number that isn't in it. ` +
    `If the data has an "error" field, explain the problem plainly (e.g. list what's in "available") and ask them to rephrase -- do not guess which one they meant. ` +
    `Amounts are AED unless the data says otherwise. Be direct and brief, like a text message, no markdown.`;
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
    if (!res.ok) return null;
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text : null;
  } catch {
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

  const { data: dueRows } = await supabase
    .from("recurring")
    .select("id, household_id, name, owner_member_id, is_shared, amount, next_due_date")
    .eq("active", true)
    .gte("next_due_date", graceStart.toISOString().slice(0, 10))
    .lte("next_due_date", graceEnd.toISOString().slice(0, 10));

  let nudged = 0;
  for (const r of (dueRows ?? []) as Array<{
    id: string;
    household_id: string;
    name: string;
    owner_member_id: string | null;
    is_shared: boolean;
    amount: number;
    next_due_date: string;
  }>) {
    try {
      const { data: alreadySent } = await supabase
        .from("recurring_nudges")
        .select("recurring_id")
        .eq("recurring_id", r.id)
        .eq("due_date", r.next_due_date)
        .maybeSingle();
      if (alreadySent) continue;

      // A "match" is anything roughly the right amount (20% tolerance --
      // bills like DEWA vary month to month) posted within 5 days either
      // side of the due date. Merchant text isn't checked: it's too
      // inconsistent between a bank SMS and a manual entry to be a
      // reliable signal here, and amount + timing is already a fair bar.
      const windowStart = new Date(r.next_due_date);
      windowStart.setDate(windowStart.getDate() - 5);
      const windowEnd = new Date(r.next_due_date);
      windowEnd.setDate(windowEnd.getDate() + 5);
      const { data: nearby } = await supabase
        .from("transactions")
        .select("id, amount")
        .eq("household_id", r.household_id)
        .gte("occurred_at", windowStart.toISOString().slice(0, 10))
        .lte("occurred_at", windowEnd.toISOString().slice(0, 10));
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
          `I don't see a transaction for "${r.name}" yet (usually around AED ${amount.toFixed(2)}, due ${r.next_due_date}) -- forgot to log it, or paid another way?`
        );
      }
      await supabase.from("recurring_nudges").insert({ recurring_id: r.id, due_date: r.next_due_date });
      nudged++;
    } catch {
      // One recurring row's nudge failing must never block the rest.
    }
  }
  return { checked: dueRows?.length ?? 0, nudged };
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
  const { data: cards } = await supabase
    .from("accounts")
    .select("id, household_id, name, owner_member_id, is_shared, balance, balance_aed, due_day")
    .eq("type", "credit_card")
    .is("archived_at", null)
    .not("due_day", "is", null);

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
    const bal = Number(a.balance_aed ?? a.balance);
    if (bal <= 0) continue; // nothing owed, nothing to nag about

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
          ? `${a.name} is due ${dueDateStr} -- outstanding balance AED ${bal.toFixed(2)}.`
          : `${a.name} was due ${dueDateStr} and still shows AED ${bal.toFixed(2)} owing -- paid it another way, or forgot?`;
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
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const { data: budgetRows } = await supabase.from("budgets").select("household_id, category_id, amount").eq("year", year).eq("month", month).gt("amount", 0);

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
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  }

  // Daily proactive-reminder check, triggered by pg_cron. Covers three
  // independent things in one run: missed recurring bills, credit-card due
  // dates, and budget thresholds -- kept under the same query param the
  // existing pg_cron job already calls, rather than adding new jobs for
  // each.
  if (req.method === "GET" && url.searchParams.get("run_recurring_check") === "1") {
    const [recurring, creditCards, budgets] = await Promise.all([runRecurringCheck(), runCreditCardCheck(), runBudgetAlertCheck()]);
    return new Response(JSON.stringify({ recurring, credit_cards: creditCards, budgets }), { headers: { "Content-Type": "application/json" } });
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

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

  const { data: member } = await supabase
    .from("household_members")
    .select("id, household_id, display_name, telegram_last_question, telegram_last_answer, telegram_last_context_at")
    .eq("telegram_user_id", fromId)
    .maybeSingle();

  if (!member) {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (text) {
      const { data: pending } = await supabase
        .from("household_members")
        .select("id, display_name")
        .eq("telegram_link_code", text)
        .gt("telegram_link_code_expires_at", new Date().toISOString())
        .maybeSingle();

      if (pending) {
        // Uses the service-role client, which the guard trigger on
        // household_members explicitly exempts (see the telegram_linking
        // migration) -- this is the one path allowed to set telegram_user_id.
        await supabase
          .from("household_members")
          .update({ telegram_user_id: fromId, telegram_link_code: null, telegram_link_code_expires_at: null })
          .eq("id", pending.id)
          .eq("telegram_link_code", text);
        await reply(
          chatId,
          `Linked as ${pending.display_name}. Send a receipt photo, a message like "42 aed carrefour groceries", or ask a question like "what's our net worth?" any time.`
        );
        return new Response("ok");
      }
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

  if (rawText && !fileId) {
    const { data: recentPendingRows } = await supabase
      .from("intake")
      .select(
        "id, raw_text, created_at, parsed_merchant, parsed_amount, parsed_date, parsed_category_id, parsed_account_id, parsed_currency, confidence"
      )
      .eq("household_id", member.household_id)
      .eq("member_id", member.id)
      .eq("status", "pending")
      .gt("created_at", new Date(Date.now() - PENDING_WINDOW_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    recentPending = recentPendingRows?.[0] ?? null;

    // A bare "yes" (or a typed 👍/✅ -- a long-press reaction on any message
    // is handled separately, see handleReaction) confirming a pending entry
    // that's already fully resolved -- account, category, currency, date,
    // all matched with high confidence -- records it immediately via the
    // same approve_intake RPC the Inbox itself calls when a human clicks
    // approve there. This still requires the member to explicitly confirm --
    // it skips the Inbox screen, never the confirmation itself. No LLM call
    // at all, so this costs nothing beyond a couple of small DB reads.
    const trimmedText = rawText.trim();
    if (recentPending && isReadyForFastConfirm(recentPending) && (CONFIRM_REGEX.test(trimmedText) || THUMBS_UP_EMOJIS.has(trimmedText))) {
      await confirmPendingIntake(chatId, member.household_id, recentPending);
      return new Response("ok");
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

      const routed = await classifyAndRoute(rawText, (categories ?? []).map((c) => c.name), recentPending, priorContext);
      const choice = routed?.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];

      if (toolCall?.function?.name === "update_last_expense" && recentPending) {
        const combinedText = `${recentPending.raw_text ?? ""}\nCorrection: ${rawText}`;
        // A correction targets the one existing pending row, so only the
        // first extracted item is used even if the model finds more --
        // multi-item corrections aren't supported, same as before.
        const parsed = (await parseIntakeWithAI({ rawText: combinedText, imageBase64: null, imageMime: null, categoryNames: (categories ?? []).map((c) => c.name) }))?.[0] ?? null;
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
        await reply(
          chatId,
          isReadyForFastConfirm(updatedRow) && !correctionDuplicate
            ? `Updated — AED ${Number(updatedRow.parsed_amount).toFixed(2)} at ${updatedRow.parsed_merchant}. Everything matched, so reply "yes" to record it, or edit in the Inbox.`
            : "Updated your last pending entry — check the Inbox."
        );
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
          default:
            result = { error: "unknown_tool" };
        }

        const answer = await phraseAnswer(rawText, result);
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
              fastConfirmSummary = `AED ${Number(item.amount).toFixed(2)} at ${item.merchant} (${matchedAccount!.name}${matchedCategory ? `, ${matchedCategory.name}` : ""}) on ${item.occurred_at}`;
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

  await reply(
    chatId,
    fastConfirmSummary
      ? `Got it — ${fastConfirmSummary}. Everything matched, so reply "yes" to record it, or edit in the Inbox.`
      : multiItemSummaries.length > 1
        ? `Got it — ${multiItemSummaries.length} expenses captured (${multiItemSummaries.join(", ")}). Check the Inbox to review each.`
        : "Got it — check the Inbox to review."
  );
  return new Response("ok");
});
