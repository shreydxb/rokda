import { describe, it, expect } from 'vitest';
import {
  HOLDING_STALE_DAYS,
  daysSincePriced,
  historyPointFor,
  isStale,
  nextPricedAt,
  valuationChanged,
  valueFieldFor,
  isPendingValuation,
} from './valuation';
import { buildAttentionItems } from './attention';

const NOW = new Date('2026-09-05T12:00:00Z');
const STALE_DATE = '2026-06-01T00:00:00Z'; // ~96 days before NOW
const HOLDING = {
  id: 'h1',
  name: 'VWRA',
  asset_class: 'intl_equity',
  is_shared: true,
  value_aed: 10_000,
  quantity: 10,
  avg_price: 100,
  current_price: 110,
  invested_value_aed: 9000,
  day_change_pct: 0.5,
  priced_at: STALE_DATE,
};

// QA-04 / SHR-245 acceptance: "refreshing or renaming a stale holding leaves
// it stale; confirming a new valuation creates a dated history point."
describe('QA-04: valuation freshness', () => {
  it('treats a holding priced months ago as stale', () => {
    expect(daysSincePriced(HOLDING, NOW)).toBeGreaterThan(HOLDING_STALE_DAYS);
    expect(isStale(HOLDING, NOW)).toBe(true);
  });

  it('treats a holding that was never valued as stale, not as fresh', () => {
    expect(isStale({ ...HOLDING, priced_at: null }, NOW)).toBe(true);
    expect(daysSincePriced({ ...HOLDING, priced_at: null }, NOW)).toBeNull();
  });

  it('leaves a stale holding stale when only the name changes', () => {
    const renamed = { ...HOLDING, name: 'Vanguard All-World' };
    expect(valuationChanged(HOLDING, renamed)).toBe(false);
    expect(nextPricedAt(HOLDING, renamed, { confirmedAsOf: '2026-09-05' })).toBe(STALE_DATE);
    expect(isStale({ ...renamed, priced_at: nextPricedAt(HOLDING, renamed) }, NOW)).toBe(true);
  });

  it('leaves a stale holding stale when the screen is merely reloaded', () => {
    // Reloading re-reads the same row: nothing about it changes.
    expect(nextPricedAt(HOLDING, HOLDING)).toBe(STALE_DATE);
    expect(isStale(HOLDING, NOW)).toBe(true);
  });

  it('advances the valuation date only when a number changes and a date is confirmed', () => {
    const repriced = { ...HOLDING, value_aed: 12_000 };
    expect(valuationChanged(HOLDING, repriced)).toBe(true);
    expect(nextPricedAt(HOLDING, repriced, { confirmedAsOf: '2026-09-05' })).toBe('2026-09-05T00:00:00.000Z');
    expect(isStale({ ...repriced, priced_at: '2026-09-05T00:00:00.000Z' }, NOW)).toBe(false);
  });

  it('notices a change in any priced field, not just the AED value', () => {
    for (const field of ['quantity', 'avg_price', 'current_price', 'invested_value_aed', 'day_change_pct']) {
      expect(valuationChanged(HOLDING, { ...HOLDING, [field]: 999 })).toBe(true);
    }
  });

  it('treats an unset number and an empty string as the same value', () => {
    const blank = { ...HOLDING, day_change_pct: null };
    expect(valuationChanged(blank, { ...blank, day_change_pct: '' })).toBe(false);
  });

  // SHR-245 QA recheck: a value that's still accurate months later — same
  // AED figure in June and in September — could not be honestly reconfirmed
  // without fabricating a numeric change. An explicit reconfirmation (the
  // caller passes the stored holding back as both `before` and `after`) must
  // be able to advance priced_at on its own.
  it('lets an explicit reconfirmation advance the date with no numeric change', () => {
    expect(valuationChanged(HOLDING, HOLDING)).toBe(false);
    expect(nextPricedAt(HOLDING, HOLDING, { confirmedAsOf: '2026-09-06' })).toBe('2026-09-06T00:00:00.000Z');
  });

  it('produces a dated history point keyed for idempotent re-confirmation', () => {
    const point = historyPointFor('h1', '2026-09-05', 12_000);
    expect(point).toEqual({ holding_id: 'h1', as_of: '2026-09-05', value_aed: 12_000 });
    // Same day twice yields an identical row, so an upsert on
    // (holding_id, as_of) cannot create a duplicate point.
    expect(historyPointFor('h1', '2026-09-05', 12_000)).toEqual(point);
  });
});

