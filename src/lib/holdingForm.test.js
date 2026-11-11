import { describe, it, expect } from 'vitest';
import { formValuation, holdingProblems, holdingSave, initialForm, isAutoValued } from './holdingForm';

const HOLDING = {
  id: 'h-1', name: 'Index fund', asset_class: 'us_equity', sector: null, currency: 'USD', value_aed: 1000, is_shared: true, owner_member_id: null,
  quantity: 10, avg_price: 25, current_price: 27.23, invested_value_aed: 920, day_change_pct: null, price_provider: null, price_symbol: null,
  priced_at: '2026-10-01T00:00:00.000Z', trades_version: 0, dividend_tax_pct: null, dividend_fee_per_share: null,
};
const form = (holding = HOLDING, over = {}) => ({ ...initialForm(holding), ...over });
const save = (f, over = {}) => holdingSave(f, { holding: HOLDING, householdId: 'hh', asOf: '2026-11-11', confirmUnchanged: false, ...over });

describe('initialForm', () => {
  it('opens a holding as text fields, and a new one as a shared US share', () => {
    expect(form()).toMatchObject({ name: 'Index fund', value_aed: '1000', quantity: '10', avg_price: '25', day_change_pct: '', owner: 'shared', dividend_tax_pct: '' });
    expect(initialForm(null)).toMatchObject({ name: '', asset_class: 'us_equity', currency: 'USD', owner: 'shared', value_aed: '' });
  });
});

describe('isAutoValued and formValuation', () => {
  it('values a holding from the feed only with a provider, units and a currency it can convert', () => {
    expect(isAutoValued(form(HOLDING, { price_provider: 'feed' }))).toBe(true);
    expect(isAutoValued(form(HOLDING, { price_provider: 'feed', quantity: '' }))).toBe(false);
    expect(isAutoValued(form(HOLDING, { price_provider: 'feed', currency: 'GBP' }))).toBe(false);
  });

  it('reads blanks as nothing, and a symbol only with a provider', () => {
    expect(formValuation(form(HOLDING, { avg_price: '', price_symbol: 'IDX' }))).toEqual({
      value_aed: 1000, quantity: 10, avg_price: null, current_price: 27.23, invested_value_aed: 920, day_change_pct: null, price_provider: null, price_symbol: null,
    });
  });
});

describe('holdingProblems', () => {
  it('needs a name, a symbol for a provider, and a rate and fee that make sense for a dividend payer', () => {
    expect(holdingProblems(form())).toEqual({ name: '', symbol: '', rate: '', fee: '' });
    expect(holdingProblems(form(HOLDING, { name: ' ', price_provider: 'feed', price_symbol: ' ', dividend_tax_pct: '101', dividend_fee_per_share: '-1' }))).toEqual({
      name: 'Name it.', symbol: 'Enter the symbol this provider expects.', rate: 'Enter a rate from 0 to 100.', fee: 'Enter a fee of 0 or more.',
    });
  });
});

describe('holdingSave', () => {
  it('dates a new valuation as of the day given, with a history point', () => {
    const { payload, writesHistory } = save(form(HOLDING, { value_aed: '1100' }));
    expect(payload).toMatchObject({ household_id: 'hh', value_aed: 1100, priced_at: '2026-11-11T00:00:00.000Z' });
    expect(writesHistory).toBe(true);
  });

  it('keeps the valuation date on a rename, unless the unchanged figures are confirmed', () => {
    const renamed = save(form(HOLDING, { name: 'Renamed' }));
    expect(renamed.payload.priced_at).toBe(HOLDING.priced_at);
    expect(renamed.writesHistory).toBe(false);
    const confirmed = save(form(HOLDING, { name: 'Renamed' }), { confirmUnchanged: true });
    expect(confirmed.payload.priced_at).toBe('2026-11-11T00:00:00.000Z');
    expect(confirmed.writesHistory).toBe(true);
  });

  it('confirms nothing for a new holding the feed has not priced yet', () => {
    const { payload, writesHistory } = holdingSave(form(null, { name: 'New', price_provider: 'feed', price_symbol: 'NEW', quantity: '5' }), { holding: null, householdId: 'hh', asOf: '2026-11-11', confirmUnchanged: false });
    expect(payload).not.toHaveProperty('priced_at');
    expect(writesHistory).toBe(false);
  });

  it('sends no units or average for a traded holding, and none of the feed\'s figures when the feed values it', () => {
    const traded = { ...HOLDING, trades_version: 3, price_provider: 'feed', price_symbol: 'IDX' };
    const byHand = holdingSave(form(traded, { price_provider: '' }), { holding: traded, householdId: 'hh', asOf: '2026-11-11', confirmUnchanged: false });
    expect(byHand.payload).not.toHaveProperty('quantity');
    expect(byHand.payload).not.toHaveProperty('avg_price');
    expect(byHand.payload).toHaveProperty('value_aed');
    const byFeed = holdingSave(form(traded, { value_aed: '1200' }), { holding: traded, householdId: 'hh', asOf: '2026-11-11', confirmUnchanged: false });
    for (const field of ['quantity', 'avg_price', 'value_aed', 'current_price', 'day_change_pct', 'priced_at']) expect(byFeed.payload).not.toHaveProperty(field);
    expect(byFeed.writesHistory).toBe(false);
  });

  it('writes a sector only for a share, and a dividend rate and fee only for a payer that has them', () => {
    expect(save(form(HOLDING, { sector: 'technology', dividend_tax_pct: '15' })).payload).toMatchObject({ sector: 'technology', dividend_tax_pct: 15 });
    expect(save(form(HOLDING)).payload).not.toHaveProperty('dividend_tax_pct');
    const gold = save(form(HOLDING, { asset_class: 'gold', sector: 'technology', dividend_tax_pct: '15' })).payload;
    expect(gold.sector).toBeNull();
    expect(gold).not.toHaveProperty('dividend_tax_pct');
  });
});
