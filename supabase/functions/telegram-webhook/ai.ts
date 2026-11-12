// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdToday } from "../_shared/applib/day.js";
import { OPENROUTER_API_KEY, PARSE_MODEL, supabase } from "./env.ts";
import { buildTools } from "./tools.ts";

export type TelegramCallKind = "classify_and_route" | "parse_intake" | "phrase_answer";


// SHR-288: metadata about every OpenRouter call this bot makes -- model,
// token counts, latency, success/failure -- so volume and reliability can be
// seen without keeping the actual prompt/response content (which is the
// household's raw financial messages, and deliberately not duplicated here).
// Best-effort: a logging failure must never break the Telegram reply it's
// describing.
export async function logTelegramCall(entry: {
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


// The AI service answers 429 when it is briefly overloaded and 5xx when it
// fails, and either usually clears within a second. Routing used to give up
// on the first such answer, so a question asked in that second was filed in
// the Inbox as an expense (SHR-373). One more try after a short wait covers
// it; every attempt is logged, so telegram_call_log still shows the failure.
// Returns the parsed body, or null when the service did not answer OK. A
// network failure is thrown to the caller, which logs it.
export const AI_RETRY_DELAY_MS = 1000;


export async function postToAiService(
  callKind: TelegramCallKind,
  payload: Record<string, unknown>,
  householdId: string | null,
  memberId: string | null,
): Promise<any | null> {
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const body = await res.json();
      await logTelegramCall({ callKind, householdId, memberId, model: PARSE_MODEL, latencyMs: Date.now() - startedAt, success: true, usage: body?.usage });
      return body;
    }
    await res.body?.cancel();
    await logTelegramCall({ callKind, householdId, memberId, model: PARSE_MODEL, latencyMs: Date.now() - startedAt, success: false, errorType: `http_${res.status}` });
    const busy = res.status === 429 || res.status >= 500;
    if (!busy || attempt > 1) return null;
    await new Promise((resolve) => setTimeout(resolve, AI_RETRY_DELAY_MS));
  }
}


// What the bot says when the AI service could not read a message at all. The
// message is kept in the Inbox all the same, so an expense is never lost.
export const AI_BUSY_REPLY = "I couldn't read that just now, so it's saved in the Inbox. If it was a question, ask again in a minute.";


export async function classifyAndRoute(
  rawText: string,
  categoryNames: string[],
  recentPending: { raw_text: string | null; created_at: string } | null,
  priorContext: { question: string; answer: string } | null,
  householdId: string | null = null,
  memberId: string | null = null
) {
  const system =
    `You are a household finance assistant for Rokda, chatting with a household member via Telegram. ` +
    // Without it a date like "24 Oct" is given whatever year the model
    // guesses, and a trade lands a year off.
    `Today's date is ${householdToday()} (Dubai). ` +
    `If their message reports a real expense/income/refund that already happened (e.g. "spent 40 on lunch", "paid the rent", "got paid my salary", "got a refund from Noon"), ALWAYS call log_expense immediately -- even if the category, merchant, or exact amount isn't fully clear. log_expense covers all three: the extraction step itself decides which one from the wording, you don't need to. ` +
    `EXCEPTION: if the message specifically says money is going toward a named savings or debt-payoff GOAL (e.g. "put 500 toward emergency fund", "added 1000 to the house downpayment goal"), call log_goal_contribution instead -- never log_expense for that message, since a goal contribution never touches an account balance or the ledger. An ordinary purchase or bill with no named goal is still log_expense. ` +
    `EXCEPTION: if the message says money moved between two of the household's own accounts (paying off the credit card from the bank account, moving money to savings), call log_transfer instead -- never log_expense, since a transfer is neither spending nor income. ` +
    `EXCEPTION: if the message reports buying, selling, a split or a bonus of a share, fund or ETF (e.g. "bought 10 ABC at 120.5", "sold 2 ABC at 150", "ABC split 10 for 1"), call log_trade instead -- never log_expense, since a share bought is not spending and a share sold is not income. "undo last trade" (or cancelling the last trade) is undo_last_trade. ` +
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
    return await postToAiService(
      "classify_and_route",
      { model: PARSE_MODEL, messages, tools: buildTools(recentPending !== null), tool_choice: "auto" },
      householdId,
      memberId,
    );
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


export async function phraseAnswer(
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
