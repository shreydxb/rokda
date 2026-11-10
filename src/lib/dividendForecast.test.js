import { describe, it, expect } from 'vitest';
import { sharePayments, shareFrequency, usualGapDays } from './dividendHistory';
import { forecastHolding, nextYearYields } from './dividendForecast';

const TODAY = '2026-11-03';
let n = 0;
const event = (symbol, ex_date, amount, extra = {}) => ({
  id: `e-${(n += 1)}`, symbol, ex_date, amount, pay_date: null, superseded_by: null, missed_checks: 0, ...extra,
});
const holding = (extra = {}) => ({
  id: 'h-abc', name: 'ABC', currency: 'USD', asset_class: 'us_equity', price_symbol: 'ABC', quantity: 10, dividend_tax_pct: 30,
  dividend_fee_per_share: 0, current_price: 50, avg_price: 40, ...extra,
});
// The 15th of each month, going back from October 2026.
const monthly = (count, amount = 1, lastMonthsAgo = 0) => {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9 - lastMonthsAgo - i, 15));
    return event('ABC', d.toISOString().slice(0, 10), amount);
  }).reverse();
};

// The forecast as the tab asks for it: the share's history, its frequency
// and gap, worked out from the same events.
function forecast(events, { h = holding(), declared = [], earnedUnpaid = [], splits = [], coveredFrom = '2010-01-01' } = {}) {
  const payments = sharePayments(events, 'ABC', { splits, specialParts: [], today: TODAY });
  return forecastHolding({
    holding: h, payments, frequency: shareFrequency(payments, coveredFrom, TODAY), gapDays: usualGapDays(payments),
    declared, earnedUnpaid, coveredFrom, today: TODAY,
  });
}

