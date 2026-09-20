import { describe, it, expect } from 'vitest';
import { isLiquidAccount, liquidTotalAed, dueWithinAed, cashCoverStatus } from './cashCover';

const CHECKING = { id: 'a1', type: 'checking', balance: 3000, balance_aed: 3000, currency: 'AED', archived_at: null };
const SAVINGS = { id: 'a2', type: 'savings', balance: 2000, balance_aed: 2000, currency: 'AED', archived_at: null };
const CASH = { id: 'a3', type: 'cash', balance: 500, balance_aed: 500, currency: 'AED', archived_at: null };
const CREDIT_CARD = { id: 'a4', type: 'credit_card', balance: -1500, balance_aed: -1500, currency: 'AED', archived_at: null };
const INVESTMENT = { id: 'a5', type: 'investment', balance: 50000, balance_aed: 50000, currency: 'AED', archived_at: null };
const FD = { id: 'a6', type: 'fd', balance: 20000, balance_aed: 20000, currency: 'AED', archived_at: null };
const OTHER = { id: 'a7', type: 'other', balance: 999, balance_aed: 999, currency: 'AED', archived_at: null };
const CLOSED_CHECKING = { id: 'a8', type: 'checking', balance: 10000, balance_aed: 10000, currency: 'AED', archived_at: '2026-01-01T00:00:00Z' };
// Never converted to AED (QA pass 3, O3): must not silently count as AED.
const UNCONVERTED_INR_SAVINGS = { id: 'a9', type: 'savings', balance: 100000, balance_aed: null, currency: 'INR', archived_at: null };

describe('isLiquidAccount', () => {
  it('accepts checking, savings and cash', () => {
    expect(isLiquidAccount(CHECKING)).toBe(true);
    expect(isLiquidAccount(SAVINGS)).toBe(true);
    expect(isLiquidAccount(CASH)).toBe(true);
  });

  it('rejects credit cards, investments, FDs and other', () => {
    expect(isLiquidAccount(CREDIT_CARD)).toBe(false);
    expect(isLiquidAccount(INVESTMENT)).toBe(false);
    expect(isLiquidAccount(FD)).toBe(false);
    expect(isLiquidAccount(OTHER)).toBe(false);
  });

  it('rejects a closed account even if its type is liquid', () => {
    expect(isLiquidAccount(CLOSED_CHECKING)).toBe(false);
  });
});

describe('liquidTotalAed', () => {
  it('sums only liquid, open accounts', () => {
    const accounts = [CHECKING, SAVINGS, CASH, CREDIT_CARD, INVESTMENT, FD, OTHER, CLOSED_CHECKING];
    expect(liquidTotalAed(accounts)).toBe(5500);
  });

  it('never counts an unconverted foreign-currency balance as AED', () => {
    // accountValueAed() returns null here (never priced in AED), and null
    // must contribute 0 -- not the raw 100000 rupees mistaken for dirhams.
    expect(liquidTotalAed([UNCONVERTED_INR_SAVINGS])).toBe(0);
  });
});

describe('dueWithinAed', () => {
  const bills = {
    recurring: [
      { name: 'Rent', amount_aed: 6000, due_date: '2026-09-16' },
      { name: 'Gym', amount_aed: 200, due_date: '2026-09-25' },
    ],
    credit_cards: [{ name: 'ENBD', amount_owed_aed: 1500, due_date: '2026-09-18' }],
  };
  const today = new Date(2026, 8, 14); // 14 Sep 2026

  it('sums only bills due within the window, inclusive of the boundary', () => {
    // 7-day window from the 14th reaches the 21st: Rent (16th) and the card
    // (18th) are in; the Gym (25th) is not.
    expect(dueWithinAed(bills, 7, today)).toBe(7500);
  });

  it('excludes a bill due the day after the cutoff', () => {
    // 3-day window from the 14th reaches the 17th: Rent (16th) is in, the
    // card (18th, one day past the cutoff) is not.
    expect(dueWithinAed(bills, 3, today)).toBe(6000);
  });

  it('returns 0 when nothing is due in the window', () => {
    expect(dueWithinAed(bills, 1, today)).toBe(0);
  });
});

describe('cashCoverStatus', () => {
  const today = new Date(2026, 8, 14);

  it('reports covered with no shortfall when liquid meets or exceeds what is due', () => {
    const accounts = [CHECKING, SAVINGS]; // 5000 liquid
    const bills = { recurring: [{ amount_aed: 4000, due_date: '2026-09-16' }], credit_cards: [] };
    const status = cashCoverStatus(accounts, bills, { days: 7, today });
    expect(status).toEqual({ liquidAed: 5000, dueAed: 4000, days: 7, covered: true, shortfallAed: 0, unvalued: 0 });
  });

  it('reports the exact shortfall when liquid falls short', () => {
    const accounts = [CASH]; // 500 liquid
    const bills = { recurring: [{ amount_aed: 4000, due_date: '2026-09-16' }], credit_cards: [] };
    const status = cashCoverStatus(accounts, bills, { days: 7, today });
    expect(status).toEqual({ liquidAed: 500, dueAed: 4000, days: 7, covered: false, shortfallAed: 3500, unvalued: 0 });
  });

  // QA #4: liquidTotalAed can only treat an unconverted balance as zero.
  // That is defensible arithmetic and an indefensible verdict on its own --
  // a household with an unconverted savings account can be told it is short
  // when it is not. The count travels with the verdict so the caller can say
  // the figure is incomplete.
  it('reports how many liquid accounts have no AED conversion', () => {
    const accounts = [CASH, UNCONVERTED_INR_SAVINGS];
    const bills = { recurring: [{ amount_aed: 4000, due_date: '2026-09-16' }], credit_cards: [] };
    const status = cashCoverStatus(accounts, bills, { days: 7, today });
    expect(status.liquidAed).toBe(500);
    expect(status.unvalued).toBe(1);
  });

  it('counts no unvalued accounts once the conversion exists', () => {
    const converted = { ...UNCONVERTED_INR_SAVINGS, balance_aed: 4300 };
    const status = cashCoverStatus([CASH, converted], { recurring: [], credit_cards: [] }, { days: 7, today });
    expect(status.liquidAed).toBe(4800);
    expect(status.unvalued).toBe(0);
  });

  it('ignores a closed account with no conversion, same as every other current figure', () => {
    const closed = { ...UNCONVERTED_INR_SAVINGS, archived_at: '2026-01-01T00:00:00Z' };
    const status = cashCoverStatus([CASH, closed], { recurring: [], credit_cards: [] }, { days: 7, today });
    expect(status.unvalued).toBe(0);
  });
});
