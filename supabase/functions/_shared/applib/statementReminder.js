// Asking about a card statement over Telegram (docs/decisions.md, "A
// statement is reconciled, and Rokda records it").
//
// From the day after a card's statement closes, the bot asks each morning
// whether it has been reconciled, until someone says it has. This file words
// the question and reads the answer; index.ts does the asking and records it
// in statement_reconciliations. Bot-only, like autopay.js.
import { autopayReactionDecision, shortDay } from './autopay.js';

/**
 * @param {{ cardName: string, statementDate: string, dueDate?: string | null }} statement
 * @param {{ reminder?: boolean }} [options]
 */
export function statementQuestion(statement, { reminder = false } = {}) {
  const due = statement.dueDate ? ` Payment is due ${shortDay(statement.dueDate)}.` : '';
  if (reminder) {
    return (
      `Reminder: the ${statement.cardName} statement from ${shortDay(statement.statementDate)} hasn't been reconciled yet.${due}\n` +
      'Reply "done" or react 👍 once it is, and I\'ll stop asking.'
    );
  }
  return (
    `Your ${statement.cardName} statement closed on ${shortDay(statement.statementDate)}.${due}\n` +
    'Send the PDF to Claude to reconcile it against Rokda, then reply "done" here or react 👍. ' +
    'Reply "not yet" and I\'ll ask again tomorrow morning.'
  );
}

const DONE_WORDS = new Set([
  'done', 'reconciled', 'checked', 'completed', 'complete', 'finished', 'sent', 'uploaded', 'shared',
  'yes', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay', 'k', 'sure',
]);
const NOT_WORDS = new Set(['no', 'n', 'nope', 'nah', 'not', 'yet', 'pending', 'later', 'tomorrow', 'still', 'havent', 'hasnt', 'didnt']);
const FILLER_WORDS = new Set([
  'it', 'its', 'is', 'was', 'has', 'have', 'had', 'been', 'already', 'all', 'just', 'now', 'today', 'the', 'a', 'my', 'our', 'this',
  'that', 'statement', 'statements', 'card', 'i', 'ive', 'we', 'weve', 'and', 'also', 'thanks', 'thank', 'you', 'thx', 'ty', 'to', 'claude',
]);
const DONE_EMOJIS = new Set(['👍', '✅', '✔', '☑', '👌', '💯', '🙌']);
const NOT_EMOJIS = new Set(['👎', '❌', '✖', '⏳']);

// What a typed message means as an answer to a statement question: 'done',
// 'not_yet', or null when it is something else. Whole-message, like the
// autopay answers: every word has to be an answer or a filler word, and any
// "not" word makes it "not yet".
export function statementAnswer(text) {
  let s = String(text ?? '').replace(/[\u{1F3FB}-\u{1F3FF}]|️|‍/gu, '').toLowerCase().trim();
  if (!s || s.length > 80) return null;
  s = s.replace(/[’']/g, '').replace(/(\p{Extended_Pictographic})/gu, ' $1 ');
  const tokens = s.split(/[\s,.!?;:()\-–—]+/u).filter(Boolean);
  let done = 0;
  let not = 0;
  for (const token of tokens) {
    if (DONE_EMOJIS.has(token) || DONE_WORDS.has(token)) done += 1;
    else if (NOT_EMOJIS.has(token) || NOT_WORDS.has(token)) not += 1;
    else if (!FILLER_WORDS.has(token)) return null;
  }
  if (not > 0) return 'not_yet';
  return done > 0 ? 'done' : null;
}

// A reaction on one of the questions: the same emoji as an autopay answer.
export function statementReactionDecision(emoji) {
  const decision = autopayReactionDecision(emoji);
  if (decision === 'paid') return 'done';
  return decision;
}

export function statementNotYetMessage(cardName) {
  return `OK, I'll ask about the ${cardName} statement again tomorrow morning.`;
}

export function statementDoneMessage(cardName, statementDate) {
  return `Thanks. The ${cardName} statement from ${shortDay(statementDate)} is marked as reconciled.`;
}
