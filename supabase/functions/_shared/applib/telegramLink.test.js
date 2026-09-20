import { describe, expect, it } from 'vitest';
import {
  LINK_ATTEMPTS_GLOBAL,
  LINK_ATTEMPTS_PER_SENDER,
  LINK_ATTEMPT_WINDOW_MS,
  linkAttemptRefusal,
  linkTokenFromMessage,
  looksLikeLinkToken,
} from './telegramLink.js';

// QA #8: a six-digit code, live for fifteen minutes, checked against every
// unlinked sender, with no failed-attempt counter anywhere. The webhook secret
// did not help: an attacker's own Telegram messages carry it because Telegram
// attaches it.
describe('how many wrong tokens a stranger gets', () => {
  it('lets a person who mistypes keep trying', () => {
    expect(linkAttemptRefusal({ sender: 0, global: 0 })).toBeNull();
    expect(linkAttemptRefusal({ sender: LINK_ATTEMPTS_PER_SENDER - 1, global: 0 })).toBeNull();
  });

  it('stops a sender at the limit', () => {
    const refusal = linkAttemptRefusal({ sender: LINK_ATTEMPTS_PER_SENDER, global: 0 });
    expect(refusal).toMatch(/too many incorrect codes/i);
    // Tells them how to recover, since this is far more likely to be a member
    // with a stale code than an attacker.
    expect(refusal).toMatch(/generate a fresh code/i);
  });

  it('stops everyone at the global ceiling, however many accounts are used', () => {
    // A second Telegram account costs an attacker nothing, so a per-sender
    // limit alone moves the work rather than stopping it.
    const refusal = linkAttemptRefusal({ sender: 0, global: LINK_ATTEMPTS_GLOBAL });
    expect(refusal).toMatch(/temporarily unavailable/i);
  });

  it('does not tell an attacker that their traffic is being counted globally', () => {
    const refusal = linkAttemptRefusal({ sender: 0, global: LINK_ATTEMPTS_GLOBAL });
    expect(refusal).not.toMatch(/limit|attempt|rate|count/i);
  });

  it('treats counts it could not read as zero rather than locking the household out', () => {
    // The token carries the security. A bookkeeping table being unavailable is
    // not a reason to stop someone linking a phone.
    expect(linkAttemptRefusal({ sender: null, global: null })).toBeNull();
    expect(linkAttemptRefusal({ sender: undefined, global: undefined })).toBeNull();
  });

  it('counts failures over one token lifetime, not longer', () => {
    // A longer window would punish someone for failures against a token that
    // no longer exists.
    expect(LINK_ATTEMPT_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe('reading a token out of a message', () => {
  it('accepts a token sent on its own', () => {
    expect(linkTokenFromMessage('  0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f  ')).toBe('0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f');
  });

  it('accepts a Telegram deep link, which arrives as /start <token>', () => {
    // The token fits in a deep-link payload, so a link in Settings would work
    // without touching the handler again.
    expect(linkTokenFromMessage('/start 0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f')).toBe('0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f');
  });

  it('yields nothing for a bare /start, so it is not treated as a guess', () => {
    expect(linkTokenFromMessage('/start')).toBe('');
    expect(linkTokenFromMessage('')).toBe('');
    expect(linkTokenFromMessage(null)).toBe('');
  });
});

// Found auditing the QA #8 fix: every non-empty message from an unlinked
// sender was counted as a failed attempt, so a new member who said "hi" a few
// times before generating a token locked themselves out -- and was told "too
// many incorrect codes" about codes they never entered.
describe('what counts as a guess at all', () => {
  it('recognises a real token', () => {
    expect(looksLikeLinkToken('0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f')).toBe(true);
    // gen_random_uuid() renders lowercase, but a copy-paste that upper-cases
    // is still plainly a guess.
    expect(looksLikeLinkToken('0F8CB1E4A2D94F6B8C1E2A3B4C5D6E7F')).toBe(true);
    expect(looksLikeLinkToken('  0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f  ')).toBe(true);
  });

  it('does not count ordinary chatter from someone who has no token yet', () => {
    for (const t of ['hi', 'hello?', 'how do I link this', 'yes', '', null]) {
      expect(looksLikeLinkToken(t)).toBe(false);
    }
  });

  it('does not count a near-miss that could never match a token', () => {
    // Too short, too long, or not hex: none of these can equal a 32-hex
    // token, so none of them was ever a guess.
    expect(looksLikeLinkToken('123456')).toBe(false);
    expect(looksLikeLinkToken('0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7')).toBe(false);
    expect(looksLikeLinkToken('0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7ff')).toBe(false);
    expect(looksLikeLinkToken('zf8cb1e4a2d94f6b8c1e2a3b4c5d6e7f')).toBe(false);
  });

  it('still counts a token-shaped guess, which is the only thing that could be one', () => {
    // The throttle loses nothing by ignoring everything else: an attacker has
    // to send 32 hex characters to have any chance of matching.
    const guess = linkTokenFromMessage('/start 0f8cb1e4a2d94f6b8c1e2a3b4c5d6e7f');
    expect(looksLikeLinkToken(guess)).toBe(true);
  });
});
