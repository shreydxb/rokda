// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { autopayNotYetMessage, autopayReactionDecision, shortDay } from "../_shared/applib/autopay.js";
import { householdToday } from "../_shared/applib/day.js";
import { statementLookupFailedMessage, statementReactionDecision } from "../_shared/applib/statementReminder.js";
import { isPrivateChat } from "../_shared/applib/telegramChat.js";
import { lookupUnavailableMessage, PROMPT_FAILED, PROMPT_FOUND, PROMPT_UNADDRESSED, PROMPT_UNKNOWN, resolveConfirmTarget, THUMBS_UP_EMOJIS } from "../_shared/applib/telegramConfirm.js";
import { balanceFigure } from "./checks/balanceCheckin.ts";
import { decideDividends, dividendsNotYet, DividendsPayload, DividendsResult } from "./checks/dividendReceipts.ts";
import { decideStatement, statementForPrompt } from "./checks/statements.ts";
import { DIVIDENDS_ANSWERED, dividendsDropSummary, dividendsSavedMessage } from "./dividends.ts";
import { supabase } from "./env.ts";
import { findDuplicateTransaction, IntakeKind } from "./intake.ts";
import { proposeTrade } from "./tradeMessages.ts";
import { TradeDraft, tradeDropSummary, TradePayload, tradeRefusal, tradeSavedMessage } from "./trades.ts";
import { reply, tgCall } from "./transport.ts";

export const PENDING_WINDOW_MS = 20 * 60 * 1000;


