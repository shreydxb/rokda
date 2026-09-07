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
import { resolveScopeMemberId } from "../_shared/applib/scope.js";
import { netWorthSummary } from "../_shared/applib/overviewMath.js";
import { monthActualsByCategory } from "../_shared/applib/budget.js";
import { nextDueDate, daysUntilDue } from "../_shared/applib/creditCard.js";
import { upcomingItems } from "../_shared/applib/recurring.js";

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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

type ParsedIntake = {
  merchant: string | null;
  amount: number | null;
  currency: string | null;
  occurred_at: string | null;
  categoryName: string | null;
  cardLast4: string | null;
  confidence: number;
};

// Calls OpenRouter (Gemini 2.5 Flash Lite: cheap, vision-capable, reliable
// instruction-following) to extract structured fields from raw text and/or a
// receipt photo -- including a forwarded/copy-pasted bank SMS, which has its
// own fairly rigid format ("AED 38.80 spent on card ending 1234 at FILLI
// CAFE on 05-09-26") that the model is told about explicitly rather than
// left to guess at like free-form text. Returns null on any failure -- the
// caller degrades to "raw content, no suggestions" rather than blocking on
// this.
async function parseIntakeWithAI(params: {
  rawText: string | null;
  imageBase64: string | null;
  imageMime: string | null;
  categoryNames: string[];
}): Promise<ParsedIntake | null> {
  if (!OPENROUTER_API_KEY) return null;
  const { rawText, imageBase64, imageMime, categoryNames } = params;
  if (!rawText && !imageBase64) return null;

  const today = new Date().toISOString().slice(0, 10);
  const instructions =
    `Extract a household expense/income from the message and/or receipt photo below. ` +
    `The message may be free-form text, or a bank/card SMS notification copy-pasted verbatim (e.g. "AED 38.80 spent on your card ending 1234 at FILLI CAFE LLC DXB on 05-09-26 14:32") -- extract from either the same way. ` +
    `Today's date is ${today}. ` +
    `Respond with ONLY a JSON object, no markdown, matching exactly: ` +
    `{"merchant": string|null, "amount": number|null, "currency": string|null, "occurred_at": "YYYY-MM-DD"|null, "category": string|null, "card_last4": string|null, "confidence": number} ` +
    `"currency" is the real currency of the amount if stated or clearly implied (e.g. "AED", "USD", "INR") -- null if genuinely unstated. Never assume AED just because the household is AED-based -- only state it if the message actually says or implies it. ` +
    `"card_last4" is the last 4 digits of a card mentioned (e.g. "card ending 1234", "card no. ...1234"), or null if none is mentioned. ` +
    `"category" MUST be exactly one of these household categories, verbatim, or null if none clearly fits -- never invent a category name: ` +
    `${JSON.stringify(categoryNames)}. ` +
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
    const parsed = JSON.parse(raw);

    const amount = typeof parsed.amount === "number" && Number.isFinite(parsed.amount) ? parsed.amount : null;
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0;
    const occurredAt = typeof parsed.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.occurred_at) ? parsed.occurred_at : null;
    const currency = typeof parsed.currency === "string" && /^[A-Za-z]{3}$/.test(parsed.currency.trim()) ? parsed.currency.trim().toUpperCase() : null;
    const cardLast4 = typeof parsed.card_last4 === "string" && /^\d{4}$/.test(parsed.card_last4.trim()) ? parsed.card_last4.trim() : null;

    return {
      merchant: typeof parsed.merchant === "string" && parsed.merchant.trim() ? parsed.merchant.trim() : null,
      amount,
      currency,
      occurred_at: occurredAt,
      categoryName: typeof parsed.category === "string" ? parsed.category : null,
      cardLast4,
      confidence,
    };
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

