import { describe, it, expect } from 'vitest';
import { marketOf, sharePayments, shareFrequency, todayFactor, usualGapDays } from './dividendHistory';

// A listed event of a share, as dividend_events holds it.
let n = 0;
const event = (symbol, ex_date, amount, extra = {}) => ({
  id: `e-${symbol}-${ex_date}-${(n += 1)}`, symbol, ex_date, amount, pay_date: null, superseded_by: null, missed_checks: 0, ...extra,
});

describe('marketOf', () => {
  it('names the market a share is listed in', () => {
    expect(marketOf({ asset_class: 'india_equity' })).toBe('IN');
    expect(marketOf({ asset_class: 'us_equity' })).toBe('US');
    expect(marketOf({ asset_class: 'intl_equity' })).toBe('US');
    expect(marketOf({ asset_class: 'uae_equity' })).toBeNull();
  });
});

describe("today's basis", () => {
  const splits = [{ symbol: 'ABC', effective_date: '2026-06-01', ratio: 10 }, { symbol: 'XYZ', effective_date: '2026-07-01', ratio: 2 }];

  it("a past amount is put on today's basis by the splits after it", () => {
    expect(todayFactor('ABC', '2026-03-01', splits)).toBe(10);
    // A split taking effect on the ex-date itself is the ex-date's own basis.
    expect(todayFactor('ABC', '2026-06-01', splits)).toBe(1);
    expect(todayFactor('ABC', '2026-07-01', splits)).toBe(1);
    const [p] = sharePayments([event('ABC', '2026-03-01', 10)], 'ABC', { splits, specialParts: [], today: '2026-11-03' });
    expect(p.todayAmount).toBe(1);
    expect(p.ordinaryToday).toBe(1);
  });

  it('leaves out events the source replaced, dropped or has not yet paid', () => {
    const events = [
      event('ABC', '2026-01-10', 1),
      event('ABC', '2026-02-10', 1, { superseded_by: 'e-other' }),
      event('ABC', '2026-03-10', 1, { missed_checks: 2 }),
      event('ABC', '2026-12-10', 1),
      event('XYZ', '2026-01-10', 1),
    ];
    expect(sharePayments(events, 'ABC', { splits: [], specialParts: [], today: '2026-11-03' }).map((p) => p.exDate)).toEqual(['2026-01-10']);
  });
});

describe('one-offs', () => {
  const quarterly = () => [event('ABC', '2025-03-14', 1), event('ABC', '2025-06-14', 1), event('ABC', '2025-09-14', 1), event('ABC', '2025-12-14', 5)];

  it("a candidate one-off: its excess is left out until answered, and the answer then rules", () => {
    const events = quarterly();
    const last = (specialParts) => sharePayments(events, 'ABC', { splits: [], specialParts, today: '2026-01-10' }).at(-1);
    expect(last([])).toMatchObject({ oneOff: 'candidate', special: 4, ordinary: 1, ordinaryToday: 1 });
    expect(last([{ event_id: events[3].id, special_per_share: 0 }])).toMatchObject({ oneOff: 'answered', special: 0, ordinary: 5 });
    expect(last([{ event_id: events[3].id, special_per_share: 3 }])).toMatchObject({ oneOff: 'answered', special: 3, ordinary: 2 });
  });

  it('is not a candidate with fewer than three earlier payments', () => {
    const events = quarterly().slice(1);
    const last = sharePayments(events, 'ABC', { splits: [], specialParts: [], today: '2026-01-10' }).at(-1);
    expect(last).toMatchObject({ oneOff: null, special: 0, ordinary: 5 });
  });
});

describe('frequency', () => {
  const monthsBack = (count, step, from = '2026-10-15') => {
    const [y, m, d] = from.split('-').map(Number);
    return Array.from({ length: count }, (_, i) => {
      const date = new Date(Date.UTC(y, m - 1 - i * step, d));
      return { ...sharePayments([event('ABC', date.toISOString().slice(0, 10), 1)], 'ABC', { splits: [], specialParts: [], today: '2026-11-03' })[0] };
    }).reverse();
  };

  it('frequency over 24 months, or what the source covers', () => {
    expect(shareFrequency(monthsBack(8, 3), '2010-01-01', '2026-11-03')).toEqual({ kind: 'quarterly', perYear: 4, intervalMonths: 3 });
    expect(shareFrequency(monthsBack(4, 3), '2025-11-01', '2026-11-03')).toMatchObject({ kind: 'quarterly', intervalMonths: 3 });
    expect(shareFrequency(monthsBack(1, 3), '2026-05-01', '2026-11-03').kind).toBe('too_new');
    expect(shareFrequency(monthsBack(5, 4), '2010-01-01', '2026-11-03').kind).toBe('irregular');
    expect(shareFrequency(monthsBack(24, 1), '2010-01-01', '2026-11-03')).toEqual({ kind: 'monthly', perYear: 12, intervalMonths: 1 });
    expect(shareFrequency([], '2010-01-01', '2026-11-03').kind).toBe('none');
  });

  it('a one-off counts only for its ordinary part, and a wholly special payment not at all', () => {
    const payments = monthsBack(4, 6).map((p, i) => (i === 3 ? { ...p, ordinary: 0, ordinaryToday: 0 } : p));
    expect(shareFrequency(payments, '2010-01-01', '2026-11-03').perYear).toBe(1.5);
  });
});

describe('the usual gap from ex-date to payment', () => {
  it('is the median of known gaps, else 30 days', () => {
    const p = (exDate, payDate) => ({ exDate, payDate });
    expect(usualGapDays([p('2026-01-01', '2026-01-21'), p('2026-04-01', '2026-05-01'), p('2026-07-01', '2026-08-10')])).toBe(30);
    expect(usualGapDays([p('2026-01-01', '2026-01-11'), p('2026-04-01', '2026-04-13')])).toBe(11);
    expect(usualGapDays([p('2026-01-01', null)])).toBe(30);
    expect(usualGapDays([])).toBe(30);
  });
});
