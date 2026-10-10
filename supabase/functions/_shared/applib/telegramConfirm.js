// Fast-confirm targeting for the Telegram bot: given the entries a member has
// waiting and the message their "yes" (or 👍) was aimed at, decide which entry
// -- if any -- is being confirmed.
//
// Unlike its neighbours in this directory, this has no counterpart under src/:
// nothing in the web app confirms anything by replying to a message. It lives
// here anyway because it is pure, and because the bug it exists to prevent is
// the kind that only a test can keep fixed. index.ts holds the IO; this holds
// the decision.
//
// The bug (QA #2): both confirmation routes used to take the newest pending
// entry. Send expense A, send expense B, reply "yes" to A's prompt, and A's
// confirmation recorded B. Redelivering that same "yes" then recorded A as
// well, because B was no longer pending and A had become "the newest".

// A short, near-exact "yes" -- deliberately strict so a real message that
// happens to start with "yes" ("yes I know, also spent 40 on lunch") is never
// mistaken for confirming a pending entry.
export const CONFIRM_REGEX = /^(yes|y|yep|yeah|confirm|ok|okay|sure|correct|go ahead|do it|record it)[.!]?$/i;

export const THUMBS_UP_EMOJIS = new Set(['\u{1F44D}', '✅']);

export function isConfirmationText(text) {
  const trimmed = String(text ?? '').trim();
  return CONFIRM_REGEX.test(trimmed) || THUMBS_UP_EMOJIS.has(trimmed);
}

// Instant recording (skipping the Inbox entirely) is only offered when every
// field approve_intake actually requires is already resolved with no
// guesswork -- account and category matched, currency AED or unstated, and the
// parser's own confidence high. Confidence alone was never a safe gate for
// this: it only ever reflected the model's certainty about
// merchant/amount/date, never whether an account or category was found, so
// those are checked separately here rather than folded into one fuzzy number.
export function isReadyForFastConfirm(row) {
  return (
    !!row.parsed_merchant &&
    row.parsed_amount != null &&
    Number(row.parsed_amount) > 0 &&
    !!row.parsed_date &&
    // A date the message never gave is a guess: a "yes" would record it as fact.
    !row.date_guessed &&
    !!row.parsed_category_id &&
    !!row.parsed_account_id &&
    (row.parsed_currency == null || row.parsed_currency === 'AED') &&
    Number(row.confidence ?? 0) >= 0.85
  );
}

// Is this entry one a "yes" can record right now? Status matters as much as
// the parsed fields: an entry approved a moment ago in the Inbox is still in
// the window this reads, and is no longer anyone's to confirm.
export function isConfirmable(row) {
  return row?.status === 'pending' && isReadyForFastConfirm(row);
}

// What looking for the prompt a confirmation was aimed at actually found.
// These four are NOT interchangeable, and collapsing any of them into "no
// binding" is how QA #2 keeps coming back:
//
//   unaddressed  nothing was aimed at -- a bare "yes", not a reply. Only this
//                one may fall back to a recent-candidate rule.
//   found        the message replied to is a prompt, and this is its entry.
//   unknown      the message replied to is not a prompt we have. The member
//                addressed SOMETHING; a different entry is not a better
//                answer than none. (A prompt can be superseded: sending a new
//                prompt for an entry overwrites its stored message id, so the
//                old one genuinely has no row.)
//   failed       the lookup itself did not work. We do not know whether a
//                prompt exists, and acting on a guess here would record money
//                on the strength of a database error.
/**
 * Types for TypeScript callers (the webhook imports this file). Without them
 * TypeScript infers parameter types from the defaults below -- `row = null`
 * reads as "row is always null", `recent = []` as `never[]` -- and rejects
 * every real call site. Generic over the caller's own row type, and the
 * result is a discriminated union, so `kind === 'one'` narrows to a row that
 * is guaranteed present rather than `T | null | undefined`.
 *
 * @typedef {{ status?: unknown }} IntakeRow
 */
/**
 * @template {IntakeRow} T
 * @typedef {{ kind: 'one', row: T } | { kind: 'none' } | { kind: 'unknown' } | { kind: 'unavailable' } | { kind: 'ambiguous', rows: T[] }} Target
 */

export const PROMPT_UNADDRESSED = 'unaddressed';
export const PROMPT_FOUND = 'found';
export const PROMPT_UNKNOWN = 'unknown';
export const PROMPT_FAILED = 'failed';

