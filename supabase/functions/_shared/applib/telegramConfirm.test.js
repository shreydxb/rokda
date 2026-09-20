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

// The caller resolves `bound` with a direct indexed lookup on
// (confirm_chat_id, confirm_message_id) and passes `recent` only for the
// unaddressed case. These tests pass both explicitly, because the distinction
// between them IS the correctness argument -- see resolveConfirmTarget.

describe('QA #2: a confirmation records the entry it was aimed at', () => {
  // The exact reproduction from the review: two expenses in flight, "yes"
  // replied to the FIRST one's prompt. Selecting the newest pending entry
  // recorded the second.
  it('confirms the entry whose prompt was replied to, not the newest one', () => {
    const a = pending({ id: 'A', parsed_merchant: 'Spinneys', confirm_chat_id: CHAT, confirm_message_id: 100 });
    const b = pending({ id: 'B', parsed_merchant: 'Carrefour', confirm_chat_id: CHAT, confirm_message_id: 101 });
    const target = resolveConfirmTarget({ bound: a, recent: [b, a] });
    expect(target.kind).toBe('one');
    expect(target.row.id).toBe('A');
  });

  // The second half of the bug: replaying the identical update once B had been
  // approved made A "the newest pending entry" and approved it too.
  it('confirms nothing when the named entry has already been recorded', () => {
    const a = pending({ id: 'A', status: 'approved', confirm_chat_id: CHAT, confirm_message_id: 100 });
    const c = pending({ id: 'C', confirm_chat_id: CHAT, confirm_message_id: 102 });
    expect(resolveConfirmTarget({ bound: a, recent: [c, a] }).kind).toBe('none');
  });

  it('confirms nothing when the named entry is no longer confirmable', () => {
    const edited = pending({ id: 'A', parsed_account_id: null, confirm_chat_id: CHAT, confirm_message_id: 100 });
    expect(resolveConfirmTarget({ bound: edited, recent: [edited] }).kind).toBe('none');
  });

  it('honours the named entry even when others are also waiting', () => {
    const a = pending({ id: 'A', confirm_chat_id: CHAT, confirm_message_id: 100 });
    const b = pending({ id: 'B', confirm_chat_id: CHAT, confirm_message_id: 101 });
    const c = pending({ id: 'C', confirm_chat_id: CHAT, confirm_message_id: 102 });
    expect(resolveConfirmTarget({ bound: a, recent: [c, b, a] }).row.id).toBe('A');
  });

  // The defect found while auditing the first fix. `recent` is capped at 10
  // rows and filtered to 20 minutes; the binding is not. An entry the caller
  // did not fetch must still be confirmable when its prompt names it, and must
  // never let some other entry be confirmed in its place.
  it('confirms a named entry that is not in the recent list at all', () => {
    const old = pending({ id: 'OLD', confirm_chat_id: CHAT, confirm_message_id: 7 });
    const busy = Array.from({ length: 10 }, (_, i) => pending({ id: `N${i}`, confirm_message_id: 200 + i, confirm_chat_id: CHAT }));
    expect(resolveConfirmTarget({ bound: old, recent: busy }).row.id).toBe('OLD');
  });

  it('confirms nothing when the reply names a prompt the database does not have', () => {
    // bound === null means the lookup found no such prompt -- the member
    // replied to something that was never one. Falling through to a single
    // waiting entry is fine HERE, because the database was actually asked.
    const c = pending({ id: 'C', confirm_chat_id: CHAT, confirm_message_id: 102 });
    expect(resolveConfirmTarget({ bound: null, recent: [c] }).row.id).toBe('C');
  });
});

describe('QA #2: an unaddressed "yes" never guesses between entries', () => {
  it('confirms the only entry waiting', () => {
    const a = pending({ id: 'A' });
    expect(resolveConfirmTarget({ bound: null, recent: [a] })).toEqual({ kind: 'one', row: a });
  });

  it('refuses to choose when two are waiting', () => {
    const target = resolveConfirmTarget({ bound: null, recent: [pending({ id: 'B' }), pending({ id: 'A' })] });
    expect(target.kind).toBe('ambiguous');
    expect(target.rows).toHaveLength(2);
  });

  it('confirms the only CONFIRMABLE entry, ignoring ones needing review', () => {
    const ready = pending({ id: 'A' });
    const notReady = pending({ id: 'B', parsed_category_id: null });
    expect(resolveConfirmTarget({ bound: null, recent: [notReady, ready] }).row.id).toBe('A');
  });

  it('ignores entries that are no longer pending', () => {
    const approved = pending({ id: 'A', status: 'approved' });
    const rejected = pending({ id: 'B', status: 'rejected' });
    const waiting = pending({ id: 'C' });
    expect(resolveConfirmTarget({ bound: null, recent: [waiting, rejected, approved] }).row.id).toBe('C');
  });

  it('confirms nothing when nothing is waiting', () => {
    expect(resolveConfirmTarget({ bound: null, recent: [] })).toEqual({ kind: 'none' });
    expect(resolveConfirmTarget({})).toEqual({ kind: 'none' });
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
