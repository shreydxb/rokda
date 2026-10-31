import { describe, it, expect } from 'vitest';
import { formatUnits, hasBuysOrSales, refusalMessage, salesProfit, tradeArgs, tradeRow, tradesOfHolding, warningLines, TRADE_KIND_LABELS } from './trades';
import { householdToday } from './day';

const ME = 'm-me';
const PARTNER = 'm-partner';
const ABC = { id: 'h-abc', name: 'ABC', currency: 'USD', asset_class: 'us_equity', owner_member_id: ME, is_shared: false, trades_version: 3, quantity: 9, avg_price: 110 };
const XYZ = { id: 'h-xyz', name: 'XYZ', currency: 'INR', asset_class: 'india_equity', owner_member_id: ME, is_shared: false, trades_version: 2, quantity: 4, avg_price: 1000 };
const SHARED = { id: 'h-shared', name: 'FUND', currency: 'USD', asset_class: 'us_equity', owner_member_id: null, is_shared: true, trades_version: 2, quantity: 1, avg_price: 10 };

const OPENING_ID = 't-open';
const BUY_ID = 't-buy';
const SELL_ID = 't-sell';
const trade = (id, extra) => ({
  id, holding_id: ABC.id, kind: 'buy', trade_date: '2026-10-28', traded_at: null, created_at: '2026-10-28T10:00:00Z',
  units: 1, price: 100, fees: 0, tax_withheld: 0, tax_to_confirm: false, realised: null, ...extra,
});
const trades = [
  trade(OPENING_ID, { kind: 'opening', units: 10, price: 100, trade_date: '2026-10-27', created_at: '2026-10-31T09:00:00Z' }),
  trade(BUY_ID, { kind: 'buy', units: 5, price: 130, trade_date: '2026-10-28' }),
  trade(SELL_ID, { kind: 'sell', units: 6, price: 150, fees: 1, realised: 239, trade_date: '2026-10-29' }),
];

describe('tradesOfHolding', () => {
  it('lists a holding\'s trades newest first, the opening last on its day', () => {
    const sameDay = [
      trade('t-b', { kind: 'buy', trade_date: '2026-10-27', created_at: '2026-10-27T08:00:00Z' }),
      trade('t-o', { kind: 'opening', trade_date: '2026-10-27', created_at: '2026-10-31T09:00:00Z' }),
      trade('t-later', { kind: 'sell', trade_date: '2026-10-29' }),
      trade('t-other', { holding_id: 'h-other', trade_date: '2026-10-30' }),
    ];
    expect(tradesOfHolding(sameDay, ABC.id).map((t) => t.id)).toEqual(['t-later', 't-b', 't-o']);
  });

  it('orders one day\'s trades by their time, a trade with no time after those with one', () => {
    const day = [
      trade('t-untimed', { traded_at: null, created_at: '2026-10-28T01:00:00Z' }),
      trade('t-late', { traded_at: '2026-10-28T15:00:00Z' }),
      trade('t-early', { traded_at: '2026-10-28T09:00:00Z' }),
    ];
    expect(tradesOfHolding(day, ABC.id).map((t) => t.id)).toEqual(['t-untimed', 't-late', 't-early']);
  });

  it('knows whether a holding has a buy or a sale beyond its opening', () => {
    expect(hasBuysOrSales(trades, ABC.id)).toBe(true);
    expect(hasBuysOrSales([trades[0]], ABC.id)).toBe(false);
    expect(hasBuysOrSales(trades, XYZ.id)).toBe(false);
  });
});

describe('formatUnits', () => {
  it('shows fractional units in full and whole units bare', () => {
    expect(formatUnits(55.51771719)).toBe('55.51771719');
    expect(formatUnits('10.00000000')).toBe('10');
    expect(formatUnits(1234.5)).toBe('1,234.5');
  });
});

describe('tradeRow', () => {
  it('describes a sale with its brokerage, tax and profit', () => {
    expect(tradeRow({ kind: 'sell', units: 6, price: 150, fees: 1, tax_withheld: 2, realised: 239, trade_date: '2026-10-29' }, 'USD'))
      .toEqual({ title: 'Sell 6 at USD 150.00', detail: '29 Oct 2026 · brokerage 1.00 · tax 2.00 · profit 239.00' });
  });

  it('describes a loss, a split, an opening and an Indian sale awaiting its tax', () => {
    expect(tradeRow({ kind: 'sell', units: 2, price: 80, fees: 0, tax_withheld: 0, realised: -40, trade_date: '2026-10-29' }, 'USD'))
      .toEqual({ title: 'Sell 2 at USD 80.00', detail: '29 Oct 2026 · loss 40.00' });
    expect(tradeRow({ kind: 'split', units: 10, price: null, fees: 0, tax_withheld: 0, trade_date: '2026-10-29' }, 'USD'))
      .toEqual({ title: 'Split 10 for 1', detail: '29 Oct 2026' });
    expect(tradeRow({ kind: 'opening', units: 10, price: 100, fees: 0, tax_withheld: 0, trade_date: '2026-10-27' }, 'USD'))
      .toEqual({ title: 'Opening 10 at USD 100.00', detail: '27 Oct 2026' });
    expect(tradeRow({ kind: 'sell', units: 1, price: 1200, fees: 20, tax_withheld: 0, tax_to_confirm: true, realised: 180, trade_date: '2026-10-29' }, 'INR'))
      .toEqual({ title: 'Sell 1 at INR 1,200.00', detail: '29 Oct 2026 · brokerage 20.00 · profit 180.00 · tax to confirm' });
    expect(TRADE_KIND_LABELS.opening).toBe('Opening');
  });
});