// CONFIRM_REGEX, isReadyForFastConfirm, resolveConfirmTarget and
// ambiguousConfirmMessage all live in _shared/applib/telegramConfirm.js --
// see the import at the top of this file. They are pure, and they decide which
// entry a confirmation records, so they are kept where a unit test can reach
// them (QA #2).
export type PendingIntakeRow = {
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


export const RECENT_INTAKE_COLUMNS =
  "id, status, raw_text, created_at, parsed_merchant, parsed_amount, parsed_date, parsed_category_id, parsed_account_id, parsed_currency, parsed_kind, confidence, date_guessed, confirm_chat_id, confirm_message_id";


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
export type PromptLookup = { kind: string; row: PendingIntakeRow | null };


export async function intakeForPrompt(
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
export const CONFIRM_CANDIDATE_CAP = 25;


export async function confirmCandidates(
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
export async function sendFastConfirmPrompt(chatId: number, intakeId: string, text: string): Promise<void> {
  const messageId = await reply(chatId, text);
  if (messageId == null) return;
  await supabase
    .from("intake")
    .update({ confirm_chat_id: chatId, confirm_message_id: messageId })
    .eq("id", intakeId);
}


export async function confirmPendingIntake(chatId: number, householdId: string, recentPending: PendingIntakeRow): Promise<void> {
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
export async function handleReaction(reaction: Record<string, unknown>, updateId: unknown = null): Promise<Response> {
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
  const emojis = (newReaction ?? []).filter((r) => r.type === "emoji").map((r) => r.emoji ?? "");
  const thumbsUp = emojis.some((e) => THUMBS_UP_EMOJIS.has(e));
  // An autopay question also takes 👌, and 👎 for "not yet".
  const autopayDecision = emojis.map(autopayReactionDecision).find((d) => d != null) ?? null;
  if (!thumbsUp && !autopayDecision) return new Response("ok");

  const { data: member } = await supabase
    .from("household_members")
    .select("id, household_id")
    .eq("telegram_user_id", fromId)
    .maybeSingle();
  if (!member) return new Response("ok");

  // A reaction on a statement question, in the chat it was asked in, answers it.
  const statement = await statementForPrompt(member.household_id, chatId, messageId ?? null);
  if (statement.kind === "failed") {
    await reply(chatId, statementLookupFailedMessage());
    return new Response("ok");
  }
  if (statement.kind === "found") {
    const decision = emojis.map(statementReactionDecision).find((d) => d != null) ?? null;
    if (decision && statement.row.status === "waiting") await decideStatement(chatId, member.id, statement.row, decision);
    return new Response("ok");
  }

  // A 👍 on the bot's message proposing a balance or a goal contribution
  // applies it. One on a proposal already decided says nothing: a reaction is
  // not a question.
  const proposal = await proposalForPrompt(member.household_id, member.id, chatId, messageId ?? null);
  if (proposal.kind === PROMPT_FAILED) {
    await reply(chatId, lookupUnavailableMessage());
    return new Response("ok");
  }
  if (proposal.kind === PROMPT_FOUND && proposal.row) {
    if (proposal.row.kind === "autopay_payment") {
      if (proposal.row.status === "proposed" && autopayDecision) await decideAutopay(chatId, member.id, proposal.row, autopayDecision);
      return new Response("ok");
    }
    if (proposal.row.kind === "dividends_received" && !thumbsUp && autopayDecision === "not_yet") {
      if (proposal.row.status === "proposed") await dividendsNotYet(chatId, member.id, proposal.row);
      return new Response("ok");
    }
    if (proposal.row.status === "proposed" && thumbsUp) {
      await decideProposal(chatId, member.id, proposal.row, "apply", { householdId: member.household_id, updateId });
    }
    return new Response("ok");
  }
  if (!thumbsUp) return new Response("ok");

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
// Proposals: balances and goal contributions wait for a "yes"
// ---------------------------------------------------------------------------
//
// A balance or a goal contribution read from a message used to be written the
// moment the model read it, so one misread figure changed net worth, and the
// figure it replaced survived only in the chat. Now the bot saves what it
// read as a proposal (bot_proposals), shows the change, and writes nothing
// until the sender answers that message: "yes" or 👍 applies it through
// apply_bot_proposal(), "no" drops it. Expenses are unchanged; they already
// wait in the Inbox or for a "yes".

export type ProposalRow = {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  prompt_message_id: number | null;
  created_at: string;
  expires_at: string;
  result: Record<string, unknown> | null;
};


export const PROPOSAL_COLUMNS = "id, kind, status, payload, prompt_message_id, created_at, expires_at, result";


// The proposal whose message this replies to or reacts to, found by that
// message rather than by recency, for the same reasons as intakeForPrompt.
// Scoped to the member: only the sender can answer their own proposal.
export async function proposalForPrompt(
  householdId: string,
  memberId: string,
  chatId: number,
  messageId: number | null,
): Promise<{ kind: string; row: ProposalRow | null }> {
  if (messageId == null) return { kind: PROMPT_UNADDRESSED, row: null };
  const { data, error } = await supabase
    .from("bot_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .eq("chat_id", chatId)
    .eq("prompt_message_id", messageId)
    // A trade still being asked about has a question, not a confirmation:
    // its answers are read by answerTradeQuestion, and no "yes" applies it.
    .neq("status", "asking")
    .maybeSingle();
  if (error) return { kind: PROMPT_FAILED, row: null };
  if (data) return { kind: PROMPT_FOUND, row: data as ProposalRow };
  // An autopay question is asked again each morning until it is answered,
  // and an answer to any of those messages counts. The latest is
  // prompt_message_id; the earlier ones are kept in the payload.
  const { data: earlier, error: earlierError } = await supabase
    .from("bot_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .eq("chat_id", chatId)
    .eq("kind", "autopay_payment")
    .contains("payload", { asked_message_ids: [messageId] })
    .limit(1);
  if (earlierError) return { kind: PROMPT_FAILED, row: null };
  if (earlier?.length) return { kind: PROMPT_FOUND, row: earlier[0] as ProposalRow };
  return { kind: PROMPT_UNKNOWN, row: null };
}


// The member's proposals still waiting from the last few minutes, asked
// about: what a bare "yes" or "no" could be about. Older ones stay
// answerable by replying to them, until they lapse.
export async function openProposals(householdId: string, memberId: string): Promise<{ rows: ProposalRow[]; failed: boolean }> {
  const now = Date.now();
  const { data, error } = await supabase
    .from("bot_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .eq("status", "proposed")
    // Only proposals whose question is recorded as sent. One without could be
    // a change the member never saw: left behind by a run that died between
    // saving and asking, when the redelivery then read the message as
    // something else and never came back to it.
    .not("prompt_message_id", "is", null)
    // An autopay or dividend question waits all day for an answer, often
    // hours after it was asked, so a bare "paid" or "yes" counts for it
    // whenever it comes. Everything else counts only for a few minutes.
    .or(`created_at.gt.${new Date(now - PENDING_WINDOW_MS).toISOString()},kind.eq.autopay_payment,kind.eq.dividends_received`)
    .gt("expires_at", new Date(now).toISOString())
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) return { rows: [], failed: true };
  // Except a dividend question about a confirmed balance: its "no" records
  // and moves the fund, so a bare one counts only for a few minutes, as for
  // anything else.
  const rows = ((data ?? []) as ProposalRow[]).filter((r) =>
    !(r.kind === "dividends_received" && (r.payload as { ask?: unknown } | null)?.ask != null &&
      Date.parse(String(r.created_at)) <= now - PENDING_WINDOW_MS)
  );
  return { rows, failed: false };
}


// The member's proposal decided in the last few minutes, if any: what a
// second bare "yes", or Telegram redelivering the first, is about once
// nothing is waiting. Answering it with what was saved beats letting the
// "yes" fall through to capture, where it would land in the Inbox as an
// expense called "yes" and the member would never hear that the change was
// saved. Kept short, so a later "yes" meant for something else is not taken
// for it.
export const RECENT_DECISION_MS = 5 * 60 * 1000;


export async function recentlyDecidedProposal(householdId: string, memberId: string): Promise<{ row: ProposalRow | null; failed: boolean }> {
  const { data, error } = await supabase
    .from("bot_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("household_id", householdId)
    .eq("member_id", memberId)
    .in("status", ["applied", "cancelled"])
    .gt("decided_at", new Date(Date.now() - RECENT_DECISION_MS).toISOString())
    .order("decided_at", { ascending: false })
    .limit(1);
  if (error) return { row: null, failed: true };
  return { row: ((data ?? [])[0] as ProposalRow | undefined) ?? null, failed: false };
}


// Saves a proposal and sends the message that asks about it. Keyed by the
// Telegram update, so a redelivered message never makes a second one.
//
// What is saved must always be what the question shows, because a "yes" to
// the question applies the saved row. So a proposal whose question did not
// reach the member is deleted and the update thrown back for Telegram to
// retry; the retry proposes whatever it reads then (the model may read the
// message differently the second time). For the same reason, a redelivery
// that finds a proposal already asked about leaves it alone, and one that
// finds a proposal never asked about (a crash between saving and asking)
// rewrites it to this reading before asking.
export async function sendProposal(
  chatId: number,
  householdId: string,
  memberId: string,
  kind: "account_balances" | "goal_contribution" | "transfer" | "trade" | "trade_undo",
  payload: Record<string, unknown>,
  prompt: string,
  updateId: unknown,
): Promise<void> {
  const sourceRef = typeof updateId === "number" ? String(updateId) : null;
  const inserted = await supabase
    .from("bot_proposals")
    .insert({ household_id: householdId, member_id: memberId, kind, payload, chat_id: chatId, source_ref: sourceRef })
    .select("id, status, prompt_message_id")
    .single();
  let row = inserted.data as { id: string; status: string; prompt_message_id: number | null } | null;
  if (inserted.error) {
    // Anything but a redelivery is a failure to save: thrown, so the update
    // is released and Telegram retries it, rather than asking about a change
    // that does not exist.
    if (inserted.error.code !== "23505" || !sourceRef) throw new Error(`bot_proposals insert failed (${inserted.error.code ?? "no code"})`);
    const existing = await supabase
      .from("bot_proposals")
      .select("id, status, prompt_message_id")
      .eq("household_id", householdId)
      .eq("source_ref", sourceRef)
      .single();
    if (existing.error || !existing.data) throw new Error("bot_proposals lookup after a redelivery failed");
    row = existing.data as { id: string; status: string; prompt_message_id: number | null };
    // Answered already, or its question already reached the member.
    if (row.status !== "proposed" || row.prompt_message_id != null) return;
    const rewritten = await supabase
      .from("bot_proposals")
      .update({ kind, payload })
      .eq("id", row.id)
      .eq("status", "proposed")
      .is("prompt_message_id", null)
      .select("id");
    if (rewritten.error) throw new Error(`bot_proposals rewrite after a redelivery failed (${rewritten.error.code ?? "no code"})`);
    if (!rewritten.data?.length) return;
  }
  if (!row) throw new Error("bot_proposals insert returned no row");

  let messageId: number | null;
  try {
    messageId = await reply(chatId, prompt);
  } catch (err) {
    await discardUnaskedProposal(row.id);
    throw err;
  }
  if (messageId == null) {
    await discardUnaskedProposal(row.id);
    throw new Error("the proposal's question was not delivered");
  }
  // Without the question's id the proposal cannot be answered at all (a bare
  // answer counts only asked-about proposals), so one retry, and then the
  // question is withdrawn and the update thrown back: the redelivery finds
  // the proposal unasked, rewrites it to what it reads then and asks again.
  // Withdrawing matters because that reading may differ, and an answer the
  // member typed against the first question would otherwise save the second.
  let recorded = await supabase.from("bot_proposals").update({ prompt_message_id: messageId }).eq("id", row.id);
  if (recorded.error) recorded = await supabase.from("bot_proposals").update({ prompt_message_id: messageId }).eq("id", row.id);
  if (recorded.error) {
    await tgCall("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
    throw new Error(`recording the proposal's question failed (${recorded.error.code ?? "no code"})`);
  }
}


// Removes a proposal whose question never reached the member, so no "yes"
// can apply a change they were not shown. Only while nobody has answered it
// and no question is recorded against it.
export async function discardUnaskedProposal(id: string): Promise<void> {
  await supabase.from("bot_proposals").delete().eq("id", id).eq("status", "proposed").is("prompt_message_id", null);
}



export type ProposalItem = { name?: string; type?: string; currency?: string | null; old_balance?: number | string | null; new_balance?: number | string | null; balance?: number | string | null; reason?: string; amount?: number | string; occurred_at?: string; already_recorded?: boolean };

export type ProposalResult = { kind?: string; applied?: ProposalItem[]; skipped?: ProposalItem[] };


export function itemFigure(item: ProposalItem, balance: number | string | null | undefined): string {
  return balanceFigure({ id: "", name: item.name ?? "", type: item.type ?? "", currency: item.currency ?? "AED", balance: balance == null ? null : Number(balance), balance_as_of: null, owner_member_id: null, is_shared: true });
}


// What applying a proposal did, in exact figures. Not phrased by the model:
// this is the record of a write.
export function proposalOutcomeMessage(data: Record<string, unknown>): string {
  const outcome = String(data.outcome ?? "");
  if (outcome === "cancelled") return "You dropped that one, so nothing was changed.";
  if (outcome === "expired") return "That was more than a day ago, so I've let it lapse and changed nothing. Send it again if it still holds.";
  // An autopay bill no longer on autopay, or stopped: nothing recorded, and
  // the question closed, since the morning check will not ask about it again.
  if (outcome === "not_autopay") {
    const bill = ((data.skipped as Array<{ name?: string }> | undefined) ?? [])[0];
    return `${bill?.name ?? "That bill"} is no longer on autopay in Rokda, so nothing was recorded and I won't ask about it again. If you paid it yourself, record it with Mark paid under Money → Recurring.`;
  }
  // An autopay bill moved account or category since it was asked: nothing
  // recorded, and the question left open to be asked again about the bill as
  // it is now.
  if (outcome === "changed") {
    const bill = ((data.skipped as Array<{ name?: string }> | undefined) ?? [])[0];
    return `${bill?.name ?? "That bill"} has moved to another account or category in Rokda since I asked, so nothing was recorded. I'll ask again tomorrow about it as it is now.`;
  }
  if (outcome !== "applied") return "I can't find that change any more, so nothing was changed. Send it again if it still holds.";

  // A second "yes" gets the first answer again, marked as such.
  const repeat = data.result != null;
  const result = (repeat ? data.result : data) as ProposalResult;
  const applied = result.applied ?? [];
  const skipped = result.skipped ?? [];
  const parts: string[] = [];

  if (result.kind === "autopay_payment") {
    const b = applied[0] as (ProposalItem & { next_due?: string | null }) | undefined;
    if (!b) return "That bill is no longer set up in Rokda, so nothing was recorded.";
    const line = `${b.name}, AED ${Number(b.amount).toFixed(2)}, dated ${shortDay(String(b.occurred_at))}.`;
    if (repeat) return `Already recorded: ${line}`;
    if (b.already_recorded) return `Already recorded: ${line} It was in Rokda already, so I didn't add it again.`;
    return `Recorded: ${line}${b.next_due ? ` I'll ask again on ${shortDay(String(b.next_due))}.` : ""}`;
  }

  if (result.kind === "transfer") {
    const t = applied[0] as (ProposalItem & { from_name?: string; to_name?: string; joined_out?: boolean; joined_in?: boolean }) | undefined;
    if (!t) return "One of those accounts is no longer open in Rokda, so nothing was recorded.";
    const line = `AED ${Number(t.amount).toFixed(2)} from ${t.from_name} to ${t.to_name}, dated ${shortDay(String(t.occurred_at))}.`;
    if (repeat || t.already_recorded) return `Already recorded: ${line}`;
    const joined = [t.joined_out ? `the payment out of ${t.from_name}` : null, t.joined_in ? `the money into ${t.to_name}` : null].filter(Boolean);
    return `Recorded the transfer: ${line}${joined.length ? ` ${joined.join(" and ")} ${joined.length === 1 ? "was" : "were"} already in Rokda, so ${joined.length === 1 ? "it is" : "they are"} now part of it rather than spending or income.` : ""}`;
  }

  if (result.kind === "goal_contribution") {
    const g = applied[0];
    if (!g) return "That goal is no longer there, so nothing was recorded.";
    const line = `AED ${Number(g.amount).toFixed(2)} toward ${g.name}, dated ${g.occurred_at}.`;
    return repeat || g.already_recorded ? `Already recorded: ${line}` : `Recorded: ${line}`;
  }

  if (applied.length) {
    const lines = applied.map((a) =>
      Number(a.old_balance) === Number(a.new_balance)
        ? `✓ ${a.name}: ${itemFigure(a, a.new_balance)}, unchanged`
        : `✓ ${a.name}: ${itemFigure(a, a.old_balance)} → ${itemFigure(a, a.new_balance)}`
    );
    parts.push(`${repeat ? "Already saved" : "Saved"}, confirmed today:\n${lines.join("\n")}`);
  }
  for (const item of skipped) {
    if (item.reason === "changed") {
      parts.push(`Not changed: ${item.name} reads ${itemFigure(item, item.balance)} in the app now, not the figure I showed you. Send it again if yours is still right.`);
    } else {
      parts.push(`Not changed: ${item.name ?? "an account"} is no longer open in the app.`);
    }
  }
  return parts.join("\n\n") || "Nothing to change.";
}


// What a proposal would change, in a few words, for the reply that drops it:
// a bare "no" must say what it dropped.
export function proposalSummary(row: { kind: string; payload: Record<string, unknown> }): string {
  const payload = row.payload ?? {};
  if (row.kind === "trade" || row.kind === "trade_undo") return tradeDropSummary(payload as TradePayload, row.kind);
  if (row.kind === "dividends_received") return dividendsDropSummary(payload as DividendsPayload);
  if (row.kind === "autopay_payment") {
    return `${String(payload.name ?? "the bill")} (AED ${Number(payload.amount ?? 0).toFixed(2)})`;
  }
  if (row.kind === "goal_contribution") {
    return `AED ${Number(payload.amount ?? 0).toFixed(2)} toward ${String(payload.goal_name ?? "the goal")}`;
  }
  if (row.kind === "transfer") {
    return `the transfer of AED ${Number(payload.amount ?? 0).toFixed(2)} from ${String(payload.from_name ?? "one account")} to ${String(payload.to_name ?? "another")}`;
  }
  const names = ((payload.items as Array<{ name?: unknown }>) ?? []).map((i) => String(i.name ?? "an account"));
  if (!names.length) return "the balance change";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `the ${names.length === 1 ? "balance" : "balances"} for ${list}`;
}


// For an answer to a proposal already decided: what happened to it, with the
// saved figures again when it was applied.
export function decidedProposalMessage(row: ProposalRow): string {
  if (row.kind === "autopay_payment" && row.status !== "applied") return autopayClosedMessage(row);
  if (row.kind === "dividends_received") {
    const payload = row.payload as DividendsPayload;
    if (row.status === "applied") return dividendsSavedMessage(payload.fund_name, payload.currency, row.result as DividendsResult, true);
    const result = (row.result ?? {}) as { error?: string; not_yet?: boolean };
    if (row.status === "cancelled" && result.not_yet) return "You said not yet, so I'll ask about them again tomorrow morning.";
    if (row.status === "cancelled") return `You left ${dividendsDropSummary(payload)} for the app, so nothing was recorded.`;
    if (result.error === "answered") return DIVIDENDS_ANSWERED;
    return "That question lapsed or changed, so nothing was recorded. You can record them on the holding in the app.";
  }
  if (row.kind === "trade" || row.kind === "trade_undo") {
    if (row.status === "applied") {
      const effect = ((row.result ?? {}) as { effect?: Record<string, unknown> }).effect ?? {};
      return tradeSavedMessage(row.payload as TradePayload, effect, { repeat: true, undo: row.kind === "trade_undo" });
    }
    if (row.status === "cancelled") return `You dropped ${proposalSummary(row)}, so nothing was saved.`;
    return "That one was not saved: the holding changed or it lapsed. Send the trade again if it still holds.";
  }
  if (row.status === "applied") return row.result ? proposalOutcomeMessage({ outcome: "applied", result: row.result }) : "That one is already saved.";
  if (row.status === "cancelled") return `You dropped ${proposalSummary(row)}, so nothing was changed.`;
  return "That one has lapsed, so nothing was changed. Send it again if it still holds.";
}


export async function decideProposal(
  chatId: number,
  memberId: string,
  proposal: ProposalRow,
  decision: "apply" | "cancel",
  again: { householdId: string; updateId: unknown } | null = null,
): Promise<void> {
  if (proposal.kind === "dividends_received") {
    await decideDividends(chatId, memberId, proposal, decision);
    return;
  }
  const trade = proposal.kind === "trade" || proposal.kind === "trade_undo";
  if (decision === "cancel") {
    const { data, error } = await supabase
      .from("bot_proposals")
      .update({ status: "cancelled", decided_at: new Date().toISOString() })
      .eq("id", proposal.id)
      .eq("member_id", memberId)
      .eq("status", "proposed")
      .select(PROPOSAL_COLUMNS);
    if (error) {
      await reply(chatId, "I couldn't drop that just now. Nothing has been changed; try again in a moment.");
      return;
    }
    if (data?.length) {
      await reply(chatId, `Dropped ${proposalSummary(proposal)}. Nothing was ${trade ? "saved" : "changed"}.`);
      return;
    }
    // Decided in between, by a "yes" a moment earlier or by lapsing.
    const { data: fresh } = await supabase.from("bot_proposals").select(PROPOSAL_COLUMNS).eq("id", proposal.id).maybeSingle();
    await reply(chatId, decidedProposalMessage((fresh as ProposalRow | null) ?? proposal));
    return;
  }

  const { data, error } = await supabase.rpc("apply_bot_proposal", { p_proposal_id: proposal.id, p_member_id: memberId });
  if (!error && proposal.kind === "autopay_payment" && (data as Record<string, unknown> | null)?.outcome === "expired") {
    await reply(chatId, autopayClosedMessage(proposal));
    return;
  }
  if (error || !data || typeof data !== "object") {
    // Applying is one transaction and repeatable, so asking for the same
    // answer again is safe whether or not this attempt got through.
    await reply(chatId, 'I couldn\'t confirm that just now. Reply "yes" to my message again in a moment; it will only be saved once.');
    return;
  }
  if (trade) {
    await tradeDecided(chatId, memberId, proposal, data as Record<string, unknown>, again);
    return;
  }
  await reply(chatId, proposalOutcomeMessage(data as Record<string, unknown>));
}


// What a "yes" to a trade did. Saved: what was saved, from what the database
// returned. The holding changed since the member was shown it (stale), or
// the confirmation lapsed: nothing was saved, and the trade is previewed and
// confirmed again with today's figures, never applied with the old ones.
// Refused: why, in the same words as a refused preview.
export async function tradeDecided(
  chatId: number,
  memberId: string,
  proposal: ProposalRow,
  data: Record<string, unknown>,
  again: { householdId: string; updateId: unknown } | null,
): Promise<void> {
  const payload = proposal.payload as TradePayload & { draft?: TradeDraft };
  const outcome = String(data.outcome ?? "");
  const undo = proposal.kind === "trade_undo";
  const name = payload.holding_name ?? "That holding";
  if (outcome === "applied") {
    const result = (data.result ?? data) as { effect?: Record<string, unknown> };
    await reply(chatId, tradeSavedMessage(payload, result.effect ?? {}, { repeat: data.result != null, undo }));
    return;
  }
  if (outcome === "refused") {
    await reply(chatId, tradeRefusal(String(data.error ?? ""), { holdingName: name, units: Number(payload.units) || undefined }));
    return;
  }
  if (outcome === "stale" || outcome === "expired") {
    const lead = outcome === "stale"
      ? `${name} changed since I asked, so nothing was ${undo ? "undone" : "saved"}.`
      : `That confirmation lapsed, so nothing was ${undo ? "undone" : "saved"}.`;
    if (!undo && payload.draft && again) {
      await reply(chatId, `${lead} Here it is again with today's figures:`);
      await proposeTrade(chatId, { id: memberId, household_id: again.householdId }, payload.draft, again.updateId);
      return;
    }
    await reply(chatId, `${lead} Send it again if it still holds.`);
    return;
  }
  if (outcome === "cancelled") {
    await reply(chatId, `You dropped ${proposalSummary(proposal)}, so nothing was saved.`);
    return;
  }
  await reply(chatId, proposalOutcomeMessage(data));
}


// An autopay question that can no longer be answered: someone else confirmed
// it, or its cycle passed.
export function autopayClosedMessage(row: { payload: Record<string, unknown> }): string {
  const name = String(row.payload?.name ?? "That bill");
  const due = row.payload?.due_date ? ` for ${shortDay(String(row.payload.due_date))}` : "";
  return `Nothing to do: ${name}${due} is already recorded, or its month has passed. I'll ask again on its next due date.`;
}


// An answer to an autopay question. "paid" records the bill, at the amount
// the member gave if they gave one. "not yet" leaves the question open: the
// bot asks again tomorrow morning, and a "paid" later today still counts.
export async function decideAutopay(
  chatId: number,
  memberId: string,
  proposal: ProposalRow,
  decision: "paid" | "not_yet",
  amount: number | null = null,
): Promise<void> {
  if (proposal.status !== "proposed") {
    await reply(chatId, decidedProposalMessage(proposal));
    return;
  }
  if (decision === "not_yet") {
    await supabase
      .from("bot_proposals")
      .update({ payload: { ...proposal.payload, not_yet_on: householdToday() } })
      .eq("id", proposal.id)
      .eq("status", "proposed");
    await reply(chatId, autopayNotYetMessage(String(proposal.payload?.name ?? "That bill")));
    return;
  }
  let row = proposal;
  if (amount != null && amount > 0 && amount !== Number(proposal.payload?.amount)) {
    // The member said what went out. What is saved is what they said.
    const payload = { ...proposal.payload, amount, scheduled_amount: proposal.payload?.amount };
    const { error } = await supabase.from("bot_proposals").update({ payload }).eq("id", proposal.id).eq("status", "proposed");
    if (error) {
      await reply(chatId, `I couldn't record that amount just now. Nothing has been saved; reply "paid ${amount}" again in a moment.`);
      return;
    }
    row = { ...proposal, payload };
  }
  await decideProposal(chatId, memberId, row, "apply");
}