// Returns one of:
//   { kind: 'one', row }         -- confirm exactly this entry
//   { kind: 'none' }             -- confirm nothing, say nothing special
//   { kind: 'unknown' }          -- addressed something that is not a prompt
//   { kind: 'unavailable' }      -- could not check; must not act
//   { kind: 'ambiguous', rows }  -- several possible, ask rather than guess
//
//   `lookup`     one of the four PROMPT_* outcomes above.
//   `row`        the bound intake, when `lookup` is PROMPT_FOUND.
//   `recent`     candidate entries, for the unaddressed case ONLY.
//   `truncated`  true when the candidate query hit its cap, so `recent` might
//                not be all of them.
//
// The caller MUST resolve `lookup` with a direct query on
// (confirm_chat_id, confirm_message_id) -- intake_confirm_prompt_idx exists
// for it -- and must never infer it by searching `recent`. `recent` is
// windowed and capped, so searching it cannot tell "never a prompt" apart
// from "a prompt I did not happen to fetch".
/**
 * @template {IntakeRow} T
 * @param {{ lookup?: string, row?: T | null, recent?: T[], truncated?: boolean }} [input]
 * @returns {Target<T>}
 */
export function resolveConfirmTarget({ lookup = PROMPT_UNADDRESSED, row = null, recent = [], truncated = false } = {}) {
  // Not knowing is not the same as knowing there is nothing. A failed lookup
  // used to be indistinguishable from "no such prompt" because the error was
  // discarded, and it fell through to the unaddressed rule -- confirming an
  // entry the member never named, because a query failed.
  if (lookup === PROMPT_FAILED) return { kind: 'unavailable' };

  if (lookup === PROMPT_FOUND) {
    // A reply aimed at a prompt we sent is unambiguous, so it is honoured
    // however old it is and however many other entries are waiting. If that
    // entry is no longer confirmable -- already approved, or edited in the
    // Inbox until it needs review -- this stops rather than moving on.
    return isConfirmable(row) ? { kind: 'one', row } : { kind: 'none' };
  }

  // Addressed at something we have no prompt for. The one thing this must not
  // do is pick an entry the member did not point at.
  if (lookup === PROMPT_UNKNOWN) return { kind: 'unknown' };

  const ready = (recent ?? []).filter(isConfirmable);
  if (ready.length === 0) return { kind: 'none' };
  // More than one, or a capped list that could be hiding more: either way we
  // cannot prove which entry a bare "yes" meant. Recency is not evidence, and
  // money is recorded on the other side of this decision.
  if (ready.length > 1 || truncated) return { kind: 'ambiguous', rows: ready };
  return { kind: 'one', row: ready[0] };
}

// A correction ("actually 42") has exactly the same targeting problem as a
// confirmation, and had none of the same discipline: it always edited the
// newest pending entry, so replying to A with a correction amended B. The
// only difference is what counts as a candidate -- a correction can amend an
// entry that is merely pending, not one that is ready for fast confirm.
/**
 * @template {IntakeRow} T
 * @param {{ lookup?: string, row?: T | null, recent?: T[], truncated?: boolean }} [input]
 * @returns {Target<T>}
 */
export function resolveCorrectionTarget({ lookup = PROMPT_UNADDRESSED, row = null, recent = [], truncated = false } = {}) {
  if (lookup === PROMPT_FAILED) return { kind: 'unavailable' };
  if (lookup === PROMPT_FOUND) {
    return row?.status === 'pending' ? { kind: 'one', row } : { kind: 'none' };
  }
  if (lookup === PROMPT_UNKNOWN) return { kind: 'unknown' };

  const pending = (recent ?? []).filter((r) => r?.status === 'pending');
  if (pending.length === 0) return { kind: 'none' };
  if (pending.length > 1 || truncated) return { kind: 'ambiguous', rows: pending };
  return { kind: 'one', row: pending[0] };
}

// Said when a reply names a message that is not a prompt we can act on --
// including a prompt that was superseded by a newer one for the same entry.
export function unknownPromptMessage() {
  return "I can't tell which entry that reply is about -- that message isn't a prompt I'm still tracking. Reply to the most recent prompt for the entry you mean, or use the Inbox.";
}

// Said when the lookup itself failed. Deliberately records nothing: the one
// thing worse than not confirming is confirming the wrong entry.
export function lookupUnavailableMessage() {
  return "I couldn't check which entry that's for just now, so I haven't recorded anything. Try again in a moment, or approve it in the Inbox.";
}

// Shown instead of recording anything when a bare "yes" could mean two or more
// pending entries. Naming them is the point: the member can see exactly what is
// waiting and reply to the right prompt.
export function ambiguousConfirmMessage(rows) {
  const list = rows
    .map((r) => `- AED ${Number(r.parsed_amount).toFixed(2)} at ${r.parsed_merchant} on ${r.parsed_date}`)
    .join('\n');
  return `You have ${rows.length} entries waiting, so I don't know which one that "yes" is for:\n${list}\nReply directly to the one you mean (swipe/long-press → Reply), or approve them in the Inbox.`;
}