describe('salesProfit', () => {
  const fxHistory = [{ base: 'AED', quote: 'INR', day: '2026-10-01', rate: 23 }];
  const sale = (id, holding, extra) => trade(id, { holding_id: holding.id, kind: 'sell', ...extra });

  it('counts this year\'s sales in AED, a rupee sale at its own day\'s rate', () => {
    const sales = [
      sale('s1', ABC, { realised: 100, trade_date: '2026-10-29' }),
      sale('s2', XYZ, { realised: 2300, trade_date: '2026-10-05' }),
      trade('b1', { kind: 'buy', realised: null }),
    ];
    const result = salesProfit(sales, [ABC, XYZ], { from: '2026-01-01', to: '2027-01-01', scopeMemberId: null, fxHistory, inrPerAed: 22 });
    expect(result).toEqual({ available: true, profitAed: 467.25, taxAed: 0, sales: 2, taxToConfirm: 0 });
  });

  it('leaves out sales outside the dates and on holdings not given', () => {
    const sales = [
      sale('s-old', ABC, { realised: 100, trade_date: '2025-12-31' }),
      sale('s-xyz', XYZ, { realised: 2300, trade_date: '2026-10-05' }),
    ];
    expect(salesProfit(sales, [ABC], { from: '2026-01-01', to: '2027-01-01', scopeMemberId: null, fxHistory, inrPerAed: null }))
      .toEqual({ available: true, profitAed: 0, taxAed: 0, sales: 0, taxToConfirm: 0 });
  });

  it('leaves the year\'s profit unknown when a rupee sale has no rate', () => {
    const sales = [sale('s2', XYZ, { realised: 2300, trade_date: '2026-09-05' })];
    expect(salesProfit(sales, [XYZ], { from: '2026-01-01', to: '2027-01-01', scopeMemberId: null, fxHistory, inrPerAed: null }).available).toBe(false);
  });

  it('falls back to the household\'s rate when history has none for the day', () => {
    const sales = [sale('s2', XYZ, { realised: 2200, trade_date: '2026-09-05' })];
    expect(salesProfit(sales, [XYZ], { from: null, to: null, scopeMemberId: null, fxHistory, inrPerAed: 22 }).profitAed).toBe(100);
  });

  it('halves a shared holding\'s sale in one member\'s view', () => {
    const sales = [sale('s3', SHARED, { realised: 200, trade_date: '2026-10-29' })];
    expect(salesProfit(sales, [SHARED], { from: null, to: null, scopeMemberId: PARTNER, fxHistory, inrPerAed: null }).profitAed).toBe(367.25);
  });

  it('counts the tax withheld, and an Indian sale whose tax is still to confirm', () => {
    const sales = [
      sale('s4', XYZ, { realised: 2300, tax_withheld: 230, trade_date: '2026-10-05' }),
      sale('s5', XYZ, { realised: 230, tax_to_confirm: true, trade_date: '2026-10-06' }),
    ];
    expect(salesProfit(sales, [XYZ], { from: null, to: null, scopeMemberId: null, fxHistory, inrPerAed: null }))
      .toEqual({ available: true, profitAed: 110, taxAed: 10, sales: 2, taxToConfirm: 1 });
  });
});

