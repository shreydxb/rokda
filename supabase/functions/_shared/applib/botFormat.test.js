import { describe, expect, it } from 'vitest';
import { day, facts, money, notCounted } from './botFormat.js';

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

  it('keeps a minus', () => {
    expect(money(-42)).toBe('AED -42');
  });
});

describe('day', () => {
  it('gives the day and month, and the year only when not this year', () => {
    expect(day('2026-10-03', '2026-11-23')).toBe('3 Oct');
    expect(day('2026-09-19T08:00:00Z', '2026-11-23')).toBe('19 Sep');
    expect(day('2025-09-19', '2026-11-23')).toBe('19 Sep 2025');
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

