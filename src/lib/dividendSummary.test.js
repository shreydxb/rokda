import { describe, it, expect } from 'vitest';
import {
  buildDividendInput, comingUp, dividendDestination, dividendHeadline, dividendSources, dividendsByHolding, dividendsByMonth, feedFreshness, needsYou,
  spendingEquivalent,
} from './dividendSummary';

const TODAY = '2026-11-03';
const RUPEES = [{ base: 'AED', quote: 'INR', day: '2025-01-01', rate: 25 }];
const US = { id: 'h-us', name: 'ABC', asset_class: 'us_equity', currency: 'USD', price_symbol: 'ABC', price_provider: 'twelvedata', quantity: 10,
  is_shared: false, owner_member_id: 'm2', funds_account_id: 'f-usd', sector: 'technology', dividend_tax_pct: 30, current_price: 50, avg_price: 40 };
const IN = { id: 'h-in', name: 'XYZ', asset_class: 'india_equity', currency: 'INR', price_symbol: 'XYZ.NS', price_provider: 'yahoo', quantity: 100,
  is_shared: true, owner_member_id: null, funds_account_id: 'f-inr', sector: null, dividend_tax_pct: 20.8, current_price: 500, avg_price: 400 };
const ACCOUNTS = [
  { id: 'f-usd', name: 'Dollar broker funds', type: 'broker_funds', currency: 'USD', dividends_into_account_id: null, archived_at: null },
  { id: 'f-inr', name: 'Rupee broker funds', type: 'broker_funds', currency: 'INR', dividends_into_account_id: 'a-inr', archived_at: null },
  { id: 'a-inr', name: 'Rupee bank', type: 'checking', currency: 'INR', archived_at: null },
];
const row = (id, holding, extra) => ({ id, holding_id: holding.id, currency: holding.currency, review_reason: null, ex_date: null, pay_date: null, credited_on: null,
  expected_gross: 0, expected_tax: 0, expected_fees: 0, expected_net: 0, received_net: null, ...extra });
const DIVIDENDS = [
  row('d1', US, { status: 'received', ex_date: '2026-09-01', credited_on: '2026-09-20', expected_net: 20, received_net: 20, paid_into_account_id: 'f-usd' }),
  row('d2', IN, { status: 'presumed', ex_date: '2026-07-01', credited_on: '2026-08-01', expected_net: 500, paid_into_account_id: 'a-inr' }),
  row('d4', US, { status: 'received', ex_date: null, credited_on: '2026-10-10', expected_net: 20, received_net: 20, paid_into_account_id: 'f-usd' }),
  row('d5', US, { status: 'earned', ex_date: '2026-10-25', pay_date: '2026-11-15', expected_gross: 28, expected_tax: 8, expected_net: 20, paid_into_account_id: 'f-usd' }),
];
const TRADES = [
  { holding_id: 'h-us', kind: 'opening', trade_date: '2026-09-01' },
  { holding_id: 'h-in', kind: 'opening', trade_date: '2025-09-01' },
];
const item = (kind, extra) => ({ kind, day: null, month: null, gross: 0, withheld: 0, fees: 0, net: 0, ...extra });
const FORECASTS = {
  'h-us': {
    status: 'ok', frequency: { kind: 'quarterly', perYear: 4, intervalMonths: 3 }, next: { day: '2026-11-15' }, ordinaryPerShareNextYear: 2,
    items: [
      item('earned', { dividendId: 'd5', day: '2026-11-15', gross: 28, withheld: 8, net: 20, currency: 'USD' }),
      item('declared', { eventId: 'e-dec', day: '2026-11-20', gross: 28, withheld: 8, net: 20, currency: 'USD' }),
      item('projected', { month: '2027-01', gross: 56, withheld: 16, net: 40, currency: 'USD' }),
    ],
  },
  'h-in': {
    status: 'ok', frequency: { kind: 'yearly', perYear: 1, intervalMonths: 12 }, next: { month: '2027-02' }, ordinaryPerShareNextYear: 12.5,
    items: [item('projected', { month: '2027-02', gross: 1250, withheld: 250, net: 1000, currency: 'INR' })],
  },
};

function input(over = {}) {
  return {
    holdings: [US, IN], dividends: DIVIDENDS, trades: TRADES, events: [], splits: [], payments: {}, forecasts: FORECASTS, feedStatus: [], accounts: ACCOUNTS,
    specialParts: [], scopeMemberId: null, fx: { fxHistory: RUPEES, inrPerAed: null }, today: TODAY, ...over,
  };
}

