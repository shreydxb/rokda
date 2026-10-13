import { describe, expect, it } from 'vitest';
import { categoryFromHistory, merchantMatches, normaliseMerchant, pickCategory } from './merchants.js';

describe('normaliseMerchant', () => {
  it('drops store numbers, locations and legal forms that statements add', () => {
    expect(normaliseMerchant('EPPCO SITE 1077')).toBe('eppco');
    expect(normaliseMerchant('ENOC-SITE NO.85')).toBe('enoc');
    expect(normaliseMerchant('NOON MINUTES LLC DUBAI ARE')).toBe('noon minutes');
    expect(normaliseMerchant('Al adil trading co llc')).toBe('al adil');
    expect(normaliseMerchant('MCDONALDS-CIRCLE MALL- DUBAI')).toBe('mcdonalds circle mall');
  });

  it("drops a payment processor's prefix", () => {
    expect(normaliseMerchant('TAP*Keeta')).toBe('keeta');
    expect(normaliseMerchant('FS *SUPERCELLSTORE')).toBe('supercellstore');
    expect(normaliseMerchant('Paymob puranmal sweet')).toBe('paymob puranmal sweet');
    expect(normaliseMerchant('Paymob**Puranmal Sweet')).toBe('puranmal sweet');
  });

  it('keeps a place that is part of the name, and what tells two services apart', () => {
    expect(normaliseMerchant('Dubai Taxi')).toBe('dubai taxi');
    expect(normaliseMerchant('NOON.COM DUBAI ARE')).toBe('noon com');
    expect(normaliseMerchant('NOON DUBAI ARE')).toBe('noon');
    expect(normaliseMerchant('Dubai')).toBe('dubai');
  });
});

describe('merchantMatches', () => {
  it('matches the same merchant however a statement or a person wrote it', () => {
    expect(merchantMatches('eppco', 'EPPCO SITE 1077')).toBe(true);
    expect(merchantMatches('Noon Minutes', 'NOON MINUTES LLC DUBAI ARE')).toBe(true);
    expect(merchantMatches('careem', 'Careem')).toBe(true);
  });

  it('lets a shortened name inherit from the fuller one', () => {
    expect(merchantMatches('Alseer', 'Moisturiser Alseer')).toBe(true);
    expect(merchantMatches('Mall of the Emirates', 'BRED Mall of the Emirates')).toBe(true);
  });

  it('never treats a brand as its own sub-service', () => {
    expect(merchantMatches('Noon', 'Noon Minutes')).toBe(false);
    expect(merchantMatches('Careem', 'CAREEM FOOD')).toBe(false);
    expect(merchantMatches('noon', 'NOON.COM DUBAI ARE')).toBe(false);
    expect(merchantMatches('Burger King', 'Burger King Al Barsha')).toBe(false);
  });

  it('matches whole words only', () => {
    expect(merchantMatches('alse', 'Moisturiser Alseer')).toBe(false);
    expect(merchantMatches('', 'Anything')).toBe(false);
  });
});

describe('categoryFromHistory and pickCategory', () => {
  const history = [
    { merchant: 'EPPCO SITE 1077', category_id: 'fuel', uses: 8, last_used: '2026-02-24' },
    { merchant: 'Eppco', category_id: 'fuel', uses: 9, last_used: '2026-06-15' },
    { merchant: 'Eppco', category_id: 'car-wash', uses: 1, last_used: '2026-07-01' },
    { merchant: 'Careem', category_id: 'taxi', uses: 40, last_used: '2026-06-19' },
    { merchant: 'CAREEM FOOD', category_id: 'delivery', uses: 5, last_used: '2026-01-27' },
    { merchant: 'Noon food', category_id: 'delivery', uses: 2, last_used: '2026-03-01' },
    { merchant: 'Noon food', category_id: 'groceries', uses: 2, last_used: '2026-05-01' },
  ];

  it('takes the category used most for the merchant across all of history', () => {
    expect(categoryFromHistory('eppco', history)).toBe('fuel');
    expect(categoryFromHistory('Careem', history)).toBe('taxi');
    expect(categoryFromHistory('Careem Food', history)).toBe('delivery');
  });

  it('breaks a tie with the most recent use', () => {
    expect(categoryFromHistory('noon food', history)).toBe('groceries');
  });

  it('knows nothing about a merchant it has not seen, or a name too short to trust', () => {
    expect(categoryFromHistory('Talabat', history)).toBeNull();
    expect(categoryFromHistory('du', history)).toBeNull();
  });

  it('puts a household rule ahead of history', () => {
    const rules = [{ pattern: 'eppco', match_type: 'contains', category_id: 'car', archived: false }];
    expect(pickCategory('Eppco', { rules, history })).toEqual({ categoryId: 'car', source: 'rule' });
    expect(pickCategory('Eppco', { rules: [{ ...rules[0], archived: true }], history })).toEqual({ categoryId: 'fuel', source: 'history' });
    expect(pickCategory('Talabat', { rules, history })).toBeNull();
    expect(pickCategory(null, { rules, history })).toBeNull();
  });
});
