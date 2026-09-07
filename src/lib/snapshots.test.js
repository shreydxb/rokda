import { describe, it, expect } from 'vitest';
import { closeRowFor, historyState, lastClosedMonth, pendingClose, snapshotDateFor, snapshotMonthKeys } from './snapshots';
import { historyPointFor } from './valuation';

const NOW = new Date(2026, 8, 5, 12); // 5 September 2026

// QA-05 / SHR-246 acceptance: "two synthetic valuations produce two dated
// points; closing a month twice is idempotent."
describe('QA-05: valuation history accumulates from confirmed valuations', () => {
  it('produces two distinct dated points from two valuations', () => {
    const first = historyPointFor('h1', '2026-07-31', 10_000);
    const second = historyPointFor('h1', '2026-08-31', 11_000);
    const points = [first, second];
    expect(points).toHaveLength(2);
    expect(new Set(points.map((p) => p.as_of)).size).toBe(2);
    expect(points.map((p) => p.value_aed)).toEqual([10_000, 11_000]);
  });

  it('produces an identical row for the same day, so an upsert cannot duplicate it', () => {
    expect(historyPointFor('h1', '2026-08-31', 11_000)).toEqual(historyPointFor('h1', '2026-08-31', 11_000));
  });
});

describe('QA-05: closing a month', () => {
  it('offers the last completed month, not the running one', () => {
    expect(lastClosedMonth(NOW).getMonth()).toBe(7); // August
    expect(pendingClose([], NOW).snapshotDate).toBe('2026-08-01');
  });

  it('stores the snapshot on the first of the month it describes', () => {
    expect(snapshotDateFor(new Date(2026, 7, 31))).toBe('2026-08-01');
  });

  it('has nothing pending once that month is closed', () => {
    const snapshots = [{ snapshot_date: '2026-08-01', assets: 100, liabilities: 0 }];
    expect(pendingClose(snapshots, NOW)).toBeNull();
  });

  it('is idempotent: closing twice produces the same row for the same key', () => {
    const once = closeRowFor('hh', '2026-08-01', { assets: 1000, liabilities: 400 });
    const twice = closeRowFor('hh', '2026-08-01', { assets: 1000, liabilities: 400 });
    expect(once).toEqual(twice);
    expect(once).toEqual({ household_id: 'hh', snapshot_date: '2026-08-01', assets: 1000, liabilities: 400 });
    // The table's unique key is (household_id, snapshot_date), so an upsert on
    // it replaces rather than appends.
    expect(snapshotMonthKeys([once, twice]).size).toBe(1);
  });

  it('reports history as not configured rather than as coming soon', () => {
    expect(historyState([])).toBe('none');
    expect(historyState([{ snapshot_date: '2026-08-01' }])).toBe('started');
    expect(historyState([{ snapshot_date: '2026-07-01' }, { snapshot_date: '2026-08-01' }])).toBe('accumulating');
  });

  it('handles a January close crossing the year boundary', () => {
    const january = new Date(2027, 0, 10);
    expect(pendingClose([], january).snapshotDate).toBe('2026-12-01');
  });
});
