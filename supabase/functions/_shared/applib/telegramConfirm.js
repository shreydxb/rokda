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

// Returns one of:
//   { kind: 'one', row }         -- confirm exactly this entry
//   { kind: 'none' }             -- confirm nothing
//   { kind: 'ambiguous', rows }  -- several possible, ask rather than guess
//
//   `bound`   the intake carrying the prompt this confirmation was aimed at,
//             looked up by (confirm_chat_id, confirm_message_id) -- or null
//             when nothing was aimed at, or when the database says no such
//             prompt exists.
//   `recent`  the member's recent intakes, for the unaddressed case only.
//
// The caller MUST resolve `bound` with a direct lookup, not by searching
// `recent`. That distinction is the whole correctness argument here, and
// getting it wrong is how the original bug came back in a narrower form:
// `recent` is capped and time-windowed, so searching it cannot tell "you
// replied to something that was never a prompt" apart from "you replied to a
// prompt I did not happen to fetch". Treating the second as the first falls
// through to the unaddressed rule and confirms a DIFFERENT entry -- which is
// precisely QA #2. intake_confirm_prompt_idx exists for that lookup.
export function resolveConfirmTarget({ bound = null, recent = [] } = {}) {
  if (bound) {
    // A reply aimed at a prompt we sent is unambiguous, so it is honoured
    // however old it is and however many other entries are waiting. If that
    // entry is no longer confirmable -- already approved, or edited in the
    // Inbox until it needs review -- this stops rather than moving on to
    // another row. The member named an entry; a different one is not a better
    // answer than none.
    return isConfirmable(bound) ? { kind: 'one', row: bound } : { kind: 'none' };
  }

  const ready = (recent ?? []).filter(isConfirmable);
  if (ready.length === 0) return { kind: 'none' };
  if (ready.length === 1) return { kind: 'one', row: ready[0] };
  // The case that used to silently pick one. Recency is not evidence about
  // which entry a bare "yes" meant, and money is recorded on the other side of
  // this decision.
  return { kind: 'ambiguous', rows: ready };
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
