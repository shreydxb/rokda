// Asking about a card statement over Telegram (docs/decisions.md, "A
// statement is reconciled, and Rokda records it").
//
// The morning after a card's statement closes, the bot asks whether it has
// been reconciled, and reminds once three days before the payment is due (or
// ten days after the close, with no due date). Then it stops: the statement
// stays open in Wealth -> Statements. It used to ask every morning until
// someone answered, which was most of what the bot sent (the feature review,
// November 2026). This file words the question, decides when to ask, and
// reads the answer; checks/statements.ts does the asking and records it in
// statement_reconciliations. Bot-only, like autopay.js.
import { autopayReactionDecision, shortDay } from './autopay.js';
import { parseDay } from './day.js';

const REMIND_DAYS_BEFORE_DUE = 3;
const REMIND_DAYS_AFTER_CLOSE = 10;

function shiftIso(iso, days) {
  const d = parseDay(iso);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Whether this morning's check asks about a waiting statement: 'first' when
// it has never been asked, 'reminder' once on or after the reminder day if it
// was last asked before it, otherwise null. A first question already on or
// after the reminder day is the only one.
/**
 * @param {{ statementDate: string, dueDate?: string | null, lastAskedOn: string | null }} statement
 * @param {string} today
 * @returns {'first' | 'reminder' | null}
 */
export function statementAskDue(statement, today) {
  if (!statement.lastAskedOn) return 'first';
  const remindOn = statement.dueDate ? shiftIso(statement.dueDate, -REMIND_DAYS_BEFORE_DUE) : shiftIso(statement.statementDate, REMIND_DAYS_AFTER_CLOSE);
  return today >= remindOn && statement.lastAskedOn < remindOn ? 'reminder' : null;
}

/**
 * @param {{ cardName: string, statementDate: string, dueDate?: string | null }} statement
 * @param {{ reminder?: boolean }} [options]
 */
export function statementQuestion(statement, { reminder = false } = {}) {
  const due = statement.dueDate ? ` Payment is due ${shortDay(statement.dueDate)}.` : '';
  if (reminder) {
    return (
      `Reminder: the ${statement.cardName} statement from ${shortDay(statement.statementDate)} hasn't been reconciled yet.${due}\n` +
      'Reply "done" or react 👍 once it is. I won\'t ask again: it stays open in Wealth -> Statements.'
    );
  }
  return (
    `Your ${statement.cardName} statement closed on ${shortDay(statement.statementDate)}.${due}\n` +
    'Send the PDF to Claude to reconcile it against Rokda, then reply "done" here or react 👍 once it has been checked. ' +
    'I\'ll remind you once more before it\'s due.'
  );
}

// Words that say the statement has been checked.
const DONE_WORDS = new Set(['done', 'reconciled', 'checked', 'completed', 'complete', 'finished']);
// Words that say it has been handed over to be checked, which is not the same:
// the figures may not have been compared yet, so the bot keeps asking.
const SENT_WORDS = new Set(['sent', 'uploaded', 'shared', 'forwarded', 'emailed']);
// A plain "yes" to the question. On its own it answers "has it been
// reconciled?"; next to a sent word ("yes, sent it") it says only that.
const ACK_WORDS = new Set(['yes', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay', 'k', 'sure']);
const NOT_WORDS = new Set(['no', 'n', 'nope', 'nah', 'not', 'yet', 'pending', 'later', 'tomorrow', 'still', 'havent', 'hasnt', 'didnt']);
const FILLER_WORDS = new Set([
  'it', 'its', 'is', 'was', 'has', 'have', 'had', 'been', 'already', 'all', 'just', 'now', 'today', 'the', 'a', 'my', 'our', 'this',
  'that', 'statement', 'statements', 'card', 'i', 'ive', 'we', 'weve', 'and', 'also', 'thanks', 'thank', 'you', 'thx', 'ty', 'to', 'claude',
]);
const DONE_EMOJIS = new Set(['👍', '✅', '✔', '☑', '👌', '💯', '🙌']);
const NOT_EMOJIS = new Set(['👎', '❌', '✖', '⏳']);

// What a typed message means as an answer to a statement question: 'done',
// 'sent' (handed over to be checked, not yet checked), 'not_yet', or null when
// it is something else. Whole-message, like the autopay answers: every word
// has to be an answer or a filler word, and any "not" word makes it "not yet".
export function statementAnswer(text) {
  let s = String(text ?? '').replace(/[\u{1F3FB}-\u{1F3FF}]|️|‍/gu, '').toLowerCase().trim();
  if (!s || s.length > 80) return null;
  s = s.replace(/[’']/g, '').replace(/(\p{Extended_Pictographic})/gu, ' $1 ');
  const tokens = s.split(/[\s,.!?;:()\-–—]+/u).filter(Boolean);
  let done = 0;
  let sent = 0;
  let ack = 0;
  let not = 0;
  for (const token of tokens) {
    if (DONE_EMOJIS.has(token) || DONE_WORDS.has(token)) done += 1;
    else if (SENT_WORDS.has(token)) sent += 1;
    else if (ACK_WORDS.has(token)) ack += 1;
    else if (NOT_EMOJIS.has(token) || NOT_WORDS.has(token)) not += 1;
    else if (!FILLER_WORDS.has(token)) return null;
  }
  if (not > 0) return 'not_yet';
  if (done > 0) return 'done';
  if (sent > 0) return 'sent';
  return ack > 0 ? 'done' : null;
}

// A reaction on one of the questions: the same emoji as an autopay answer.
export function statementReactionDecision(emoji) {
  const decision = autopayReactionDecision(emoji);
  if (decision === 'paid') return 'done';
  return decision;
}

export function statementNotYetMessage(cardName) {
  return `OK. The ${cardName} statement stays open in Wealth -> Statements, and I'll remind you once before it's due if it still is.`;
}

// A member said it is done: recorded as confirmed, which is not the same as
// reconciled (checked line by line against the statement's own figures), so
// the reply does not say reconciled.
export function statementDoneMessage(cardName, statementDate) {
  return `Thanks. The ${cardName} statement from ${shortDay(statementDate)} is marked as done.`;
}

export function statementSentMessage(cardName) {
  return `Thanks. The ${cardName} statement stays open until it has been checked against Rokda. Reply "done" once it has.`;
}

// Which statement a message answers could not be read: nothing changed.
export function statementLookupFailedMessage() {
  return "I couldn't check which statement that's for just now, so nothing has changed. Please answer again in a minute.";
}

// The answer could not be saved: nothing changed, and the member is told so.
export function statementNotSavedMessage(cardName) {
  return `I couldn't save that for the ${cardName} statement, so it is still waiting. Please answer again in a minute, or mark it in Wealth -> Statements.`;
}

// The statement was no longer waiting when the answer came: say what it is,
// rather than that this answer settled it.
export function statementAlreadySettledMessage(cardName, statementDate, status) {
  const which = `The ${cardName} statement from ${shortDay(statementDate)}`;
  if (status === 'reconciled') return `${which} has already been reconciled.`;
  if (status === 'mismatch') return `${which} was checked and doesn't match Rokda. Resolve it in Wealth -> Statements.`;
  return `${which} is already marked as done.`;
}