async function classifyAndRoute(rawText: string, categoryNames: string[], recentPending: { raw_text: string | null; created_at: string } | null) {
  const system =
    `You are a household finance assistant for Rokda, chatting with a household member via Telegram. ` +
    `If their message reports a real expense/income/refund that already happened (e.g. "spent 40 on lunch", "paid the rent"), ALWAYS call log_expense immediately -- even if the category, merchant, or exact amount isn't fully clear. ` +
    `Never ask a clarifying question about an expense to log: category assignment happens later when a human reviews it, not in this chat, and an uncategorised expense is a completely normal, expected outcome -- do not treat that as ambiguity. ` +
    `Only treat a message as ambiguous, and only then reply in plain text with a short clarifying question instead of calling a tool, when it is a QUESTION whose target is genuinely unclear (e.g. asking about an account name that matches nothing, or a category that doesn't fit any real one) -- never for something being logged. ` +
    `If it asks a real question about their finances, call the matching tool to fetch the real number -- you must NEVER answer from your own knowledge or guess a figure; only a tool result is a real number. ` +
    `Known expense categories (for question tools only, not required for logging): ${JSON.stringify(categoryNames)}.` +
    (recentPending
      ? ` The member's most recently sent entry, still pending review, was: "${recentPending.raw_text}" (sent ${recentPending.created_at}). If and only if this new message is explicitly correcting/amending that same entry, call update_last_expense. A genuinely new, separate expense -- even one sent moments later -- should still call log_expense.`
      : "");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PARSE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: rawText },
      ],
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

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // One-time setup: registers this function's own URL as the bot's webhook.
  // Meant to be hit once by whoever deploys this, not by Telegram itself.
  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    const result = await tgCall("setWebhook", {
      url: `${SUPABASE_URL}/functions/v1/telegram-webhook`,
      allowed_updates: ["message"],
    });
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  const message = update?.message as Record<string, unknown> | undefined;
  if (!message) return new Response("ok");

  const chat = message.chat as Record<string, unknown> | undefined;
  const from = message.from as Record<string, unknown> | undefined;
  const chatId = chat?.id as number | undefined;
  const fromId = from?.id as number | undefined;
  const updateId = update.update_id;
  if (!chatId || !fromId) return new Response("ok");

  const { data: member } = await supabase
    .from("household_members")
    .select("id, household_id, display_name")
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

  // A recent, still-pending entry from this member -- checked below both as
  // a fast-confirm target (an exact "yes" reply) and, further down, offered
  // to the classifier as something a new message might be correcting rather
  // than a separate expense. 20 minutes: long enough to catch "wait,
  // actually ..." (or a delayed "yes") a moment later, short enough that
  // it's clearly the same exchange rather than a much later, unrelated
  // message.
  let recentPending: {
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
  } | null = null;

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

    // A bare "yes" (or similar) confirming a pending entry that's already
    // fully resolved -- account, category, currency, date, all matched with
    // high confidence -- records it immediately via the same approve_intake
    // RPC the Inbox itself calls when a human clicks approve there. This
    // still requires the member to explicitly say yes -- it skips the Inbox
    // screen, never the confirmation itself. No LLM call at all, so this
    // costs nothing beyond a couple of small DB reads.
    if (recentPending && isReadyForFastConfirm(recentPending) && CONFIRM_REGEX.test(rawText.trim())) {
      try {
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

      const routed = await classifyAndRoute(rawText, (categories ?? []).map((c) => c.name), recentPending);
      const choice = routed?.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];

      if (toolCall?.function?.name === "update_last_expense" && recentPending) {
        const combinedText = `${recentPending.raw_text ?? ""}\nCorrection: ${rawText}`;
        const parsed = await parseIntakeWithAI({ rawText: combinedText, imageBase64: null, imageMime: null, categoryNames: (categories ?? []).map((c) => c.name) });
        const matchedCategory = parsed?.categoryName ? (categories ?? []).find((c) => c.name.toLowerCase() === parsed.categoryName!.toLowerCase()) : null;
        const matchedAccount = parsed ? await matchAccountByCardLast4(member.household_id, parsed.cardLast4) : null;
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
        await reply(
          chatId,
          isReadyForFastConfirm(updatedRow)
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
          default:
            result = { error: "unknown_tool" };
        }

        const answer = await phraseAnswer(rawText, result);
        await reply(chatId, answer ?? "I found the data but couldn't phrase a reply — please try rephrasing.");
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
  try {
    const { data: categories } = await supabase
      .from("categories")
      .select("id, name")
      .eq("household_id", member.household_id)
      .eq("archived", false);

    const parsed = await parseIntakeWithAI({
      rawText,
      imageBase64: photoBase64,
      imageMime: photoMime,
      categoryNames: (categories ?? []).map((c) => c.name),
    });

    if (parsed) {
      const matchedCategory = parsed.categoryName
        ? (categories ?? []).find((c) => c.name.toLowerCase() === parsed.categoryName!.toLowerCase())
        : null;
      const matchedAccount = await matchAccountByCardLast4(member.household_id, parsed.cardLast4);
      const updatedRow = {
        parsed_merchant: parsed.merchant,
        parsed_amount: parsed.amount,
        parsed_date: parsed.occurred_at,
        parsed_category_id: matchedCategory?.id ?? null,
        parsed_currency: parsed.currency,
        parsed_account_id: matchedAccount?.id ?? null,
        confidence: parsed.confidence,
      };

      await supabase.from("intake").update(updatedRow).eq("id", inserted.id);

      // Same bar as the fast-confirm "yes" path above: only invite it when
      // account, category, currency and date are all already resolved, not
      // just when the model's own confidence happens to be high.
      if (isReadyForFastConfirm(updatedRow)) {
        fastConfirmSummary = `AED ${Number(parsed.amount).toFixed(2)} at ${parsed.merchant} (${matchedAccount!.name}${matchedCategory ? `, ${matchedCategory.name}` : ""}) on ${parsed.occurred_at}`;
      }
    }
  } catch {
    // Leave the intake row exactly as captured -- raw content, no suggestions.
  }

  await reply(
    chatId,
    fastConfirmSummary
      ? `Got it — ${fastConfirmSummary}. Everything matched, so reply "yes" to record it, or edit in the Inbox.`
      : "Got it — check the Inbox to review."
  );
  return new Response("ok");
});
