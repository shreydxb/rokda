import { describe, it, expect } from 'vitest';
import { canRecord, dividendRefusalMessage, dividendStatusText, dividendsOfHolding, reviewText } from './dividends';

describe('dividendsOfHolding', () => {
  it("keeps that holding's rows, newest first by ex-date or, without one, credit date", () => {
    const rows = [
      { id: 'a', holding_id: 'h1', ex_date: '2026-03-01', credited_on: '2026-03-20' },
      { id: 'b', holding_id: 'h2', ex_date: '2026-09-01', credited_on: null },
      { id: 'c', holding_id: 'h1', ex_date: null, credited_on: '2026-06-10' },
      { id: 'd', holding_id: 'h1', ex_date: '2026-08-15', credited_on: null },
    ];
    expect(dividendsOfHolding(rows, 'h1').map((r) => r.id)).toEqual(['d', 'c', 'a']);
  });

  it('has nothing for no rows', () => {
    expect(dividendsOfHolding(null, 'h1')).toEqual([]);
  });
});

describe('dividendStatusText', () => {
  it('names each status', () => {
    expect(dividendStatusText({ status: 'earned' })).toBe('Earned');
    expect(dividendStatusText({ status: 'received' })).toBe('Received');
    expect(dividendStatusText({ status: 'presumed' })).toBe('Presumed received, not checked');
    expect(dividendStatusText({ status: 'skipped' })).toBe('Skipped');
  });
});

describe('reviewText', () => {
  it('says why a row is flagged, in one sentence', () => {
    expect(reviewText({ review_reason: 'trades_changed' })).toBe('A trade changed the units held on the ex-date after this was recorded.');
    expect(reviewText({ review_reason: 'feed_changed' })).toBe("The feed's amount per share has changed since this was recorded.");
    expect(reviewText({ review_reason: 'moved_ex_date' })).toBe('The feed no longer lists this dividend on this date.');
    expect(reviewText({ review_reason: 'possible_duplicate' })).toBe('The feed has a dividend close to this date. Is it this one?');
    expect(reviewText({ review_reason: 'split_on_ex_date' })).toBe('A split took effect on this ex-date, so its units may be on the wrong basis.');
  });

  it('is null for a row not flagged', () => {
    expect(reviewText({ review_reason: null })).toBeNull();
    expect(reviewText({})).toBeNull();
  });
});

describe('canRecord', () => {
  it('records one earned, or a presumed one to mark it checked', () => {
    expect(canRecord({ status: 'earned' })).toBe(true);
    expect(canRecord({ status: 'presumed' })).toBe(true);
    expect(canRecord({ status: 'received' })).toBe(false);
    expect(canRecord({ status: 'skipped' })).toBe(false);
  });
});

describe('dividendRefusalMessage', () => {
  it('gives one sentence for each refusal', () => {
    expect(dividendRefusalMessage('stale')).toBe('This dividend changed since you opened it. Check it again.');
    expect(dividendRefusalMessage('fund_confirmed_since')).toBe("The fund's balance was confirmed since you checked. Check again.");
    expect(dividendRefusalMessage('needs_answer')).toBe("Say whether this was already in the fund's confirmed balance.");
    for (const code of ['not_member', 'dividend_not_found', 'holding_not_found', 'bad_input', 'bad_figures', 'currency_mismatch', 'fund_archived', 'already_linked', 'already_recorded', 'wrong_status']) {
      const sentence = dividendRefusalMessage(code);
      expect(sentence, code).not.toBe('That could not be saved. Nothing was changed.');
      expect(sentence, code).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('falls back for a refusal it does not know', () => {
    expect(dividendRefusalMessage('something_new')).toBe('That could not be saved. Nothing was changed.');
    expect(dividendRefusalMessage(undefined)).toBe('That could not be saved. Nothing was changed.');
  });
});