describe('the next twelve months', () => {
  it('one declaration among monthly projections replaces exactly one', () => {
    const declared = [event('ABC', '2026-11-17', 1)];
    const f = forecast(monthly(24), { declared });
    expect(f.status).toBe('ok');
    // Ten, not eleven: October's repeat is paid in November 2027, after the
    // twelve months (October's own payment would be an earned row).
    expect(f.items.filter((i) => i.kind === 'projected')).toHaveLength(10);
    expect(f.items.filter((i) => i.kind === 'declared')).toHaveLength(1);
    // The declared one replaced the projection for November, not another.
    expect(f.items.filter((i) => i.kind === 'projected').map((i) => i.month)).not.toContain('2026-12');
  });

  it('a projected payment is the same ordinary amount a year on, at today\'s units, after withholding and fees', () => {
    const f = forecast(monthly(24), { h: holding({ dividend_fee_per_share: 0.01 }) });
    const first = f.items.find((i) => i.kind === 'projected');
    expect(first).toMatchObject({ gross: 10, withheld: 3, fees: 0.1, net: 6.9, currency: 'USD', day: null });
    // Ex-date 15 Nov 2026 plus the usual 30 days.
    expect(first.month).toBe('2026-12');
    expect(f.next).toEqual({ month: '2026-12' });
    // October's repeat is paid after the twelve months; October's own payment
    // would be an earned row, passed in where the holding earned it.
    expect(f.ordinaryPerShareNextYear).toBe(11);
  });

  // The outside review, B-03: fees never take more than is left after
  // withholding, as the database caps them.
  it('a fee per share bigger than the dividend takes what is left, never more', () => {
    const f = forecast(monthly(24, 0.05), { h: holding({ dividend_fee_per_share: 0.1 }) });
    const first = f.items.find((i) => i.kind === 'projected');
    expect(first).toMatchObject({ gross: 0.5, withheld: 0.15, fees: 0.35, net: 0 });
  });

  // The outside review, B-12: figures in the holding's currency keep four
  // places, as the database keeps them, and are rounded once, in dirhams.
  it('keeps four places in the holding\'s currency, as the database does', () => {
    const f = forecast(monthly(24, 0.1234), { h: holding({ quantity: 7 }) });
    const first = f.items.find((i) => i.kind === 'projected');
    expect(first).toMatchObject({ gross: 0.8638, withheld: 0.2591, fees: 0, net: 0.6047 });
  });

  // The outside review, B-11: only what is paid within the twelve months.
  it('a declared dividend paid after the twelve months is not counted in them', () => {
    const f = forecast(monthly(24), { declared: [event('ABC', '2027-11-20', 3, { pay_date: '2027-12-05' })] });
    expect(f.items.filter((i) => i.kind === 'declared')).toEqual([]);
    expect(f.ordinaryPerShareNextYear).toBe(11);
  });

  // The fresh review of B-11: a declaration paid after the twelve months
  // still replaces its projected twin, or that payment would count in them.
  it('a declaration paid after the twelve months still replaces its projection', () => {
    const today = '2026-11-09';
    const monthly10 = Array.from({ length: 24 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 10 + i, 10));
      return event('ABC', d.toISOString().slice(0, 10), 1);
    });
    const payments = sharePayments(monthly10, 'ABC', { splits: [], specialParts: [], today });
    // Declared for ex-date 10 Oct 2027, paid 15 Nov 2027: after the window
    // ends on 9 Nov 2027. Its projection (10 Oct + 25 days) falls inside it.
    const declared = [event('ABC', '2027-10-10', 1, { pay_date: '2027-11-15' })];
    const f = forecastHolding({ holding: holding(), payments, frequency: shareFrequency(payments, '2010-01-01', today), gapDays: 25, declared, earnedUnpaid: [], today });
    expect(f.items.filter((i) => i.kind === 'declared')).toEqual([]);
    expect(f.items.some((i) => i.kind === 'projected' && i.month === '2027-11')).toBe(false);
  });

  // The outside review, B-13: the next payment is the earliest one, dated or not.
  it('the next payment is a projected month when it comes before a declared day', () => {
    const quarterly = ['2025-12-01', '2026-03-01', '2026-06-01', '2026-09-01'].map((d) => event('ABC', d, 1));
    const f = forecast(quarterly, { declared: [event('ABC', '2027-02-01', 1, { pay_date: '2027-02-20' })] });
    // December's repeat is paid in December 2026 (ex-date plus 30 days), before February.
    expect(f.items[0]).toMatchObject({ kind: 'projected', month: '2026-12' });
    expect(f.next).toEqual({ month: '2026-12' });
  });

  it('a declared dividend counts in full, on its pay date', () => {
    const f = forecast(monthly(24), { declared: [event('ABC', '2026-11-17', 3, { pay_date: '2026-12-01' })] });
    expect(f.items.find((i) => i.kind === 'declared')).toMatchObject({ day: '2026-12-01', gross: 30, net: 21 });
    expect(f.next).toEqual({ day: '2026-12-01' });
  });

  it('a split after the last payment does not inflate the projection', () => {
    const events = [event('ABC', '2025-03-15', 10), event('ABC', '2026-03-15', 10)];
    const f = forecast(events, { h: holding({ quantity: 100 }), splits: [{ symbol: 'ABC', effective_date: '2026-06-01', ratio: 10 }] });
    const projected = f.items.filter((i) => i.kind === 'projected');
    expect(projected).toHaveLength(1);
    expect(projected[0].gross).toBe(100);
  });

  it('a holding sold to nothing keeps its earned dividend and is not projected', () => {
    const earned = { id: 'd-1', status: 'earned', ex_date: '2026-10-15', pay_date: '2026-11-20', expected_gross: 10, expected_tax: 3, expected_fees: 0, expected_net: 7 };
    const f = forecast(monthly(24), { h: holding({ quantity: 0 }), earnedUnpaid: [earned] });
    expect(f.status).toBe('not_held');
    expect(f.items).toEqual([expect.objectContaining({ kind: 'earned', dividendId: 'd-1', day: '2026-11-20', net: 7 })]);
  });

  it('stopped paying, not enough history and irregular each say so instead of a zero', () => {
    const stopped = forecast(monthly(21, 1, 3));
    expect(stopped.status).toBe('may_have_stopped');
    expect(stopped.items).toEqual([]);

    const young = forecast([event('ABC', '2026-08-15', 1)], { coveredFrom: '2026-05-01' });
    expect(young.status).toBe('not_enough_history');
    expect(young.items).toEqual([]);

    const lumpy = ['2026-10-15', '2026-06-15', '2026-02-15', '2025-10-15', '2025-06-15'].map((d) => event('ABC', d, 1));
    const irregular = forecast(lumpy);
    expect(irregular.status).toBe('irregular');
    expect(irregular.items).toEqual([expect.objectContaining({ kind: 'irregular', day: null, month: null, gross: 25 })]);
  });
});

