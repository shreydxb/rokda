import { describe, expect, it } from 'vitest';
import { cashCoverLine, day, facts, money, notCounted } from './botFormat.js';

// The bot's one format (the revamp, phase 8; review T17): "AED 1,234",
// decimals only when not zero; "3 Oct", the year only when not this year;
// "·" between facts.
describe('money', () => {
  it('drops decimals that are zero, and keeps two otherwise', () => {
    expect(money(42)).toBe('AED 42');
    expect(money(2050)).toBe('AED 2,050');
    expect(money(42.5)).toBe('AED 42.50');
    expect(money(1234.5)).toBe('AED 1,234.50');
    expect(money('42.004')).toBe('AED 42');
  });

  it('prints the currency it was given (T18), and rupees grouped as rupees are', () => {
    expect(money(1234, 'usd')).toBe('USD 1,234');
    expect(money(100000, 'INR')).toBe('INR 1,00,000');
  });

  // The fresh review of 8a: a minus before the code, as the bot's trade
  // messages write it; no "-0"; and an amount that isn't a number says so
  // rather than reading as zero or "NaN".
  it('puts a minus before the code, and never writes -0', () => {
    expect(money(-42)).toBe('−AED 42');
    expect(money(-1234.5)).toBe('−AED 1,234.50');
    expect(money(-0.004)).toBe('AED 0');
  });

  it('says an amount that is not a number is not known', () => {
    expect(money(undefined)).toBe('AED amount not known');
    expect(money(null)).toBe('AED amount not known');
    expect(money('abc', 'USD')).toBe('USD amount not known');
  });
});

describe('day', () => {
  it('gives the day and month, and the year only when not this year', () => {
    expect(day('2026-10-03', '2026-11-23')).toBe('3 Oct');
    expect(day('2025-09-19', '2026-11-23')).toBe('19 Sep 2025');
  });

  // The fresh review of 8a: a moment is read as the household's day (Dubai),
  // not the UTC one.
  it("reads a moment as the household's day", () => {
    expect(day('2026-12-31T21:00:00Z', '2027-01-01')).toBe('1 Jan');
    expect(day('2026-09-19T08:00:00Z', '2026-11-23')).toBe('19 Sep');
  });
});

describe('facts', () => {
  it('joins what is there with ·', () => {
    expect(facts('Bakery', null, 'AED 42', '', undefined, 'Groceries')).toBe('Bakery · AED 42 · Groceries');
  });
});

// What a total leaves out, in a few words for a ⚠ line (review T24).
describe('notCounted', () => {
  it('names what is left out, or nothing', () => {
    expect(notCounted({ accounts: 1 })).toBe('1 account not converted');
    expect(notCounted({ accounts: 2, holdings: 1 })).toBe('2 accounts not converted · 1 holding not valued');
    expect(notCounted({})).toBeNull();
  });
});


// Cash cover in the bot's words (the revamp, phase 8c): the figures and a
// verdict on one line, every caveat on a ⚠ line, by the rules of the app's
// sentence (cashCover.js formatCashCoverLine, QA #4).
describe('cashCoverLine', () => {
  const base = { liquidAed: 5000, dueAed: 7000, days: 7, covered: false, certain: true, shortfallAed: 2000, unvalued: 0, unvaluedDue: 0 };

  it('gives the figures and the verdict', () => {
    expect(cashCoverLine(base)).toBe('Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · short by AED 2,000');
    expect(cashCoverLine({ ...base, covered: true, shortfallAed: 0, dueAed: 3000 })).toBe('Cash cover · AED 5,000 liquid · AED 3,000 due in 7 days · covered');
    expect(cashCoverLine({ ...base, covered: true, shortfallAed: 0, dueAed: 3000 }, 'Cash cover: ')).toBe('Cash cover: AED 5,000 liquid · AED 3,000 due in 7 days · covered');
  });

  it('never says covered when a bill due has no AED amount, and says "at least" of a shortfall', () => {
    expect(cashCoverLine({ ...base, certain: false, unvaluedDue: 1 })).toBe('Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · short by at least AED 2,000\n⚠ 1 bill due has no AED amount, so more is due');
    expect(cashCoverLine({ ...base, covered: true, certain: false, unvaluedDue: 2, shortfallAed: 0, dueAed: 3000 })).toBe("Cash cover · AED 5,000 liquid · AED 3,000 due in 7 days · can't say if covered\n⚠ 2 bills due have no AED amount, so more is due");
  });

  it('says what an account not converted leaves out, whatever the verdict', () => {
    expect(cashCoverLine({ ...base, unvalued: 1 })).toBe('Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · short by AED 2,000\n⚠ Leaves out 1 account not converted');
    expect(cashCoverLine({ ...base, covered: true, shortfallAed: 0, dueAed: 3000, unvalued: 2 })).toBe('Cash cover · AED 5,000 liquid · AED 3,000 due in 7 days · covered\n⚠ Leaves out 2 accounts not converted');
    expect(cashCoverLine({ ...base, certain: false, unvaluedDue: 1, unvalued: 1 })).toBe("Cash cover · AED 5,000 liquid · AED 7,000 due in 7 days · can't say if covered\n⚠ 1 bill due has no AED amount, so more is due\n⚠ Leaves out 1 account not converted");
  });
});
