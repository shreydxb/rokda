// How many wrong link tokens a stranger gets (QA #8).
//
// The webhook secret authenticates the TRANSPORT -- it proves Telegram sent
// the request. It says nothing about who is behind the message, and an
// attacker messaging the bot from their own unlinked account arrives with a
// perfectly valid secret header because Telegram put it there. Nothing counted
// their attempts, so the only limit on guessing a six-digit code was
// Telegram's delivery rate, for the code's whole fifteen-minute life.
//
// The token is now 122 bits (see the telegram_link_token migration), which is
// the actual fix. This is the part that does not rest on an entropy argument.
// It is pure so the limits are testable; index.ts counts the rows.

// One token's lifetime: a window longer than that would punish someone for
// failures against a token that no longer exists.
export const LINK_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// Generous for a person copying a token and mean for a program.
export const LINK_ATTEMPTS_PER_SENDER = 5;

// A second Telegram account costs an attacker nothing, so a per-sender limit
// alone moves the work rather than stopping it. Set well above anything a
// two-person household produces by mistyping.
export const LINK_ATTEMPTS_GLOBAL = 50;

// Returns what to say back when this sender may not try again, or null when
// they may.
//
// Counts that could not be read come in as null and are treated as zero: the
// token carries the security here, and a bookkeeping table being unavailable
// is not a reason to stop the household linking a phone.
export function linkAttemptRefusal({ sender, global }) {
  if ((sender ?? 0) >= LINK_ATTEMPTS_PER_SENDER) {
    return 'Too many incorrect codes. Wait 15 minutes, then generate a fresh code in Settings → Household and send that.';
  }
  if ((global ?? 0) >= LINK_ATTEMPTS_GLOBAL) {
    // Deliberately says nothing about a global limit. Naming it would tell an
    // attacker their traffic is being counted, and is no use to the member.
    return 'Linking is temporarily unavailable. Please try again in a few minutes.';
  }
  return null;
}

// Is this text even shaped like a token? 32 hex characters, as
// generate_telegram_link_code() produces.
//
// This decides what counts as a failed ATTEMPT, and the distinction matters
// for the person, not the attacker. Every non-empty message from an unlinked
// sender used to be counted, so somebody told "message the bot" who sent
// "hi", "hello?", "how do I link this" had burned three of their five
// attempts before they ever had a token -- and the refusal they eventually
// hit says "too many incorrect codes", about codes they never entered.
//
// Nothing is given up by ignoring the rest. A string that is not 32 hex
// characters cannot match a token that always is, so it was never a guess;
// counting it only ever punished the one person the throttle is not for.
export function looksLikeLinkToken(text) {
  return /^[0-9a-f]{32}$/i.test(String(text ?? '').trim());
}

// A Telegram deep link (https://t.me/<bot>?start=<token>) arrives as
// "/start <token>". The token is short enough to be a deep-link payload, so
// both shapes are accepted and a link in Settings would work without touching
// the handler again.
export function linkTokenFromMessage(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('/start')) return trimmed.slice('/start'.length).trim();
  return trimmed;
}
