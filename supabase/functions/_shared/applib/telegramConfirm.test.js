import { describe, expect, it } from 'vitest';
import {
  ambiguousConfirmMessage,
  isConfirmationText,
  isReadyForFastConfirm,
  resolveConfirmTarget,
} from './telegramConfirm.js';

const CHAT = 4242;

function pending(overrides = {}) {
  return {
    id: 'i1',
    parsed_merchant: 'Carrefour',
    parsed_amount: 42,
    parsed_date: '2026-09-20',
    parsed_category_id: 'c1',
    parsed_account_id: 'a1',
    parsed_currency: 'AED',
    parsed_kind: 'expense',
    confidence: 0.95,
    status: 'pending',
    confirm_chat_id: null,
    confirm_message_id: null,
    ...overrides,
  };
}

describe('QA #2: a confirmation records the entry it was aimed at', () => {
  // The exact reproduction from the review: two expenses in flight, "yes"
  // replied to the FIRST one's prompt. Selecting the newest pending entry
  // recorded the second.
  it('confirms the entry whose prompt was replied to, not the newest one', () => {
    const a = pending({ id: 'A', parsed_merchant: 'Spinneys', confirm_chat_id: CHAT, confirm_message_id: 100 });
    const b = pending({ id: 'B', parsed_merchant: 'Carrefour', confirm_chat_id: CHAT, confirm_message_id: 101 });
    // Newest first, as the query returns them.
    const target = resolveConfirmTarget([b, a], CHAT, 100);
    expect(target.kind).toBe('one');
    expect(target.row.id).toBe('A');
  });

  it('confirms the entry a reaction was placed on', () => {
    const a = pending({ id: 'A', confirm_chat_id: CHAT, confirm_message_id: 100 });
    const b = pending({ id: 'B', confirm_chat_id: CHAT, confirm_message_id: 101 });
    expect(resolveConfirmTarget([b, a], CHAT, 101).row.id).toBe('B');
  });

  // The second half of the bug: replaying the identical update once B had been
  // approved made A "the newest pending entry" and approved it too. The
  // update-id gate in the webhook stops the replay from reaching here at all,
  // and this stops the reply from ever meaning a different entry if it did.
  it('confirms nothing when the named entry has already been recorded', () => {
    // A's own prompt, replayed after A was approved. The old handler treated
    // "A is gone" as licence to approve whatever was newest -- which is how
    // one redelivered "yes" recorded a second expense.
    const a = pending({ id: 'A', status: 'approved', confirm_chat_id: CHAT, confirm_message_id: 100 });
    const c = pending({ id: 'C', confirm_chat_id: CHAT, confirm_message_id: 102 });
    expect(resolveConfirmTarget([c, a], CHAT, 100).kind).toBe('none');
  });

  it('ignores entries that are no longer pending when nothing was named', () => {
    const approved = pending({ id: 'A', status: 'approved' });
    const rejected = pending({ id: 'B', status: 'rejected' });
    const waiting = pending({ id: 'C' });
    expect(resolveConfirmTarget([waiting, rejected, approved], CHAT, null).row.id).toBe('C');
  });

  it('falls through to the unaddressed rule when the reply names nothing of ours', () => {
    // Replying to one of their OWN earlier messages carries no target, so the
    // single waiting entry is still confirmable -- this is the ordinary case
    // where a client auto-quotes and the member did not mean anything by it.
    const c = pending({ id: 'C', confirm_chat_id: CHAT, confirm_message_id: 102 });
    expect(resolveConfirmTarget([c], CHAT, 77).row.id).toBe('C');
  });

  it('confirms nothing when the named entry is no longer confirmable', () => {
    const edited = pending({ id: 'A', parsed_account_id: null, confirm_chat_id: CHAT, confirm_message_id: 100 });
    expect(resolveConfirmTarget([edited], CHAT, 100).kind).toBe('none');
  });

  it('honours the named entry even when others are also waiting', () => {
    const a = pending({ id: 'A', confirm_chat_id: CHAT, confirm_message_id: 100 });
    const b = pending({ id: 'B', confirm_chat_id: CHAT, confirm_message_id: 101 });
    const c = pending({ id: 'C', confirm_chat_id: CHAT, confirm_message_id: 102 });
    expect(resolveConfirmTarget([c, b, a], CHAT, 100).row.id).toBe('A');
  });

  it('ignores a prompt id from a different chat', () => {
    const a = pending({ id: 'A', confirm_chat_id: 9999, confirm_message_id: 100 });
    // Not this chat's prompt, so it carries no target -- but A is the only
    // entry waiting, so the unaddressed rule still resolves it.
    expect(resolveConfirmTarget([a], CHAT, 100).row.id).toBe('A');
  });
});

describe('QA #2: an unaddressed "yes" never guesses between entries', () => {
  it('confirms the only entry waiting', () => {
    const a = pending({ id: 'A' });
    expect(resolveConfirmTarget([a], CHAT, null)).toEqual({ kind: 'one', row: a });
  });

  it('refuses to choose when two are waiting', () => {
    const a = pending({ id: 'A' });
    const b = pending({ id: 'B' });
    const target = resolveConfirmTarget([b, a], CHAT, null);
    expect(target.kind).toBe('ambiguous');
    expect(target.rows).toHaveLength(2);
  });

  it('confirms the only CONFIRMABLE entry, ignoring ones needing review', () => {
    const ready = pending({ id: 'A' });
    const notReady = pending({ id: 'B', parsed_category_id: null });
    expect(resolveConfirmTarget([notReady, ready], CHAT, null).row.id).toBe('A');
  });

  it('confirms nothing when nothing is waiting', () => {
    expect(resolveConfirmTarget([], CHAT, null)).toEqual({ kind: 'none' });
    expect(resolveConfirmTarget(undefined, CHAT, null)).toEqual({ kind: 'none' });
  });

  it('names every candidate so the member can pick one', () => {
    const rows = [pending({ id: 'A', parsed_merchant: 'Spinneys', parsed_amount: 42 }), pending({ id: 'B', parsed_amount: 17.5 })];
    const msg = ambiguousConfirmMessage(rows);
    expect(msg).toContain('2 entries waiting');
    expect(msg).toContain('AED 42.00 at Spinneys');
    expect(msg).toContain('AED 17.50 at Carrefour');
  });
});

describe('fast-confirm eligibility', () => {
  it('requires a matched account and category, not just model confidence', () => {
    expect(isReadyForFastConfirm(pending())).toBe(true);
    expect(isReadyForFastConfirm(pending({ parsed_account_id: null }))).toBe(false);
    expect(isReadyForFastConfirm(pending({ parsed_category_id: null }))).toBe(false);
    expect(isReadyForFastConfirm(pending({ confidence: 0.84 }))).toBe(false);
  });

  it('refuses a non-AED entry, which the fast path would record as dirhams', () => {
    expect(isReadyForFastConfirm(pending({ parsed_currency: 'INR' }))).toBe(false);
    expect(isReadyForFastConfirm(pending({ parsed_currency: null }))).toBe(true);
  });
});

describe('what counts as a confirmation', () => {
  it('accepts a bare yes and a thumbs up', () => {
    for (const t of ['yes', 'Yes.', 'y', 'yep', 'ok', 'do it', '\u{1F44D}', '✅']) {
      expect(isConfirmationText(t)).toBe(true);
    }
  });

  it('rejects a message that merely starts with yes', () => {
    expect(isConfirmationText('yes I know, also spent 40 on lunch')).toBe(false);
    expect(isConfirmationText('')).toBe(false);
    expect(isConfirmationText(null)).toBe(false);
  });
});
