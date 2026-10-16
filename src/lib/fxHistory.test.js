import { describe, it, expect } from 'vitest';
import { estimateAed, historyRowsFromEcb, inrPerAedOn } from './fxHistory';

const history = [
  { base: 'AED', quote: 'INR', day: '2026-09-01', rate: 23 },
  { base: 'AED', quote: 'INR', day: '2026-09-05', rate: 24 },
  { base: 'USD', quote: 'INR', day: '2026-09-06', rate: 99 },
];

describe('inrPerAedOn', () => {
  it("takes the day's rate, or the latest before it", () => {
    expect(inrPerAedOn(history, '2026-09-05')).toEqual({ rate: 24, day: '2026-09-05' });
    expect(inrPerAedOn(history, '2026-09-07')).toEqual({ rate: 24, day: '2026-09-05' });
    expect(inrPerAedOn(history, '2026-09-03')).toEqual({ rate: 23, day: '2026-09-01' });
    expect(inrPerAedOn(history, '2026-08-31')).toBeNull();
  });
});

describe('estimateAed', () => {
  it("converts rupees at the payment's own date", () => {
    expect(estimateAed(-23000, 'INR', '2026-09-02', history)).toEqual({ aed: -1000, rate: 23, rateDay: '2026-09-01', source: 'history' });
  });

  it("falls back to today's rate only before history begins, and says so", () => {
    expect(estimateAed(2500, 'INR', '2026-01-01', history, 25)).toEqual({ aed: 100, rate: 25, rateDay: null, source: 'current' });
  });

  it('never guesses a rate it does not have', () => {
    expect(estimateAed(2500, 'INR', '2026-01-01', [], null)).toBeNull();
    expect(estimateAed(10, 'EUR', '2026-09-02', history)).toBeNull();
  });

  it('converts dollars at the peg', () => {
    expect(estimateAed(40, 'USD', '2026-09-02', [])).toMatchObject({ aed: 146.9, source: 'peg' });
  });
});

describe('historyRowsFromEcb', () => {
  it('turns rupees per dollar into rupees per dirham through the peg, skipping unusable days', () => {
    const rows = historyRowsFromEcb({ rates: { '2026-09-02': { INR: 88.1 }, '2026-09-01': { INR: 73.45 }, bad: { INR: 1 }, '2026-09-03': {} } });
    expect(rows).toEqual([
      { base: 'AED', quote: 'INR', day: '2026-09-01', rate: 20, source: 'ecb' },
      { base: 'AED', quote: 'INR', day: '2026-09-02', rate: 23.989108, source: 'ecb' },
    ]);
    expect(historyRowsFromEcb(null)).toEqual([]);
  });
});
