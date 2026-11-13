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
//
// This file is the request handling and the routing of each update. The rest
// is split by responsibility (the round 2 cleanup, SHR-383):
//   env.ts            settings and the database client
//   transport.ts      sending to Telegram, update claims, link attempts
//   ai.ts             calls to the AI service: routing a message, phrasing an
//                     answer (the tools it may pick are in tools.ts)
//   intake.ts         reading an expense from a message: items, dates, cards
//   confirmations.ts  pending entries, reactions, proposals and their answers
//   tools.ts          the router's tools, the read-only questions, the brief,
//                     drafts
//   tradeMessages.ts  trades by message (trades.ts holds their pure helpers)
//   checks/           the scheduled checks, one file each, with the replies
//                     that answer them (a statement's "done", a balance)
//                     and the helpers they share (recipients.ts)
// The handler tests are one file per part, on testing/harness.ts.
import "jsr:@supabase/functions-js@2.117.2/edge-runtime.d.ts";
import { autopayAnswer } from "../_shared/applib/autopay.js";
import { householdToday } from "../_shared/applib/day.js";
import { resolveScopeMemberId } from "../_shared/applib/scope.js";
import { isPrivateChat } from "../_shared/applib/telegramChat.js";
import { ambiguousConfirmMessage, ambiguousProposalMessage, dropUnavailableMessage, isCancellationText, isConfirmable, isConfirmationText, isReadyForFastConfirm, lookupUnavailableMessage, PROMPT_UNADDRESSED, resolveConfirmTarget, resolveCorrectionTarget, resolveProposalTarget, unknownPromptMessage } from "../_shared/applib/telegramConfirm.js";
import { linkTokenDigest, linkTokenFromMessage, looksLikeLinkToken } from "../_shared/applib/telegramLink.js";
import { secretsMatch } from "../_shared/requestAuth.ts";
import { AI_BUSY_NOTHING_SAVED, AI_BUSY_REPLY, classifyAndRoute, NOT_AN_EXPENSE_REPLY, phraseAnswer } from "./ai.ts";
import { runAutopayCheck } from "./checks/autopay.ts";
import { proposeAccountBalances, runBalanceCheckin } from "./checks/balanceCheckin.ts";
import { runMonthlyBriefCheck, runWeeklyBriefCheck } from "./checks/briefs.ts";
import { runBudgetAlertCheck } from "./checks/budgetAlerts.ts";
import { runCashCoverCheck } from "./checks/cashCover.ts";
import { runCreditCardCheck } from "./checks/creditCards.ts";
import { Digest } from "./checks/digest.ts";
import { dividendsNotYet, runDividendCheck } from "./checks/dividendReceipts.ts";
import { runRecurringCheck } from "./checks/recurring.ts";
import { runSplitCheck, runUnusualSpendCheck } from "./checks/spending.ts";
import { handleStatementText, runStatementCheck } from "./checks/statements.ts";
import { isBatchCommand } from "./batch.ts";
import { handleChoiceTap, sendChoicePrompt } from "./choices.ts";
import { BATCH_UNADDRESSED_HINT, batchForPrompt, handleBatchReply, hasOpenList, type SavedItem, sendBatchList } from "./batchReview.ts";
import { confirmCandidates, confirmPendingIntake, decideAutopay, decidedProposalMessage, decideProposal, handleReaction, intakeForPrompt, openProposals, PENDING_WINDOW_MS, type PendingIntakeRow, type PromptLookup, PROPOSAL_COLUMNS, proposalForPrompt, type ProposalRow, RECENT_INTAKE_COLUMNS, recentlyDecidedProposal, sendFastConfirmPrompt, sendProposal } from "./confirmations.ts";
import { DIVIDEND_CLASSES, DIVIDEND_GUARD_REPLY, readsAsDividend } from "./dividends.ts";
import { OPENROUTER_API_KEY, supabase, SUPABASE_URL, TELEGRAM_BOT_TOKEN } from "./env.ts";
import { alreadyRecordedNote, categoryByName, datedItems, findDuplicateTransaction, forwardedDay, inboxReason, loadCategoryKnowledge, loadFileableCategories, matchAccountByCardLast4, matchAccountByNameHint, matchCategoryFromMerchantHistory, parseIntakeWithAI, QUESTION_TOOLS, undatedNote } from "./intake.ts";
import { BRIEF_TRIGGERS, buildBriefMessage, figuresUnavailableMessage, goalContributionDraft, ReadFailed, toolGetAccountBalance, toolGetBudgetStatus, toolGetCategorySpend, toolGetHoldings, toolGetNetWorth, toolGetTradeProfit, toolGetUpcomingBills, transferDraft, transferPrompt } from "./tools.ts";
import { answerTradeQuestion, FILE_TOO_BIG, FILE_TOO_BIG_CAPTION_KEPT, handleTradeMessage, handleUndoTrade } from "./tradeMessages.ts";
import { ANSWER_HINT } from "./trades.ts";
import { type AnswerTarget, bytesToBase64, claimUpdate, clearLinkFailures, getTelegramWebhookSecret, linkAttemptBlocked, logFailure, pruneTelegramUpdateLog, recordAnswerTarget, recordedAnswerTarget, recordLinkFailure, reply, sendReminder, settleUpdate, telegramFetch, tgCall } from "./transport.ts";