describe('earned and projected', () => {
  it('an earned dividend does not add a fifth quarterly payment', () => {
    // Ex-dates on the 1st of February, May, August and November, paid on the
    // 28th. November's is earned and not paid yet: it is the one counted, and
    // next November's is paid after the twelve months end.
    const quarterly = ['2024-11-01', '2025-02-01', '2025-05-01', '2025-08-01', '2025-11-01', '2026-02-01', '2026-05-01', '2026-08-01', '2026-11-01']
      .map((d) => event('ABC', d, 1, { pay_date: `${d.slice(0, 8)}28` }));
    const earnedUnpaid = [{ id: 'd-nov', ex_date: '2026-11-01', pay_date: '2026-11-28', per_share: 1, expected_gross: 10, expected_tax: 3, expected_fees: 0, expected_net: 7 }];
    const f = forecast(quarterly, { earnedUnpaid });
    expect(f.items.map((i) => i.kind)).toEqual(['earned', 'projected', 'projected', 'projected']);
    expect(f.items.filter((i) => i.kind === 'projected').map((i) => i.month)).toEqual(['2027-02', '2027-05', '2027-08']);
    // The yield reads the same either side of the ex-date: four payments a share.
    expect(f.ordinaryPerShareNextYear).toBe(4);
  });

  // The outside review, B-04: an earned dividend's amount a share is on the
  // basis of its ex-date; after a split it is put on today's, like the rest.
  it('an earned dividend from before a split counts on today\'s basis in the yield', () => {
    const quarterly = ['2024-11-01', '2025-02-01', '2025-05-01', '2025-08-01', '2025-11-01', '2026-02-01', '2026-05-01', '2026-08-01', '2026-11-01']
      .map((d) => event('ABC', d, 2, { pay_date: `${d.slice(0, 8)}28` }));
    const earnedUnpaid = [{ id: 'd-nov', ex_date: '2026-11-01', pay_date: '2026-11-28', per_share: 2, expected_gross: 20, expected_tax: 6, expected_fees: 0, expected_net: 14 }];
    const f = forecast(quarterly, { earnedUnpaid, h: holding({ quantity: 20 }), splits: [{ symbol: 'ABC', effective_date: '2026-11-02', ratio: 2 }] });
    // Two a share before the split is one a share now: four a year, not five.
    expect(f.ordinaryPerShareNextYear).toBe(4);
  });
});

// Round 2 of the outside review (B2-2): an earned dividend paid after the
// twelve months was counted in them, and in the yield. It is still owed, and
// Coming up lists it from the record itself.
describe('earned and paid after the twelve months', () => {
  it('is not counted in the next twelve months, and one paid just inside them is', () => {
    const quarterly = ['2025-11-01', '2026-02-01', '2026-05-01', '2026-08-01'].map((d) => event('ABC', d, 1, { pay_date: `${d.slice(0, 8)}28` }));
    const late = { id: 'd-late', ex_date: '2026-11-01', pay_date: '2027-11-04', per_share: 1, expected_gross: 10, expected_tax: 3, expected_fees: 0, expected_net: 7 };
    const without = forecast(quarterly);
    const withLate = forecast(quarterly, { earnedUnpaid: [late] });
    expect(withLate.items.map((i) => i.dividendId).filter(Boolean)).toEqual([]);
    expect(withLate.ordinaryPerShareNextYear).toBe(without.ordinaryPerShareNextYear);
    const inside = forecast(quarterly, { earnedUnpaid: [{ ...late, id: 'd-inside', pay_date: '2027-11-03' }] });
    expect(inside.items.map((i) => i.dividendId).filter(Boolean)).toEqual(['d-inside']);
  });
});

describe('yields', () => {
  it('yields on value and on cost, and none without a price or an average', () => {
    expect(nextYearYields(holding(), 2)).toEqual({ onValue: 0.04, onCost: 0.05 });
    expect(nextYearYields(holding({ current_price: null }), 2)).toEqual({ onValue: null, onCost: 0.05 });
    expect(nextYearYields(holding({ avg_price: 0 }), 2)).toEqual({ onValue: 0.04, onCost: null });
    expect(nextYearYields(holding(), 0)).toEqual({ onValue: 0, onCost: 0 });
  });
});