describe('the headline', () => {
  it('received counts the last twelve months by credit date, and says the presumed part', () => {
    const h = dividendHeadline(input());
    // 20 + 20 dollars at the peg, and 500 rupees at 25 a dirham.
    expect(h.received.aed).toBeCloseTo(166.9, 2);
    expect(h.received.presumedAed).toBeCloseTo(20, 2);
    expect(h.received.notCounted).toBe(0);
    // 80 dollars and 1,000 rupees ahead.
    expect(h.expected.aed).toBeCloseTo(333.8, 2);
    expect(h.expected.monthlyAed).toBeCloseTo(27.82, 2);
  });

  it('a rupee dividend with no rate is not counted, and the total says how many', () => {
    const h = dividendHeadline(input({ fx: { fxHistory: [], inrPerAed: null } }));
    expect(h.received.aed).toBeCloseTo(146.9, 2);
    expect(h.received.notCounted).toBe(1);
    expect(h.expected.notCounted).toBe(1);
  });

  it("a shared holding counts half in one member's scope", () => {
    const h = dividendHeadline(input({ scopeMemberId: 'm1' }));
    expect(h.received.aed).toBeCloseTo(10, 2);
    expect(h.received.presumedAed).toBeCloseTo(10, 2);
    expect(h.expected.aed).toBeCloseTo(20, 2);
  });

  it("one market's history covers less than the other's, and the headline says so", () => {
    const h = dividendHeadline(input());
    expect(h.received.since).toBeNull();
    expect(h.markets).toEqual([
      expect.objectContaining({ market: 'IN', since: null, start: '2025-09-01' }),
      expect.objectContaining({ market: 'US', since: '2026-09-01', start: '2026-09-01' }),
    ]);
    expect(h.markets[1].receivedAed).toBeCloseTo(146.9, 2);
    expect(h.coverageDiffers).toBe(true);
    expect(dividendHeadline(input({ holdings: [US] })).coverageDiffers).toBe(false);
  });
});

describe('by month', () => {
  it('by month: presumed apart, expected in the next twelve, earned view leaves out receipts with no ex-date and counts them', () => {
    const received = dividendsByMonth(input(), 'received');
    const month = (m) => received.months.find((x) => x.month === m);
    expect(received.months[0].month).toBe('2024-12');
    expect(received.months.at(-1).month).toBe('2027-11');
    expect(month('2026-09').actualAed).toBeCloseTo(73.45, 2);
    expect(month('2026-08')).toMatchObject({ actualAed: 0, presumedAed: 20 });
    expect(month('2026-11').expectedAed).toBeCloseTo(146.9, 2);
    expect(month('2027-01').expectedAed).toBeCloseTo(146.9, 2);
    expect(received.years.find((y) => y.year === 2026).aed).toBeCloseTo(166.9, 2);
    expect(received.leftOut).toBe(0);

    const earned = dividendsByMonth(input(), 'earned');
    expect(earned.months.find((x) => x.month === '2026-07').actualAed).toBeCloseTo(20, 2);
    expect(earned.months.find((x) => x.month === '2026-10').actualAed).toBeCloseTo(73.45, 2);
    expect(earned.leftOut).toBe(1);
  });
});

describe('by holding', () => {
  const NONE = { ...US, id: 'h-none', name: 'QUIET', price_symbol: 'QUIET' };
  const FAILING = { ...US, id: 'h-fail', name: 'BROKEN', price_symbol: 'BROKEN' };
  const NEW = { ...US, id: 'h-new', name: 'FRESH', price_symbol: 'FRESH' };
  const status = (symbol, extra) => ({ symbol, provider: 'alphavantage', kind: 'dividends', last_success_at: '2026-11-02T01:30:00Z', fail_count: 0, covered_from: '2015-01-01', ...extra });

  it('by holding: sorted by expected; none found since the latest coverage date; failing and not-checked-yet kept apart', () => {
    const b = dividendsByHolding(input({
      holdings: [IN, US, NONE, FAILING, NEW],
      payments: { ABC: [{ exDate: '2026-09-01', ordinary: 2, ordinaryToday: 2 }], 'XYZ.NS': [{ exDate: '2026-07-01', ordinary: 5, ordinaryToday: 5 }] },
      feedStatus: [status('ABC'), { ...status('XYZ.NS'), provider: 'yahoo' }, status('QUIET', { covered_from: '2016-03-01' }), status('BROKEN', { fail_count: 2, last_success_at: null })],
    }));
    expect(b.rows.map((r) => r.holding.id)).toEqual(['h-us', 'h-in']);
    expect(b.rows[0]).toMatchObject({ lastOrdinaryPerShare: 2, next: { day: '2026-11-15' }, status: 'ok', yields: { onValue: 0.04, onCost: 0.05 } });
    expect(b.rows[0].frequency.kind).toBe('quarterly');
    expect(b.rows[0].receivedAed).toBeCloseTo(146.9, 2);
    expect(b.none).toEqual({ since: '2016-03-01', holdings: [NONE] });
    expect(b.failing).toEqual([FAILING]);
    expect(b.notChecked).toEqual([NEW]);
  });
});

