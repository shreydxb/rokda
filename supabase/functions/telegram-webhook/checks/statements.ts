// Part of the Telegram webhook (index.ts), split out by responsibility in
// the round 2 cleanup (SHR-383). Moved, not changed.
import { householdDay, householdToday } from "../../_shared/applib/day.js";
import { statementAlreadySettledMessage, statementAnswer, statementDoneMessage, statementLookupFailedMessage, statementNotSavedMessage, statementNotYetMessage, statementQuestion, statementSentMessage } from "../../_shared/applib/statementReminder.js";
import { closedStatementDates, isoDay, statementDueDate, statementPeriodStart } from "../../_shared/applib/statements.js";
import { openProposals } from "../confirmations.ts";
import { supabase } from "../env.ts";
import { reply, tgCall } from "../transport.ts";
import { prefEnabled, telegramPrefsMap } from "./recipients.ts";

// ---------------------------------------------------------------------------
// Card statements wait to be reconciled (docs/decisions.md, "A statement is
// reconciled, and Rokda records it")
// ---------------------------------------------------------------------------
//
// From the day after a card's statement closes, the morning check asks
// whether it has been reconciled, and asks again each morning until a member
// says it has (or a reconciliation is recorded some other way, or the next
// statement closes). The statement's own row in statement_reconciliations
// holds the state: no proposal, because nothing is applied on a "yes" except
// marking the statement done.
//
// Each question is kept with the chat and member it was sent to
// (asked_prompts). Telegram numbers messages per chat, so a message id alone
// names a message in every member's chat at once: an answer counts only from
// the chat the question was asked in.

export type StatementPrompt = { chat_id: number; message_id: number; member_id: string };

export type StatementRow = {
  id: string;
  household_id: string;
  account_id: string;
  statement_date: string;
  due_date: string | null;
  status: string;
  asked_prompts: StatementPrompt[] | null;
  last_asked_on: string | null;
  accounts?: { name?: string } | null;
};

export const STATEMENT_COLUMNS = "id, household_id, account_id, statement_date, due_date, status, asked_prompts, last_asked_on, accounts(name)";


export async function runStatementCheck(): Promise<{ checked: number; asked: number }> {
  const now = new Date();
  const today = householdDay(now);
  const todayStr = householdToday(now);
  const [{ data: cards }, prefs] = await Promise.all([
    supabase
      .from("accounts")
      .select("id, household_id, name, owner_member_id, is_shared, statement_day, due_day")
      .eq("type", "credit_card")
      .is("archived_at", null)
      .not("statement_day", "is", null),
    telegramPrefsMap(),
  ]);

  let checked = 0;
  let asked = 0;
  for (const card of (cards ?? []) as Array<{ id: string; household_id: string; name: string; owner_member_id: string | null; is_shared: boolean; statement_day: number; due_day: number | null }>) {
    if (!prefEnabled(prefs, card.household_id, "statement_enabled")) continue;
    const [close] = closedStatementDates(card.statement_day, today, 1);
    if (!close) continue;
    checked++;
    try {
      const statementDate = isoDay(close);
      const due = card.due_day ? statementDueDate(close, card.due_day) : null;
      // 23505 on the insert means another run created it first; either way
      // the row is read back below.
      await supabase.from("statement_reconciliations").insert({
        household_id: card.household_id,
        account_id: card.id,
        statement_date: statementDate,
        period_start: isoDay(statementPeriodStart(card.statement_day, close)),
        due_date: due ? isoDay(due) : null,
      });
      const { data: found, error } = await supabase
        .from("statement_reconciliations")
        .select(STATEMENT_COLUMNS)
        .eq("account_id", card.id)
        .eq("statement_date", statementDate)
        .maybeSingle();
      const row = found as StatementRow | null;
      if (error || !row || row.status !== "waiting" || row.last_asked_on === todayStr) continue;

      const { data: members } = await supabase
        .from("household_members")
        .select("id, telegram_user_id")
        .eq("household_id", card.household_id);
      const recipients = ((members ?? []) as Array<{ id: string; telegram_user_id: number | null }>)
        .filter((m) => m.telegram_user_id != null && (card.is_shared || !card.owner_member_id || m.id === card.owner_member_id));
      const askedBefore = row.last_asked_on != null;
      const text = statementQuestion({ cardName: card.name, statementDate, dueDate: row.due_date }, { reminder: askedBefore });
      const sent: StatementPrompt[] = [];
      for (const m of recipients) {
        try {
          const chatId = Number(m.telegram_user_id);
          const messageId = await reply(chatId, text);
          if (messageId != null) sent.push({ chat_id: chatId, message_id: messageId, member_id: m.id });
        } catch {
          // One member unreachable must not stop the other.
        }
      }
      if (sent.length === 0) continue;
      // A question is only answerable once it is tied to its statement: a
      // reply or a 👍 finds the statement by the question it answers. If that
      // can't be saved (one retry), or the statement stopped waiting while
      // the question went out, the question is withdrawn rather than left
      // where "done" would settle nothing, and tomorrow's run asks again
      // (QA, 17 October). Same rule as a bot proposal's question.
      const binding = { asked_prompts: [...(row.asked_prompts ?? []), ...sent], last_asked_on: todayStr, updated_at: new Date().toISOString() };
      const bind = () => supabase.from("statement_reconciliations").update(binding).eq("id", row.id).eq("status", "waiting").select("id");
      let bound = await bind();
      if (bound.error) bound = await bind();
      if (bound.error || !bound.data?.length) {
        for (const p of sent) await tgCall("deleteMessage", { chat_id: p.chat_id, message_id: p.message_id }).catch(() => {});
        continue;
      }
      asked++;
    } catch {
      // One card failing must never block the rest.
    }
  }
  return { checked, asked };
}


