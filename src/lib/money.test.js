import { describe, it, expect } from 'vitest';
import { formatBalance, formatMoney, formatSigned } from './money';
import { convertFromAed } from './currency';

// QA-08 / SHR-249: formatMoney always took the absolute value, so a net worth
// of −100 displayed as 100 and yearly net savings lost its minus.
describe('sign-preserving money formatting', () => {
  it('keeps the minus on a negative balance', () => {
    expect(formatBalance(-100)).toMatch(/^[-−]/);
    expect(formatBalance(-100)).toBe('−100');
  });

  it('leaves a positive balance undecorated', () => {
    expect(formatBalance(100)).toBe('100');
    expect(formatBalance(0)).toBe('0');
  });

  it('still offers a magnitude formatter where the UI supplies its own sign', () => {
    // Expense rows render "−{formatMoney(spend)}" themselves; that must not
    // become a double sign.
    expect(formatMoney(-100)).toBe('100');
    expect(`−${formatMoney(-100)}`).toBe('−100');
    expect(`−${formatMoney(-100)}`).not.toMatch(/−−/);
  });

  it('keeps the explicit +/- formatter for deltas', () => {
    expect(formatSigned(100)).toBe('+100');
    expect(formatSigned(-100)).toBe('−100');
    expect(formatSigned(0)).toBe('0');
  });

  it('preserves the minus in every display currency', () => {
    const household = { inr_per_aed: 23.2 };
    for (const code of ['AED', 'USD', 'INR']) {
      const converted = convertFromAed(-1000, code, household);
      expect(converted).not.toBeNull();
      expect(formatBalance(converted)).toMatch(/^−/);
      expect(formatBalance(converted)).not.toMatch(/−.*−/);
    }
  });
});

// Building a formatter on every call was most of a Life plan render
// (Planning audit, 0b-E).
describe('formatMoney: one formatter per number of decimals', () => {
  it('is built once and reused', () => {
    const Real = Intl.NumberFormat;
    let made = 0;
    Intl.NumberFormat = function NumberFormat(...args) {
      made += 1;
      return new Real(...args);
    };
    try {
      // Three decimals, which no other test asks for, so the first call builds it.
      expect(formatMoney(1234.5, { decimals: 3 })).toBe('1,234.500');
      for (let i = 0; i < 50; i++) formatMoney(i, { decimals: 3 });
      expect(formatBalance(-2, { decimals: 3 })).toBe('−2.000');
      expect(made).toBe(1);
    } finally {
      Intl.NumberFormat = Real;
    }
  });
});
