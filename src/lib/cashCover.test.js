import { describe, it, expect } from 'vitest';
import { isLiquidAccount, liquidTotalAed, dueWithinAed, unvaluedDueBills, cashCoverStatus, formatCashCoverLine } from './cashCover';

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
    expect(status).toEqual({ liquidAed: 5000, dueAed: 4000, days: 7, covered: true, certain: true, shortfallAed: 0, unvalued: 0, unvaluedDue: 0 });
  });

  it('reports the exact shortfall when liquid falls short', () => {
    const accounts = [CASH]; // 500 liquid
    const bills = { recurring: [{ amount_aed: 4000, due_date: '2026-09-16' }], credit_cards: [] };
    const status = cashCoverStatus(accounts, bills, { days: 7, today });
    expect(status).toEqual({ liquidAed: 500, dueAed: 4000, days: 7, covered: false, certain: true, shortfallAed: 3500, unvalued: 0, unvaluedDue: 0 });
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

// An amount nobody knows is not zero. The QA #4 fix propagated that through
// the ASSET side -- an unconverted savings account stopped counting as AED.
// The liability side kept doing exactly what the asset side had stopped
// doing, and it points the other way: an unknown asset makes a shortfall
// warning suspect, an unknown bill makes a CLEAN verdict suspect, which is
// the direction that stops someone acting.
describe('what is due but has no AED amount', () => {
  const today = new Date('2026-09-15T00:00:00Z');
  // A US-dollar card that was never converted. toolGetUpcomingBills lists it
  // with amount_owed_aed null, exactly like this.
  const UNCONVERTED_CARD = { name: 'US card', amount_owed_aed: null, amount: 5000, currency: 'USD', due_date: '2026-09-17' };
  // A rupee subscription. `recurring` has a currency column and no converted
  // column at all, so there is no AED figure for it anywhere.
  const UNCONVERTED_BILL = { name: 'Rupee subscription', amount_aed: null, amount: 3000, currency: 'INR', due_date: '2026-09-16' };

  it('does not add an unknown amount into the due total as zero', () => {
    const bills = { recurring: [], credit_cards: [UNCONVERTED_CARD] };
    expect(dueWithinAed(bills, 7, today)).toBe(0);
    expect(unvaluedDueBills(bills, 7, today)).toBe(1);
  });

  it('counts unknowns from both bills and cards, and only inside the window', () => {
    const bills = {
      recurring: [UNCONVERTED_BILL, { amount_aed: null, due_date: '2026-10-30' }],
      credit_cards: [UNCONVERTED_CARD],
    };
    expect(unvaluedDueBills(bills, 7, today)).toBe(2);
  });

  it('still treats a genuine zero as known', () => {
    const bills = { recurring: [{ amount_aed: 0, due_date: '2026-09-16' }], credit_cards: [] };
    expect(unvaluedDueBills(bills, 7, today)).toBe(0);
  });

  it('refuses to call a verdict certain when something due has no AED amount', () => {
    // AED 500 liquid against a USD 5,000 card due in two days. The old code
    // summed that card as zero and reported "covered" with no caveat.
    const status = cashCoverStatus([CASH], { recurring: [], credit_cards: [UNCONVERTED_CARD] }, { days: 7, today });
    expect(status.dueAed).toBe(0);
    expect(status.covered).toBe(true);
    expect(status.certain).toBe(false);
    expect(status.unvaluedDue).toBe(1);
  });

  it('keeps an unknown bill out of the liquid-account caveat, which points the other way', () => {
    const status = cashCoverStatus([CASH], { recurring: [], credit_cards: [UNCONVERTED_CARD] }, { days: 7, today });
    // unvalued counts unconverted LIQUID ACCOUNTS. A credit card is not one,
    // which is why the old caveat never fired for this case.
    expect(status.unvalued).toBe(0);
    expect(status.unvaluedDue).toBe(1);
  });

  it('is certain again when every due amount is known', () => {
    const bills = { recurring: [{ amount_aed: 200, due_date: '2026-09-16' }], credit_cards: [] };
    const status = cashCoverStatus([CASH], bills, { days: 7, today });
    expect(status.certain).toBe(true);
    expect(status.unvaluedDue).toBe(0);
    expect(status.covered).toBe(true);
  });
});

// The sentence is the product. A caveat that exists in the return value but
// never reaches the reader is the same defect with an extra step.
describe('the sentence the bot says', () => {
  const today = new Date('2026-09-15T00:00:00Z');
  const UNCONVERTED_CARD = { name: 'US card', amount_owed_aed: null, amount: 5000, currency: 'USD', due_date: '2026-09-17' };

  it('does not say "covered" when something due has no AED amount', () => {
    const status = cashCoverStatus([CASH], { recurring: [], credit_cards: [UNCONVERTED_CARD] }, { days: 7, today });
    const line = formatCashCoverLine(status);
    // This is the whole defect: AED 500 against an unconverted USD 5,000 card
    // due in two days used to read "AED 0 due ... -- covered."
    expect(line).not.toMatch(/-- covered\./);
    expect(line).toMatch(/can't say whether that is covered/);
    expect(line).toMatch(/no AED amount/);
  });

  it('still says covered plainly when every due amount is known', () => {
    const bills = { recurring: [{ amount_aed: 200, due_date: '2026-09-16' }], credit_cards: [] };
    expect(formatCashCoverLine(cashCoverStatus([CASH], bills, { days: 7, today }))).toMatch(/-- covered\./);
  });

  it('still states a shortfall, as a floor, when an amount is unknown', () => {
    const bills = { recurring: [{ amount_aed: 4000, due_date: '2026-09-16' }], credit_cards: [UNCONVERTED_CARD] };
    const line = formatCashCoverLine(cashCoverStatus([CASH], bills, { days: 7, today }));
    expect(line).toMatch(/short by at least AED 3,500/);
    expect(line).toMatch(/no AED amount/);
  });

  it('keeps the existing unconverted-liquid-account caveat', () => {
    const bills = { recurring: [{ amount_aed: 4000, due_date: '2026-09-16' }], credit_cards: [] };
    const line = formatCashCoverLine(cashCoverStatus([CASH, UNCONVERTED_INR_SAVINGS], bills, { days: 7, today }));
    expect(line).toMatch(/no AED conversion yet/);
  });
});