// ---------------------------------------------------------------------------
// Proposals: balances and goal contributions the bot read from a message and
// waits to have confirmed (bot_proposals). The bot never writes those from a
// message alone: it shows the change, and only a "yes" or a 👍 on that
// message applies it, and only a "no" drops it.
// ---------------------------------------------------------------------------

// As strict as CONFIRM_REGEX, for the same reason: a real message that starts
// with "no" ("no wait, it was 45") is not dropping anything.
export const CANCEL_REGEX = /^(no|n|nope|cancel|stop|drop it|don'?t)[.!]?$/i;

export const CANCEL_EMOJIS = new Set(['❌', '\u{1F44E}']);

export function isCancellationText(text) {
  const trimmed = String(text ?? '').trim();
  return CANCEL_REGEX.test(trimmed) || CANCEL_EMOJIS.has(trimmed);
}

/**
 * @typedef {{ status?: unknown }} ProposalRow
 */
/**
 * @template {ProposalRow} T
 * @typedef {{ kind: 'one', row: T } | { kind: 'decided', row: T } | { kind: 'none' } | { kind: 'unavailable' } | { kind: 'ambiguous' }} ProposalTarget
 */

// Which proposal a "yes" or a "no" is about, if any. Same discipline as
// resolveConfirmTarget, one difference: a reply aimed at a message that is not
// a proposal ('unknown') is not refused here, because it may be aimed at an
// expense's prompt, which the expense rules then decide. Returns:
//   { kind: 'one', row }      -- decide exactly this proposal
//   { kind: 'decided', row }  -- the message named one already applied,
//                                dropped or lapsed; say so, change nothing
//   { kind: 'none' }          -- not about a proposal; the expense rules decide
//   { kind: 'unavailable' }   -- could not check; must not act
//   { kind: 'ambiguous' }     -- several things wait for this answer; ask
//
//   `lookup`, `row`   the proposal whose prompt the message replied to, by a
//                     direct query on (chat_id, prompt_message_id).
//   `open`            the member's open proposals from the last few minutes,
//                     for the unaddressed case only.
//   `openFailed`      true when that query, or the one for `recentlyDecided`,
//                     failed.
//   `recentlyDecided` the member's proposal decided in the last few minutes,
//                     if any: a second bare answer, or a redelivered first
//                     one, is about it once nothing else waits.
//   `readyIntakes`    expenses waiting for their own "yes". With one waiting,
//                     a bare "yes" or "no" could be about either.
//   `truncated`       true when the expense candidates were capped.
/**
 * @template {ProposalRow} T
 * @param {{ lookup?: string, row?: T | null, open?: T[], openFailed?: boolean, recentlyDecided?: T | null, readyIntakes?: unknown[], truncated?: boolean }} [input]
 * @returns {ProposalTarget<T>}
 */
export function resolveProposalTarget({ lookup = PROMPT_UNADDRESSED, row = null, open = [], openFailed = false, recentlyDecided = null, readyIntakes = [], truncated = false } = {}) {
  if (lookup === PROMPT_FAILED) return { kind: 'unavailable' };
  if (lookup === PROMPT_FOUND && row) return row.status === 'proposed' ? { kind: 'one', row } : { kind: 'decided', row };
  if (lookup === PROMPT_UNKNOWN) return { kind: 'none' };

  // Unaddressed. Not knowing whether a proposal waits is not the same as
  // knowing none does: a "yes" must not record an expense on the strength of
  // a failed query when it may have been meant for a balance.
  if (openFailed) return { kind: 'unavailable' };
  const waiting = (open ?? []).filter((p) => p?.status === 'proposed');
  const othersWaiting = (readyIntakes ?? []).length > 0 || truncated;
  if (waiting.length === 0) {
    // Nothing open: the answer repeats one just given, or Telegram delivered
    // it twice. Say what happened to the proposal rather than let the answer
    // be read as a new message -- unless an expense is waiting for it.
    return recentlyDecided && !othersWaiting ? { kind: 'decided', row: recentlyDecided } : { kind: 'none' };
  }
  if (waiting.length > 1 || othersWaiting) return { kind: 'ambiguous' };
  return { kind: 'one', row: waiting[0] };
}

// Said when a bare "yes" or "no" could be about more than one thing waiting.
// The way out depends on the answer: a 👍 saves, so it is offered only to a
// "yes"; someone who said "no" is asked to say it again as a reply.
export function ambiguousProposalMessage(confirming = true) {
  const head = 'More than one thing is waiting for an answer, so I don\'t know which one you mean. ';
  return confirming
    ? `${head}Reply directly to my message about it (swipe or long-press → Reply), or react to it with 👍.`
    : `${head}Reply "no" directly to my message about the one you want to drop (swipe or long-press → Reply).`;
}
