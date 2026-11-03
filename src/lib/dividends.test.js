import { describe, it, expect } from 'vitest';
import { canRecord, dividendRefusalMessage, dividendRow, dividendStatusText, dividendsOfHolding, movementLines, reviewText } from './dividends';

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
    for (const code of ['not_member', 'dividend_not_found', 'holding_not_found', 'bad_input', 'bad_figures', 'currency_mismatch', 'fund_archived', 'already_linked', 'already_recorded', 'credited_in_future', 'wrong_status']) {
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

describe('dividendRow', () => {
  const accounts = [{ id: 'f-usd', name: 'Dollar funds' }];
  const row = {
    status: 'received', currency: 'USD', ex_date: '2026-10-15', pay_date: '2026-10-20', credited_on: '2026-10-21', units: 40, per_share: 0.25,
    expected_net: 7, received_net: 6.8, paid_into_account_id: 'f-usd',
  };

  it('puts the date and the net first, then the status, sum, credit and destination', () => {
    expect(dividendRow(row, accounts, '2026-11-02')).toEqual({
      title: '15 Oct · USD 6.80',
      detail: 'Received · 40 × USD 0.25 · credited 21 Oct · into Dollar funds',
    });
  });

  it('shows what is expected until it is received, its pay date, and the year when it is not this one', () => {
    const earned = { ...row, status: 'earned', credited_on: null, received_net: null, ex_date: '2025-03-14', pay_date: '2025-04-01' };
    expect(dividendRow(earned, accounts, '2026-11-02')).toEqual({
      title: '14 Mar 2025 · USD 7.00',
      detail: 'Earned · 40 × USD 0.25 · paid 1 Apr 2025 · into Dollar funds',
    });
  });

  it('keeps a small amount per share whole, and says when nothing is set to pay into', () => {
    const small = { ...row, per_share: 0.0625, paid_into_account_id: null };
    expect(dividendRow(small, accounts, '2026-11-02').detail).toBe('Received · 40 × USD 0.0625 · credited 21 Oct · no account to pay into');
  });
});

describe('movementLines', () => {
  it('says what each fund gains or loses', () => {
    expect(movementLines([
      { account_name: 'Dollar funds', currency: 'USD', delta: 7 },
      { account_name: 'Other funds', currency: 'USD', delta: -2 },
    ])).toEqual(['Adds USD 7.00 to Dollar funds', 'Takes USD 2.00 from Other funds']);
  });

  it('says when no balance moves', () => {
    expect(movementLines([])).toEqual(['Moves no balance']);
    expect(movementLines(null)).toEqual(['Moves no balance']);
  });
});