// The statement a message of the bot's asked about, if it was one: the
// question sent to this chat with this message id. "failed" when that could
// not be read, which is never taken as "not a statement question".
export type StatementLookup = { kind: "found"; row: StatementRow } | { kind: "none" } | { kind: "failed" };


export async function statementForPrompt(householdId: string, chatId: number, messageId: number | null): Promise<StatementLookup> {
  if (messageId == null) return { kind: "none" };
  const { data, error } = await supabase
    .from("statement_reconciliations")
    .select(STATEMENT_COLUMNS)
    .eq("household_id", householdId)
    .contains("asked_prompts", JSON.stringify([{ chat_id: chatId, message_id: messageId }]))
    .limit(2);
  if (error) return { kind: "failed" };
  const rows = (data ?? []) as StatementRow[];
  // A chat's message is one question, so two rows means something is wrong
  // with the records: nothing is settled on a guess.
  if (rows.length > 1) return { kind: "failed" };
  return rows.length === 1 ? { kind: "found", row: rows[0] } : { kind: "none" };
}


// Statements still waiting that the bot has asked this member about. A
// statement only the other member was asked about (their own card) is not
// this member's to answer with a bare "done".
export async function waitingStatements(householdId: string, memberId: string): Promise<{ rows: StatementRow[]; failed: boolean }> {
  const { data, error } = await supabase
    .from("statement_reconciliations")
    .select(STATEMENT_COLUMNS)
    .eq("household_id", householdId)
    .eq("status", "waiting")
    .contains("asked_prompts", JSON.stringify([{ member_id: memberId }]))
    .limit(10);
  if (error) return { rows: [], failed: true };
  return { rows: (data ?? []) as StatementRow[], failed: false };
}


export async function decideStatement(chatId: number, memberId: string, row: StatementRow, decision: "done" | "not_yet" | "sent"): Promise<void> {
  const cardName = row.accounts?.name ?? "card";
  if (decision === "not_yet") {
    await reply(chatId, statementNotYetMessage(cardName));
    return;
  }
  // Handed over to be checked is not checked: the statement stays waiting,
  // and the bot keeps asking until someone says it is done.
  if (decision === "sent") {
    await reply(chatId, statementSentMessage(cardName));
    return;
  }
  const now = new Date().toISOString();
  const { data: saved, error } = await supabase
    .from("statement_reconciliations")
    .update({ status: "confirmed", closed_at: now, closed_by_member_id: memberId, updated_at: now })
    .eq("id", row.id)
    .eq("status", "waiting")
    .select("id");
  // Thanked only for what was written. A refused write leaves it waiting,
  // and the member is told so rather than told it is done.
  if (error) {
    await reply(chatId, statementNotSavedMessage(cardName));
    return;
  }
  if ((saved ?? []).length > 0) {
    await reply(chatId, statementDoneMessage(cardName, row.statement_date));
    return;
  }
  // Nothing written: it was no longer waiting (the other member answered, or
  // it was marked in the app). Say what it is now.
  const { data: current, error: readError } = await supabase.from("statement_reconciliations").select("status").eq("id", row.id).maybeSingle();
  const status = (current as { status?: string } | null)?.status;
  if (readError || !status || status === "waiting") {
    await reply(chatId, statementNotSavedMessage(cardName));
    return;
  }
  await reply(chatId, statementAlreadySettledMessage(cardName, row.statement_date, status));
}


// A typed answer to a statement question. A reply to one of its messages is
// answered whatever it says that the reader understands. A bare message is
// only taken as an answer when it says "done", "reconciled" and the like
// (not a plain "yes", which the expense and proposal questions own), and
// only when exactly one statement this member was asked about is waiting and
// nothing else is.
export const STATEMENT_WORD = /\b(done|reconciled|checked|completed|complete|finished|sent|uploaded|shared)\b/i;


export async function handleStatementText(chatId: number, member: { id: string; household_id: string }, text: string, repliedTo: number | null): Promise<boolean> {
  const decision = statementAnswer(text);
  if (!decision) return false;
  if (repliedTo != null) {
    const found = await statementForPrompt(member.household_id, chatId, repliedTo);
    if (found.kind === "none") return false;
    if (found.kind === "failed") {
      await reply(chatId, statementLookupFailedMessage());
      return true;
    }
    await decideStatement(chatId, member.id, found.row, decision);
    return true;
  }
  if (!STATEMENT_WORD.test(text)) return false;
  const [waiting, open] = await Promise.all([waitingStatements(member.household_id, member.id), openProposals(member.household_id, member.id)]);
  if (waiting.failed) {
    await reply(chatId, statementLookupFailedMessage());
    return true;
  }
  if (waiting.rows.length === 0) return false;
  if (waiting.rows.length > 1 || open.rows.length > 0 || open.failed) {
    await reply(chatId, "I'm waiting on more than one answer. Reply to the statement message you mean.");
    return true;
  }
  await decideStatement(chatId, member.id, waiting.rows[0], decision);
  return true;
}