describe('refusalMessage', () => {
  const ctx = { holdingName: 'ABC', currency: 'USD', trades };

  it('says which date a sale would oversell on, from the trade the database names', () => {
    expect(refusalMessage({ error: 'exceeds_units', entry_id: SELL_ID }, ctx))
      .toBe('This would sell more ABC than was held on 29 Oct. Nothing was saved.');
    expect(refusalMessage({ error: 'exceeds_units', entry_id: 'new' }, { ...ctx, formDate: '2026-10-24' }))
      .toBe('This would sell more ABC than was held on 24 Oct. Nothing was saved.');
  });

  it('words every refusal the database gives', () => {
    expect(refusalMessage({ error: 'before_opening', entry_id: 'new' }, ctx)).toBe('That date is before ABC\'s trade history starts on 27 Oct. Nothing was saved.');
    expect(refusalMessage({ error: 'whole_units_only' }, ctx)).toBe('Indian shares trade in whole units. Nothing was saved.');
    expect(refusalMessage({ error: 'fund_required' }, ctx)).toBe('There is no USD Broker funds account for this trade. Add one in Accounts. Nothing was saved.');
    expect(refusalMessage({ error: 'stale' }, ctx)).toBe('ABC changed since you checked this trade. Check it again. Nothing was saved.');
    for (const error of ['currency_mismatch', 'not_broker_funds', 'fund_archived', 'trade_not_found', 'no_opening', 'not_member', 'bad_input', 'something_new']) {
      const message = refusalMessage({ error }, ctx);
      expect(message).toMatch(/\. Nothing was saved\.$/);
      expect(message).not.toContain(error);
    }
  });
});

describe('warningLines', () => {
  const ctx = { holdingName: 'ABC', fundName: 'Dollar broker funds', fundConfirmed: true, currency: 'USD', lastPrice: 140 };

  it('warns about an unconfirmed fund without calling it overdrawn', () => {
    expect(warningLines({ warnings: ['fund_below_zero'], funds_balance_after: -500 }, { ...ctx, fundConfirmed: false, lastPrice: null }))
      .toEqual(['Dollar broker funds has no confirmed balance yet, so it would show USD -500.00 until you set it.']);
    expect(warningLines({ warnings: ['fund_below_zero'], funds_balance_after: -500 }, ctx))
      .toEqual(['Dollar broker funds would go to USD -500.00. If you added money, record that too.']);
  });

  it('words the other warnings', () => {
    expect(warningLines({ warnings: ['possible_duplicate', 'price_off_market', 'fund_confirmed_after'] }, ctx)).toEqual([
      'This looks like a trade already saved: same stock, units and price within two days.',
      'Check the price: ABC was last USD 140.00.',
      'Dollar broker funds is not moved: its balance was confirmed after this trade.',
    ]);
    expect(warningLines({ warnings: [] }, ctx)).toEqual([]);
    expect(warningLines({}, ctx)).toEqual([]);
  });
});

describe('tradeArgs', () => {
  const form = (extra) => ({ kind: 'buy', trade_date: '2026-10-28', units: '5', price: '130', fees: '', tax_withheld: '', funds_account_id: 'f-usd', ...extra });

  it('turns the form into the database\'s arguments, or says what is missing', () => {
    expect(tradeArgs(form(), ABC)).toEqual({
      errors: {},
      args: { p_kind: 'buy', p_trade_date: '2026-10-28', p_units: 5, p_price: 130, p_fees: 0, p_tax_withheld: 0, p_funds_account_id: 'f-usd', p_tax_to_confirm: false },
    });
    expect(tradeArgs(form({ kind: 'split', price: '999', fees: '3', units: '10' }), ABC).args)
      .toEqual({ p_kind: 'split', p_trade_date: '2026-10-28', p_units: 10, p_price: null, p_fees: 0, p_tax_withheld: 0, p_funds_account_id: null, p_tax_to_confirm: false });
    expect(tradeArgs(form({ kind: 'sell', units: '1' }), XYZ).args.p_tax_to_confirm).toBe(true);
    expect(tradeArgs(form({ kind: 'sell', units: '1', tax_withheld: '20' }), XYZ).args).toMatchObject({ p_tax_withheld: 20, p_tax_to_confirm: false });
    expect(tradeArgs(form({ kind: 'sell', units: '1' }), ABC).args.p_tax_to_confirm).toBe(false);
    expect(tradeArgs(form({ kind: 'opening', units: '10', price: '100', fees: '2' }), ABC).args)
      .toEqual({ p_kind: 'opening', p_trade_date: '2026-10-28', p_units: 10, p_price: 100, p_fees: 0, p_tax_withheld: 0, p_funds_account_id: null, p_tax_to_confirm: false });
  });

  it('says what is missing or wrong, and returns no arguments', () => {
    expect(tradeArgs(form({ units: '' }), ABC)).toEqual({ errors: { units: 'Enter the units.' }, args: null });
    expect(tradeArgs(form({ units: '0' }), ABC).errors.units).toBe('Units must be above 0.');
    expect(tradeArgs(form({ price: '' }), ABC).errors.price).toBe('Enter the price.');
    expect(tradeArgs(form({ fees: '-1' }), ABC).errors.fees).toBe('Brokerage can\'t be below 0.');
    expect(tradeArgs(form({ trade_date: '' }), ABC).errors.trade_date).toBe('Enter the date.');
    const tomorrow = new Date(Date.now() + 2 * 86400000);
    expect(tradeArgs(form({ trade_date: householdToday(tomorrow) }), ABC).errors.trade_date).toBe('A trade can\'t be in the future.');
  });
});
