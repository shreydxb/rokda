// Month close (QA-05, SHR-246).
//
// net_worth_snapshots was read but never written: no app writer, no trigger,
// no Edge Function, no cron. The UI said history "builds up month by month",
// which waiting alone would never make true. History accumulates because
// someone closes a month — an explicit, repeatable act — and closing the same
// month twice must change nothing.

import { monthKey, startOfMonth } from './day';

// Snapshots are stored on the 1st of the month they describe.
export function snapshotDateFor(date) {
  const start = startOfMonth(date);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
}

export function snapshotMonthKeys(snapshots = []) {
  return new Set(snapshots.map((s) => monthKey(String(s.snapshot_date))));
}

// The most recent COMPLETED month. The current one is still running and is
// shown live from real balances instead.
export function lastClosedMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

// Whether the last completed month still needs closing.
export function pendingClose(snapshots = [], now = new Date()) {
  const month = lastClosedMonth(now);
  const key = monthKey(month);
  if (snapshotMonthKeys(snapshots).has(key)) return null;
  return { month, snapshotDate: snapshotDateFor(month), key };
}

// The row a close writes. Upserting on (household_id, snapshot_date) — the
// table's existing unique key — makes closing the same month twice idempotent.
export function closeRowFor(householdId, snapshotDate, { assets, liabilities }) {
  return {
    household_id: householdId,
    snapshot_date: snapshotDate,
    assets: Number(assets) || 0,
    liabilities: Number(liabilities) || 0,
  };
}

// History exists only if something wrote it. "Not configured yet" is the
// honest state, not "check back next month".
export function historyState(snapshots = []) {
  if (snapshots.length === 0) return 'none';
  if (snapshots.length === 1) return 'started';
  return 'accumulating';
}
