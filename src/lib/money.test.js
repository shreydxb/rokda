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