describe('where it comes from', () => {
  it('sources by market and by sector, unknown sector last', () => {
    const s = dividendSources(input());
    expect(s.markets).toEqual([
      expect.objectContaining({ market: 'US', withholdingPct: 28.6 }),
      expect.objectContaining({ market: 'IN', withholdingPct: 20 }),
    ]);
    expect(s.markets[0].expectedAed).toBeCloseTo(293.8, 2);
    expect(s.sectors.map((x) => x.sector)).toEqual(['technology', 'unknown']);
  });
});

describe('spending equivalent', () => {
  // A closed month of shared spending of 1,000, for each of the last n months.
  const spending = (n) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9 - i, 10));
    return { amount: -1000, kind: 'expense', occurred_at: d.toISOString().slice(0, 10), is_shared: true, category_id: 'c' };
  });
  const now = new Date(2026, 10, 3);

  it('spending equivalent: received once twelve months are covered, expected before; none under three months', () => {
    const covered = input({ holdings: [IN], trades: [{ holding_id: 'h-in', kind: 'opening', trade_date: '2024-01-01' }] });
    // 500 rupees received (20 dirhams) against 12,000 spent.
    expect(spendingEquivalent(covered, { transactions: spending(12), now })).toEqual({ pct: 0.2, basis: 'received' });
    // Covered for two months only: 333.8 expected against 12,000 a year.
    expect(spendingEquivalent(input(), { transactions: spending(12), now })).toEqual({ pct: 2.8, basis: 'expected' });
    expect(spendingEquivalent(input(), { transactions: spending(2), now })).toBeNull();
    expect(spendingEquivalent(input(), { transactions: [], now })).toBeNull();
  });
});

describe('coming up', () => {
  it("coming up: earned and declared, soonest first; only an earned one into a broker's fund can be recorded; a declared one goes where the fund's dividends land", () => {
    const bankRow = row('d6', IN, { status: 'earned', ex_date: '2026-10-20', pay_date: '2026-11-10', expected_net: 250, paid_into_account_id: 'a-inr' });
    const forecasts = { ...FORECASTS, 'h-in': { ...FORECASTS['h-in'], items: [item('declared', { eventId: 'e-in', day: '2026-12-05', net: 1000, currency: 'INR' })] } };
    const c = comingUp(input({ dividends: [...DIVIDENDS, bankRow], forecasts }));
    expect(c.map((x) => [x.kind, x.dividendId ?? x.eventId, x.day, x.canRecord])).toEqual([
      ['earned', 'd6', '2026-11-10', false],
      ['earned', 'd5', '2026-11-15', true],
      ['declared', 'e-dec', '2026-11-20', false],
      ['declared', 'e-in', '2026-12-05', false],
    ]);
    expect(c[2].destinationAccountId).toBe('f-usd');
    expect(c[3].destinationAccountId).toBe('a-inr');
    expect(dividendDestination(IN, ACCOUNTS.map((a) => (a.id === 'a-inr' ? { ...a, archived_at: '2026-01-01' } : a)))).toBe('f-inr');
  });
});