describe('QA-04: the staleness warning', () => {
  const args = { transactions: [], recurring: [], accounts: [], categories: [], scopeMemberId: null, now: NOW };

  it('stands after a rename', () => {
    const renamed = { ...HOLDING, name: 'Vanguard All-World', priced_at: STALE_DATE };
    const items = buildAttentionItems({ ...args, holdings: [renamed] });
    expect(items.some((i) => i.kind === 'stale_holding')).toBe(true);
  });

  it('clears only once a valuation is confirmed', () => {
    const repriced = { ...HOLDING, value_aed: 12_000, priced_at: '2026-09-04T00:00:00Z' };
    const items = buildAttentionItems({ ...args, holdings: [repriced] });
    expect(items.some((i) => i.kind === 'stale_holding')).toBe(false);
  });
});

// Reopening a pending holding used to certify its placeholder zero. The stored
// value is numeric 0 (the column is not null); rehydrating it as '0' made the
// editor stop treating the holding as pending, and the next save stamped
// priced_at and wrote a zero history point for a value nobody supplied.
describe('reopening a holding that has never been valued', () => {
  const pending = { id: 'h1', value_aed: 0, invested_value_aed: 10000, priced_at: null };
  const valued = { id: 'h2', value_aed: 12000, invested_value_aed: 10000, priced_at: '2026-09-01T00:00:00Z' };

  it('brings the value back blank, not as the string zero', () => {
    expect(valueFieldFor(pending)).toBe('');
    // The old rehydration produced '0' here, which is not blank.
    expect(valueFieldFor(valued)).toBe('12000');
  });

  it('keeps a confirmed zero as a real zero', () => {
    // Somebody actually said this is worth nothing, and priced_at proves it.
    expect(valueFieldFor({ ...pending, priced_at: '2026-09-01T00:00:00Z' })).toBe('0');
  });

  it('stays pending on reopen even when the form looks fully auto-valued', () => {
    // This is the reported case: quantity and provider are set, so autoValued
    // is true, and the old condition only asked whether the field was blank.
    expect(isPendingValuation({ holding: pending, valueField: valueFieldFor(pending), autoValued: true })).toBe(true);
  });

  it('stays pending even when nothing about the form says auto-valued', () => {
    expect(isPendingValuation({ holding: pending, valueField: '', autoValued: false })).toBe(true);
  });

  it('stops being pending the moment someone supplies a number', () => {
    expect(isPendingValuation({ holding: pending, valueField: '9500', autoValued: true })).toBe(false);
    // Including a deliberate zero, typed by a person.
    expect(isPendingValuation({ holding: pending, valueField: '0', autoValued: true })).toBe(false);
  });

  it('is not pending for a holding that already has a valuation', () => {
    expect(isPendingValuation({ holding: valued, valueField: '12000', autoValued: true })).toBe(false);
  });

  it('certifies nothing while pending, so a quantity correction cannot stamp a date', () => {
    // nextPricedAt is only consulted when the edit is not pending; this is the
    // guarantee the editor relies on.
    const pendingNow = isPendingValuation({ holding: pending, valueField: '', autoValued: true });
    const nextPriced = pendingNow ? null : nextPricedAt(pending, { ...pending, quantity: 12 }, { confirmedAsOf: '2026-09-20' });
    expect(nextPriced).toBeNull();
  });
});