// Exported for the tests, which import them from here.
export { accountsForCheckin, balanceFigure, buildBalanceCheckinMessage, pickCheckinAccount } from "./checks/balanceCheckin.ts";
export { sendablePeriod } from "./checks/recipients.ts";
export { proposalOutcomeMessage, proposalSummary } from "./confirmations.ts";
export { datedItems, forwardedDay, inboxReason, isSpendingAccount, pickAccountByHint, undatedNote } from "./intake.ts";
export { figuresUnavailableMessage, ReadFailed, transferDraftFrom, transferPrompt } from "./tools.ts";

async function handleRequest(req: Request): Promise<Response> {
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
  // Compared in constant time (secretsMatch): `!==` returns at the first
  // differing character, which lets anyone who can time this public endpoint
  // recover the secret a character at a time.
  const expectedSecret = await getTelegramWebhookSecret();
  if (!expectedSecret || !secretsMatch(req.headers.get("X-Telegram-Bot-Api-Secret-Token"), expectedSecret)) {
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
      // callback_query: taps on the buttons that ask for a missing category
      // or card (choices.ts).
      allowed_updates: ["message", "message_reaction", "callback_query"],
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

  // Daily proactive-reminder check, triggered by pg_cron. Covers several
  // independent things in one run: missed recurring bills, credit-card due
  // dates, budget thresholds, a weekly brief (Mondays only), a month-end
  // review (1st of the month only), a cash-cover warning and a question
  // after a traded holding's large one-day move -- kept under
  // the same query param the existing pg_cron job already calls, rather
  // than adding new jobs for each. The weekly/monthly checks no-op on every
  // day but their own, so running them daily costs nothing.
  if (req.method === "GET" && url.searchParams.get("run_recurring_check") === "1") {
    // The reminders that need no answer, and that morning's brief or review,
    // go out together as one message a person (checks/digest.ts); the
    // questions (autopay, statements, splits, dividends) still send their own.
    const digest = new Digest();
    let digestSent: { chats: number; recorded: number } = { chats: 0, recorded: 0 };
    // Whatever the checks gathered is sent even if one of them throws: that
    // one's lines are simply missing, as its messages were before.
    let results;
    try {
      results = await Promise.all([
        runRecurringCheck(digest),
        runAutopayCheck(),
        runCreditCardCheck(digest),
        runStatementCheck(),
        runBudgetAlertCheck(digest),
        runWeeklyBriefCheck(digest),
        runMonthlyBriefCheck(digest),
        runCashCoverCheck(digest),
        runUnusualSpendCheck(digest),
        runBalanceCheckin(digest),
        runSplitCheck(),
        runDividendCheck(),
      ]);
    } finally {
      digestSent = await digest.send(sendReminder);
    }
    const [recurring, autopay, creditCards, statements, budgets, weeklyBrief, monthlyBrief, cashCover, unusualSpend, balanceCheckin, splits, dividends] = results;
    // Housekeeping, not a check: nothing reports on it and nothing depends on
    // it having run today.
    await pruneTelegramUpdateLog();
    return new Response(
      JSON.stringify({
        recurring,
        autopay,
        credit_cards: creditCards,
        statements,
        budgets,
        weekly_brief: weeklyBrief,
        monthly_brief: monthlyBrief,
        cash_cover: cashCover,
        unusual_spend: unusualSpend,
        balance_checkin: balanceCheckin,
        splits,
        dividends,
        digest: digestSent,
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
  // routes are covered (QA #2, SHR-303). Only 'completed' is answered 200
  // without processing. 'busy' and 'unknown' are answered non-200 so that
  // Telegram retries: busy because the run holding the claim may yet fail,
  // unknown because a database error must never decide to proceed.
  const claim = await claimUpdate(update?.update_id);
  if (claim === "completed") return new Response("ok");
  if (claim === "busy" || claim === "unknown") return new Response("retry later", { status: 503 });

  try {
    const response = await processUpdate(update);
    await settleUpdate(update?.update_id, "completed");
    return response;
  } catch (err) {
    // Released, so the redelivery this 500 provokes is processed rather than
    // dropped. That is the silent-loss case this replaces.
    await settleUpdate(update?.update_id, "failed");
    logFailure("process_update", update?.update_id, err);
    return new Response("retry later", { status: 500 });
  }
}


// Everything a claimed update does. Lifted out of the request handler so that
// one wrapper decides the claim's outcome: an early `return` in here is a
// completed update, and a throw is a failed one.
async function processUpdate(update: Record<string, unknown>): Promise<Response> {
  const message = update?.message as Record<string, unknown> | undefined;
  if (!message) {
    const tap = update?.callback_query as Record<string, unknown> | undefined;
    if (tap) return await handleChoiceTap(tap);
    const reaction = update?.message_reaction as Record<string, unknown> | undefined;
    if (reaction) return await handleReaction(reaction, update.update_id);
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

      // The roster holds the code's digest, never the code (any member can
      // read the roster), so the digest of what was sent is what matches.
      const candidateDigest = await linkTokenDigest(candidate);
      const { data: pending } = await supabase
        .from("household_members")
        .select("id, display_name")
        .eq("telegram_link_code", candidateDigest)
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
          .eq("telegram_link_code", candidateDigest)
          // Unexpired when redeemed, not only when looked up (round 2 of the
          // outside review).
          .gt("telegram_link_code_expires_at", new Date().toISOString())
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

  // A link code from an account that is already linked: answered here, before
  // anything else reads the message. It used to fall through to the AI
  // service and, with that down, into intake, which every member can read, so
  // the other member could redeem a live code (round 2 of the outside review).
  // Anywhere in the text or a caption, not only alone: "my code is …" is the
  // same code (the fresh review of round 2).
  const said = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
  if (looksLikeLinkToken(linkTokenFromMessage(said)) || /\b[0-9a-f]{32}\b/i.test(said)) {
    await reply(
      chatId,
      `This Telegram account is already linked, as ${member.display_name}. A link code is for an account that isn't linked yet: send it from that one. I haven't kept this one.`
    );
    return new Response("ok");
  }

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

    // A reply to the numbered list sent after a paste of several entries
    // (batchReview.ts). Settled before the single-entry lookup, which expects
    // one entry per prompt. An unaddressed "all on 2 Oct" or "drop 4" with a
    // list open is told to reply to the list, so it can never act on the
    // wrong one.
    if (repliedTo != null) {
      const batch = await batchForPrompt(member.household_id, member.id, chatId, repliedTo);
      if (batch === "failed") {
        await reply(chatId, lookupUnavailableMessage());
        return new Response("ok");
      }
      if (batch.length >= 2) {
        const listText = (message.reply_to_message as { text?: string } | undefined)?.text ?? null;
        await handleBatchReply(chatId, member, batch, rawText.trim(), householdToday(), listText);
        return new Response("ok");
      }
    } else if (/^(all|drop)\b/i.test(rawText.trim()) && isBatchCommand(rawText, householdToday()) && (await hasOpenList(member.household_id, member.id))) {
      await reply(chatId, BATCH_UNADDRESSED_HINT);
      return new Response("ok");
    }

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

    // A "yes" or "no" may answer a proposed balance or goal contribution
    // rather than an expense. That is settled first: a reply to a proposal
    // decides it, and a bare answer decides the one proposal waiting only
    // when no expense is waiting for a "yes" too. Anything else falls through
    // to the expense rules below, unchanged.
    // An autopay question also understands "paid", "deducted", "not yet" and
    // the like (autopayAnswer), but only an autopay question does: "paid"
    // aimed at a balance change or an expense is not an answer to it.
    // A statement question is settled first when the message answers one
    // (handleStatementText decides when that is).
    // An answer to the bot's question about a trade comes first: "10" to
    // "How many ABC did you buy?" is that, not an expense.
    if (await answerTradeQuestion(chatId, member, trimmedText, repliedTo, updateId)) return new Response("ok");
    if (await handleStatementText(chatId, member, trimmedText, repliedTo)) return new Response("ok");

    const strictYes = isConfirmationText(trimmedText);
    // A bare "yes" while an entry ready for one is on a list: a list is
    // answered by replying to it, with a day where the SMS had none.
    if (strictYes && repliedTo == null) {
      const perPrompt = new Map<number, number>();
      for (const r of candidates.rows) if (r.confirm_message_id != null) perPrompt.set(r.confirm_message_id, (perPrompt.get(r.confirm_message_id) ?? 0) + 1);
      // Only an entry a "yes" could record: a list of undated entries does
      // not stand in the way of a single entry's own prompt.
      if (candidates.rows.some((r) => isConfirmable(r) && r.confirm_message_id != null && (perPrompt.get(r.confirm_message_id) ?? 0) >= 2)) {
        await reply(chatId, BATCH_UNADDRESSED_HINT);
        return new Response("ok");
      }
    }
    const strictNo = isCancellationText(trimmedText);
    const autopay = autopayAnswer(trimmedText);
    const confirming = strictYes || autopay.decision === "paid";
    const cancelling = !confirming && (strictNo || autopay.decision === "not_yet");
    // Set when this is Telegram delivering again a bare answer that already
    // resolved to something: it answers that, whatever is waiting now.
    let replay: AnswerTarget | null = null;
    if (confirming || cancelling) {
      const unaddressed = repliedTo == null;
      if (unaddressed) replay = await recordedAnswerTarget(updateId);
      let target: { kind: "one" | "decided"; row: ProposalRow } | { kind: "ambiguous" | "unavailable" | "none" };
      if (replay?.kind === "proposal") {
        const { data, error } = await supabase.from("bot_proposals").select(PROPOSAL_COLUMNS)
          .eq("id", replay.id).eq("member_id", member.id).maybeSingle();
        if (error) throw new Error(`reading the proposal an answer was about failed (${error.code ?? "no code"})`);
        const row = data as ProposalRow | null;
        target = !row ? { kind: "none" } : row.status === "proposed" ? { kind: "one", row } : { kind: "decided", row };
      } else if (replay?.kind === "intake") {
        target = { kind: "none" };
      } else {
        const [proposalLookup, open, recent] = await Promise.all([
          proposalForPrompt(member.household_id, member.id, chatId, repliedTo),
          unaddressed ? openProposals(member.household_id, member.id) : Promise.resolve({ rows: [] as ProposalRow[], failed: false }),
          unaddressed ? recentlyDecidedProposal(member.household_id, member.id) : Promise.resolve({ row: null, failed: false }),
        ]);
        // An expense waiting for its own "yes" makes a bare "no" as ambiguous
        // as a bare "yes": either could be about it.
        target = resolveProposalTarget({
          lookup: proposalLookup.kind,
          row: proposalLookup.row,
          open: open.rows,
          openFailed: open.failed || recent.failed,
          recentlyDecided: recent.row,
          readyIntakes: candidates.rows.filter(isConfirmable),
          truncated: candidates.truncated,
        });
        if (unaddressed && target.kind === "one") await recordAnswerTarget(updateId, { kind: "proposal", id: target.row.id });
      }
      if (target.kind === "one" && target.row.kind === "autopay_payment") {
        await decideAutopay(chatId, member.id, target.row, confirming ? "paid" : "not_yet", confirming ? autopay.amount : null);
        return new Response("ok");
      }
      // "Not yet" puts a dividend question off; a plain "no" (which an autopay
      // question also reads as not yet) still answers it.
      if (target.kind === "one" && target.row.kind === "dividends_received" && autopay.decision === "not_yet" && !strictNo) {
        await dividendsNotYet(chatId, member.id, target.row);
        return new Response("ok");
      }
      if (target.kind === "one" && (strictYes || strictNo)) {
        await decideProposal(chatId, member.id, target.row, strictYes ? "apply" : "cancel", { householdId: member.household_id, updateId });
        return new Response("ok");
      }
      if (target.kind === "decided" && (strictYes || strictNo || target.row.kind === "autopay_payment")) {
        await reply(chatId, decidedProposalMessage(target.row));
        return new Response("ok");
      }
      if (target.kind === "unavailable") {
        await reply(chatId, confirming ? lookupUnavailableMessage() : dropUnavailableMessage());
        return new Response("ok");
      }
      if (target.kind === "ambiguous") {
        await reply(chatId, ambiguousProposalMessage(confirming));
        return new Response("ok");
      }
    }

    if (strictYes) {
      if (replay?.kind === "intake") {
        const { data, error } = await supabase.from("intake").select(RECENT_INTAKE_COLUMNS)
          .eq("id", replay.id).eq("member_id", member.id).maybeSingle();
        if (error) throw new Error(`reading the entry an answer was about failed (${error.code ?? "no code"})`);
        const row = data as PendingIntakeRow | null;
        if (row && isConfirmable(row)) await confirmPendingIntake(chatId, member.household_id, row);
        else if (row?.status === "approved") await reply(chatId, "That one is already recorded. Anything else waiting needs its own yes.");
        else await reply(chatId, "That entry changed after your yes, so nothing was recorded. Check it in the Inbox.");
        return new Response("ok");
      }
      const target = resolveConfirmTarget({
        lookup: promptLookup.kind,
        row: promptLookup.row,
        recent: candidates.rows,
        truncated: candidates.truncated,
      });
      if (target.kind === "one") {
        if (repliedTo == null) await recordAnswerTarget(updateId, { kind: "intake", id: target.row.id });
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

  // Set when routing could not get an answer from the AI service, even on a
  // second try. The message is then captured unread, and its reply must not
  // suggest otherwise: it may have been a question (SHR-373).
  let routingFailed = false;
  // SHR-240: a plain text message (no photo/document) might be a question
  // rather than something to log -- route it before ever touching `intake`.
  // A photo is presumptively a receipt, so this never runs for one.
  if (rawText && !fileId && OPENROUTER_API_KEY) {
    // Set once the message has been committed to something OTHER than intake
    // capture: a correction, a routed tool, or a clarifying reply. The catch
    // below falls through to capture, which is right only while routing itself
    // is what failed. After a tool has run, a failure -- Telegram unreachable
    // for the reply, say -- used to fall through as well, so "put 500 toward
    // the house goal" was recorded as a contribution AND captured as a pending
    // expense; confirm that entry and the 500 counted twice (SHR-303, found by
    // the handler tests). A committed message now rethrows instead, so the
    // update is released and retried, and the delivery keys make the retry
    // harmless.
    let committedElsewhere = false;
    try {
      // Nothing is filed under a savings category as spending, nor under a
      // group with categories within it (fileableCategories).
      const categories = await loadFileableCategories(member.household_id, "expense");

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

      const routed = await classifyAndRoute(rawText, categories.map((c) => c.label), recentPending, priorContext, member.household_id, member.id);
      if (!routed) routingFailed = true;
      const choice = routed?.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];

      if (toolCall?.function?.name === "update_last_expense" && recentPending) {
        committedElsewhere = true;
        const combinedText = `${recentPending.raw_text ?? ""}\nCorrection: ${rawText}`;
        // A correction targets the one existing pending row, so only the
        // first extracted item is used even if the model finds more --
        // multi-item corrections aren't supported, same as before.
        const reparsed = await parseIntakeWithAI({
          rawText: combinedText,
          imageBase64: null,
          imageMime: null,
          categoryNames: categories.map((c) => c.label),
          householdId: member.household_id,
          memberId: member.id,
        });
        const parsed = reparsed?.length ? datedItems([reparsed[0]], householdToday(), forwardedDay(message))[0] : null;
        const matchedCategory = parsed
          ? (await matchCategoryFromMerchantHistory(await loadCategoryKnowledge(member.household_id), parsed.merchant, categories)) ??
            categoryByName(categories, parsed.categoryName)
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
          date_guessed: parsed?.dateGuessed ?? false,
        };
        // The question that showed the old figures is unbound in the same
        // write: a "yes" to it must not record figures it never showed
        // (outside review D-01). Only the question about the corrected
        // figures, sent below, binds the entry again. An entry recorded or
        // changed since it was read is left alone and said so.
        const amended = await supabase
          .from("intake")
          .update({ raw_text: combinedText, ...updatedRow, confirm_chat_id: null, confirm_message_id: null })
          .eq("id", recentPending.id)
          .eq("status", "pending")
          .select("id");
        if (amended.error) throw new Error(`saving a correction failed (${amended.error.code ?? "no code"})`);
        if (!amended.data?.length) {
          await reply(chatId, "That entry has already been recorded or changed in Rokda, so the correction wasn't applied. Check it in the Inbox.");
          return new Response("ok");
        }

        const correctionDuplicate = isReadyForFastConfirm(updatedRow)
          // A check that could not run is not a clean check: the entry waits
          // in the Inbox rather than being offered a quick "yes".
          ? await findDuplicateTransaction(member.household_id, updatedRow.parsed_account_id, updatedRow.parsed_merchant, updatedRow.parsed_amount, updatedRow.parsed_date).catch(() => "unchecked" as const)
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

      // Only a question tool the bot actually has answers here. A name it
      // does not know (the router can invent one), or update_last_expense
      // with nothing pending, used to reply "Error: unknown_tool"; it falls
      // through to capture instead, the same as log_expense, so the message
      // is never lost.
      if (toolCall?.function?.name === "undo_last_trade") {
        committedElsewhere = true;
        await handleUndoTrade(chatId, member, updateId);
        return new Response("ok");
      }

      // A share trade has its own path: matched, asked about, previewed by the
      // database and proposed. It is never captured as an expense.
      if (toolCall?.function?.name === "log_trade") {
        committedElsewhere = true;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          // Unreadable arguments read as nothing given: the draft asks for the share.
        }
        await handleTradeMessage(chatId, member, args, updateId);
        return new Response("ok");
      }

      if (toolCall && QUESTION_TOOLS.has(toolCall.function?.name)) {
        committedElsewhere = true;
        const args = JSON.parse(toolCall.function.arguments || "{}");
        const { data: members } = await supabase.from("household_members").select("id, display_name").eq("household_id", member.household_id);
        const scopeMemberId = resolveScopeMemberId(args.scope ?? "me", member, members ?? []);

        if (toolCall.function.name === "update_account_balances") {
          // Proposed in exact figures rather than paraphrased; written only on a "yes".
          await proposeAccountBalances(chatId, member.household_id, member.id, args, updateId);
          return new Response("ok");
        }

        if (toolCall.function.name === "log_goal_contribution") {
          let draft: Awaited<ReturnType<typeof goalContributionDraft>>;
          try {
            draft = await goalContributionDraft(member.household_id, args);
          } catch (err) {
            // The goals could not be read: said plainly, and the message is
            // not captured into the Inbox as an expense by the catch below.
            if (!(err instanceof ReadFailed)) throw err;
            committedElsewhere = true;
            await reply(chatId, "I couldn't read your goals just now, so nothing was recorded. Please send it again in a minute.");
            return new Response("ok");
          }
          if (!("error" in draft)) {
            await sendProposal(
              chatId,
              member.household_id,
              member.id,
              "goal_contribution",
              { goal_id: draft.goal.id, goal_name: draft.goal.name, amount: draft.amount, occurred_at: draft.occurredAt },
              `Record AED ${draft.amount.toFixed(2)} toward ${draft.goal.name}, dated ${draft.occurredAt}? Nothing is recorded until you say yes.\n\n${ANSWER_HINT}`,
              updateId,
            );
            return new Response("ok");
          }
        }

        if (toolCall.function.name === "log_transfer") {
          const draft = await transferDraft(member.household_id, args);
          if (!("error" in draft)) {
            await sendProposal(
              chatId,
              member.household_id,
              member.id,
              "transfer",
              {
                from_account_id: draft.from.id,
                from_name: draft.from.name,
                to_account_id: draft.to.id,
                to_name: draft.to.name,
                amount: draft.amount,
                occurred_at: draft.occurredAt,
                note: draft.note,
              },
              transferPrompt(draft),
              updateId,
            );
            return new Response("ok");
          }
        }

        let result: unknown;
        try {
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
            case "get_trade_profit":
              result = await toolGetTradeProfit(member.household_id, scopeMemberId, args);
              break;
            case "log_goal_contribution":
              // Only a draft that failed reaches here (above): the goal or the
              // amount could not be read, which the reply explains.
              result = await goalContributionDraft(member.household_id, args);
              break;
            case "log_transfer":
              // Likewise: an account that matched nothing (or two), the same
              // account twice, or no amount, which the reply explains.
              result = await transferDraft(member.household_id, args);
              break;
          }
        } catch (err) {
          // A figure built from part of the data is not answered at all, and
          // not handed to the model to phrase: told nothing, it could still
          // say "nothing spent". Said here, so the question is not captured
          // into the Inbox by the catch further down either.
          if (!(err instanceof ReadFailed)) throw err;
          committedElsewhere = true;
          await reply(chatId, figuresUnavailableMessage());
          return new Response("ok");
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
        committedElsewhere = true;
        // No tool call: the model's own text is a clarifying question (or a
        // decline) -- never a financial answer, since only a tool call can
        // produce a real number.
        await reply(chatId, choice.message.content);
        return new Response("ok");
      }
      // toolCall.function.name === "log_expense", or routing produced
      // nothing usable: fall through to intake capture below.
    } catch (err) {
      // Routing failed -- fall through to intake capture rather than losing
      // the message. But only if routing is what failed: see committedElsewhere.
      if (committedElsewhere) throw err;
      routingFailed = true;
    }
  }

  if (fileId) {
    // The receipt is kept, or the update is thrown back for Telegram to
    // deliver again: a failure here used to fall through, so a photo with no
    // caption ended the update as handled with nothing saved, and a captioned
    // one lost its receipt (outside review D-06). Nothing has been written
    // yet at this point, so a retry repeats nothing. The one failure a retry
    // cannot fix is a file over the size a bot may download, which is said.
    const fileInfo = await tgCall("getFile", { file_id: fileId }) as { ok?: boolean; description?: string; result?: { file_path?: string } };
    if (fileInfo?.ok === false && /file is too big/i.test(fileInfo.description ?? "")) {
      await reply(chatId, rawText ? FILE_TOO_BIG_CAPTION_KEPT : FILE_TOO_BIG);
      if (!rawText) return new Response("ok");
    } else {
      const filePath = fileInfo?.result?.file_path;
      if (!filePath) throw new Error(`telegram getFile gave no file (${fileInfo?.ok === false ? "refused" : "no path"})`);
      const fileRes = await telegramFetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`, undefined, "getFile download");
      if (!fileRes.ok) throw new Error(`telegram getFile download failed (${fileRes.status})`);
      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      const contentType = fileRes.headers.get("content-type") ?? "image/jpeg";
      const ext = filePath.split(".").pop() || "jpg";
      const storagePath = `${member.household_id}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from("telegram-receipts")
        .upload(storagePath, bytes, { contentType });
      if (uploadError) throw new Error("storing the receipt failed");
      photoPath = storagePath;
      // Only images go to the vision model -- a forwarded PDF or other
      // document still gets stored and reviewed, just without parsing.
      if (contentType.startsWith("image/") && bytes.length < 15_000_000) {
        photoBase64 = bytesToBase64(bytes);
        photoMime = contentType;
      }
    }
  }

  if (!rawText && !photoPath) return new Response("ok"); // nothing usable (a sticker, a reaction, ...)

  // The Inbox holds entries someone can approve, and each has an amount. A
  // message the AI service could not read, with no digit and no photo, has
  // none to read later or to type in from a receipt, so it is answered
  // rather than kept: a question used to wait there as an entry (the feature
  // review, November 2026; docs/decisions.md, "Only an expense waits in the
  // Inbox"). One the router did read, and called an expense, goes on to the
  // parser, which reads an amount in words.
  if (routingFailed && !fileId && !/\p{Nd}/u.test(rawText ?? "")) {
    await reply(chatId, AI_BUSY_NOTHING_SAVED);
    return new Response("ok");
  }

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
      // this update was already captured) is a real failure.
      await reply(chatId, "Something went wrong saving that — please try again.");
      return new Response("ok");
    }
    // Captured, read and set aside as holding no expense: say that again,
    // not that it is in the Inbox.
    const { data: earlier } = await supabase.from("intake").select("status, parsed_amount, parsed_merchant").eq("household_id", member.household_id).eq("source_ref", String(updateId)).maybeSingle();
    if (earlier?.status === "rejected" && earlier.parsed_amount == null && earlier.parsed_merchant == null) {
      await reply(chatId, NOT_AN_EXPENSE_REPLY);
      return new Response("ok");
    }
    // Already captured. This used to stay silent, which was right when a
    // redelivery meant "Telegram never saw our 200 for a run that replied".
    // Since SHR-303 a completed update is answered before it gets here, so
    // this is reached only when an earlier run captured the expense and then
    // failed or crashed -- most likely before it could say so. Staying silent
    // then leaves the member with a recorded expense and no word that it was.
    // A short acknowledgement is never wrong: at worst it repeats one.
    await reply(chatId, "Got that one already — it's in the Inbox.");
    return new Response("ok");
  }

  // Parsing is a convenience layered on top of a capture that already
  // succeeded -- its failure must never surface as this message's failure.
  let fastConfirmSummary: string | null = null;
  let singleInboxReason: string | null = null;
  const multiItemSummaries: string[] = [];
  // Each saved item of a message of several, for the numbered list.
  const savedItems: SavedItem[] = [];
  // Items of a message of several that could not be saved: named in the
  // reply, so they can be sent again, rather than counted as captured.
  const unsavedItems: string[] = [];
  const guessedDates: string[] = [];
  // What was saved of each undated item, to check against the records
  // already made (alreadyRecordedNote).
  const savedUndated: Array<{ parsed_account_id: string | null; parsed_amount: number | string | null; parsed_merchant: string | null; parsed_date: string | null; date_guessed: boolean }> = [];
  let itemsRead = false;
  let dividendsLeftOut = 0;
  // Read in full, with no expense, income or refund in it and no receipt to
  // read by eye: the entry is set aside and the reply says so.
  let nothingFound = false;
  let kept: NonNullable<ReturnType<typeof datedItems>> = [];
  try {
    // Nothing is filed under a savings category as spending, nor under a
    // group with categories within it (fileableCategories).
    const categories = await loadFileableCategories(member.household_id);

    const parsedItems = await parseIntakeWithAI({
      rawText,
      imageBase64: photoBase64,
      imageMime: photoMime,
      categoryNames: categories.map((c) => c.label),
      householdId: member.household_id,
      memberId: member.id,
    });
    const items = parsedItems ? datedItems(parsedItems, householdToday(), forwardedDay(message)) : null;
    itemsRead = (items?.length ?? 0) > 0;
    if (parsedItems && parsedItems.length === 0 && !photoPath) {
      // Said only once the entry is set aside: if that write fails it still
      // waits in the Inbox, and the ordinary reply says so.
      const { error: asideError } = await supabase.from("intake").update({ status: "rejected" }).eq("id", inserted.id);
      nothingFound = !asideError;
    }

    // A dividend typed in as income is never captured (docs/decisions.md,
    // "Dividends are their own records"): it is recorded from the holding's
    // own records, and logged as income too it would count twice. The
    // message's words decide only for a message of one item; otherwise each
    // item's own merchant does, so "salary 7000, dividend 700" keeps the
    // salary.
    const readsAsDividendIncome = (item: NonNullable<typeof items>[number]) =>
      item.kind === "income" && (readsAsDividend(item.merchant) || (items!.length === 1 && readsAsDividend(rawText)));
    // Only a household with a share the feeds cover records its dividends
    // there; elsewhere, or if that cannot be read, a dividend is income as
    // before.
    let guarded = false;
    if ((items ?? []).some(readsAsDividendIncome)) {
      const { data: payers, error: payersError } = await supabase
        .from("holdings")
        .select("id")
        .eq("household_id", member.household_id)
        .in("asset_class", DIVIDEND_CLASSES)
        .limit(1);
      guarded = !payersError && (payers?.length ?? 0) > 0;
    }
    kept = guarded ? (items ?? []).filter((item) => !readsAsDividendIncome(item)) : (items ?? []);
    dividendsLeftOut = (items?.length ?? 0) - kept.length;
    if (dividendsLeftOut > 0 && !kept.length) {
      await supabase.from("intake").update({ status: "rejected" }).eq("id", inserted.id);
    }

    // A message can describe more than one expense ("bought two plants for
    // 260 and 50") -- the first item updates the row already inserted
    // above, and each additional item gets its OWN new intake row rather
    // than being summed or dropped, which is what used to happen when only
    // a single amount was ever extracted. Each item's own DB work is
    // wrapped separately so one item's failure (a bad category/account
    // lookup) never costs the others.
    const knowledge = kept.length ? await loadCategoryKnowledge(member.household_id) : { rules: [], history: [] };
    for (let i = 0; i < kept.length; i++) {
      const item = kept[i];
      try {
        const matchedCategory =
          (await matchCategoryFromMerchantHistory(knowledge, item.merchant, categories)) ??
          categoryByName(categories, item.categoryName);
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
          date_guessed: item.dateGuessed,
        };

        let savedId: string | null = null;
        if (i === 0) {
          await supabase.from("intake").update(updatedRow).eq("id", inserted.id);
          savedId = inserted.id;
        } else {
          // The write's own error, not only a thrown one: a refused insert
          // used to be counted as captured, so "2 expenses captured" was said
          // of one (round 2 of the outside review). A duplicate source_ref is
          // this item saved by an earlier attempt.
          const { data: itemRow, error: itemError } = await supabase.from("intake").insert({
            household_id: member.household_id,
            member_id: member.id,
            source: "telegram",
            source_ref: `${updateId}#${i}`,
            raw_text: rawText,
            photo_path: photoPath,
            status: "pending",
            ...updatedRow,
          }).select("id").single();
          if (itemError && itemError.code !== "23505") {
            unsavedItems.push(`AED ${Number(item.amount ?? 0).toFixed(2)}${item.merchant ? ` at ${item.merchant}` : ""}`);
            continue;
          }
          if (itemRow) savedId = itemRow.id;
          else {
            const { data: earlier } = await supabase.from("intake").select("id").eq("household_id", member.household_id).eq("source_ref", `${updateId}#${i}`).maybeSingle();
            savedId = earlier?.id ?? null;
          }
        }
        // An item whose row cannot be named is left off the list; it waits
        // in the Inbox all the same.
        if (savedId) savedItems.push({ id: savedId, row: updatedRow, accountName: matchedAccount?.name ?? null, categoryName: matchedCategory?.name ?? null });
        // Only a saved item's date is reported: one that failed to save is
        // named to be sent again, not told its date was guessed.
        if (item.dateGuessed) {
          guessedDates.push(item.occurred_at!);
          savedUndated.push(updatedRow);
        }

        if (kept.length === 1) {
          singleInboxReason = inboxReason(updatedRow);
          // Same bar as the fast-confirm "yes" path above: only invite it
          // when account, category, currency and date are all already
          // resolved, not just when the model's own confidence is high --
          // and only when it doesn't look like something already recorded.
          // Multiple items in one message always go to the Inbox instead --
          // one "yes" confirming several different amounts at once is its
          // own source of mistakes.
          if (isReadyForFastConfirm(updatedRow)) {
            const duplicate = await findDuplicateTransaction(member.household_id, updatedRow.parsed_account_id, item.merchant, item.amount, item.occurred_at);
            singleInboxReason = inboxReason(updatedRow, duplicate);
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

  if (dividendsLeftOut > 0 && !kept.length) {
    await reply(chatId, DIVIDEND_GUARD_REPLY);
    return new Response("ok");
  }
  if (nothingFound) {
    await reply(chatId, NOT_AN_EXPENSE_REPLY);
    return new Response("ok");
  }
  const dividendNote = dividendsLeftOut > 0 ? " I left out the dividend: Rokda records dividends from your shares' own records, not as income." : "";

  if (fastConfirmSummary) {
    // fastConfirmSummary is only ever set for a single-item message, whose one
    // item is the row inserted above -- so that is the intake this prompt is
    // about. A multi-item message deliberately offers no fast confirm at all.
    await sendFastConfirmPrompt(
      chatId,
      inserted.id,
      `Got it — ${fastConfirmSummary}. Everything matched, so reply "yes" to record it, or edit in the Inbox.${dividendNote}`
    );
  } else if (routingFailed && !itemsRead) {
    await reply(chatId, AI_BUSY_REPLY);
  } else {
    const n = multiItemSummaries.length;
    // Best-effort: a note that cannot be worked out is left off, and the
    // Inbox marks the repeats all the same.
    const recordedNote = await alreadyRecordedNote(member.household_id, savedUndated).catch(() => "");
    const unsavedNote = unsavedItems.length
      ? ` I couldn't save ${unsavedItems.join(", ")}: send ${unsavedItems.length === 1 ? "it" : "them"} again.`
      : "";
    // Several entries read in full: a numbered list to finish them here
    // (batchReview.ts). Otherwise, or if it cannot be worked out, the Inbox.
    if (kept.length > 1) {
      const listed = await sendBatchList(chatId, member.household_id, savedItems, [unsavedNote.trim(), dividendNote.trim()]).catch(() => false);
      if (listed) {
        // Up to three entries missing only a category or card are asked
        // about with buttons (choices.ts); any more wait in the Inbox.
        let asked = 0;
        for (const s of savedItems) {
          if (asked >= 3) break;
          if (await sendChoicePrompt(chatId, member.household_id, member.id, { id: s.id, ...s.row })) asked++;
        }
        return new Response("ok");
      }
    }
    // One entry missing only its category or card: asked with buttons.
    if (kept.length === 1 && savedItems.length === 1 && (await sendChoicePrompt(chatId, member.household_id, member.id, { id: savedItems[0].id, ...savedItems[0].row }))) {
      return new Response("ok");
    }
    await reply(
      chatId,
      (n > 1 || (n === 1 && unsavedItems.length)
        ? `Got it — ${n} ${n === 1 ? "expense" : "expenses"} captured (${multiItemSummaries.join(", ")}). Check the Inbox to review ${n === 1 ? "it" : "each"}.`
        : singleInboxReason ?? "Got it — check the Inbox to review.") + unsavedNote + undatedNote(guessedDates, n > 1 ? n : 1) + recordedNote + dividendNote
    );
  }
  return new Response("ok");
}


// The last line of defence. Nothing below Deno.serve used to catch, so any
// exception reached the runtime, which prints the error and its whole cause
// chain -- how the bot token could reach the logs. Anything that still escapes
// is recorded as metadata only.
Deno.serve(async (req) => {
  try {
    return await handleRequest(req);
  } catch (err) {
    logFailure("request", null, err);
    return new Response("error", { status: 500 });
  }
});