describe('needs you', () => {
  it('names each thing that needs a member, in words', () => {
    const flagged = needsYou(input({ dividends: [row('d7', US, { status: 'received', review_reason: 'possible_duplicate' })] }));
    expect(flagged).toEqual([expect.objectContaining({ kind: 'flagged', dividendId: 'd7', text: 'The feed has a dividend close to this date. Is it this one?' })]);

    const oneOff = needsYou(input({ dividends: [], payments: { ABC: [{ eventId: 'e-big', exDate: '2026-03-14', amount: 4, oneOff: 'candidate', special: 3 }] } }));
    expect(oneOff).toEqual([expect.objectContaining({
      kind: 'one_off', eventId: 'e-big', special: 3, text: 'ABC paid 4.00 a share on 14 Mar, more than twice its usual. Was part of it a one-off?',
    })]);

    const trades = [{ holding_id: 'h-us', kind: 'opening', trade_date: '2025-01-01' }];
    const splits = [{ symbol: 'ABC', effective_date: '2026-06-02', ratio: 10 }];
    expect(needsYou(input({ dividends: [], trades, splits }))).toEqual([
      expect.objectContaining({ kind: 'split_not_traded', text: "ABC split 10 for 1 on 2 Jun, but its trades don't show it." }),
    ]);
    expect(needsYou(input({ dividends: [], splits, trades: [...trades, { holding_id: 'h-us', kind: 'split', trade_date: '2026-06-02' }] }))).toEqual([]);

    const events = [{ id: 'e-early', symbol: 'ABC', ex_date: '2026-03-14', pay_date: '2026-03-10', amount: 1, superseded_by: null, missed_checks: 0 }];
    expect(needsYou(input({ dividends: [], trades, events }))).toEqual([
      expect.objectContaining({ kind: 'add_by_hand', eventId: 'e-early', text: "ABC's dividend of 14 Mar needs adding by hand: its pay date is before its ex-date." }),
    ]);
  });
});

describe('freshness', () => {
  it('per market: the last success, failing shares and since when, and whether the feed has run', () => {
    const OTHER = { ...US, id: 'h-other', price_symbol: 'BROKEN' };
    const feedStatus = [
      { symbol: 'ABC', provider: 'alphavantage', kind: 'dividends', last_success_at: '2026-11-02T01:30:00Z', fail_count: 0, covered_from: '2012-01-01' },
      { symbol: 'BROKEN', provider: 'alphavantage', kind: 'dividends', last_success_at: '2026-10-30T01:30:00Z', fail_count: 3, covered_from: '2014-01-01' },
      { symbol: 'XYZ.NS', provider: 'yahoo', kind: 'dividends', last_success_at: '2026-11-03T01:30:00Z', fail_count: 0, covered_from: '2005-04-01' },
    ];
    expect(feedFreshness(input({ holdings: [US, OTHER, IN], feedStatus }))).toEqual([
      { market: 'IN', lastSuccessAt: '2026-11-03T01:30:00Z', coveredFrom: '2005-04-01', failing: [], neverRun: false },
      { market: 'US', lastSuccessAt: '2026-11-02T01:30:00Z', coveredFrom: '2014-01-01', failing: [{ symbol: 'BROKEN', since: '2026-10-30T01:30:00Z' }], neverRun: false },
    ]);
    expect(feedFreshness(input()).map((m) => m.neverRun)).toEqual([true, true]);
  });
});

describe('building the input', () => {
  it("reads the screen's data once: paying holdings in scope, each share's payments, each holding's forecast", () => {
    const events = Array.from({ length: 24 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9 - i, 15)).toISOString().slice(0, 10);
      return { id: `e-${i}`, symbol: 'ABC', ex_date: d, pay_date: null, amount: 1, superseded_by: null, missed_checks: 0 };
    });
    const data = {
      holdings: [US, { id: 'h-cash', name: 'Cash fund', asset_class: 'cash', is_shared: true }], holdingDividends: DIVIDENDS, holdingTrades: TRADES,
      dividendEvents: events, dividendSplits: [], dividendSpecialParts: [], accounts: ACCOUNTS, fxRateHistory: RUPEES,
      dividendFeedStatus: [{ symbol: 'ABC', provider: 'alphavantage', kind: 'dividends', last_success_at: '2026-11-02T01:30:00Z', fail_count: 0, covered_from: '2010-01-01' }],
    };
    const built = buildDividendInput({ data, household: { inr_per_aed: 24 }, scopeMemberId: null, today: TODAY });
    expect(built.holdings.map((h) => h.id)).toEqual(['h-us']);
    expect(built.payments.ABC).toHaveLength(24);
    expect(built.forecasts['h-us'].frequency.kind).toBe('monthly');
    expect(built.forecasts['h-us'].status).toBe('ok');
    expect(built.fx).toEqual({ fxHistory: RUPEES, inrPerAed: 24 });
  });
});
