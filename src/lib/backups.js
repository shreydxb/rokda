// When the household's data was last backed up and last restored from a
// backup (docs/decisions.md, "A backup is recorded, and an old one says so";
// SHR-238).
//
// Exports and restore drills are done by hand (docs/backup-restore.md) and
// recorded in backup_records. These helpers read that record: the latest of
// each kind, whether the newest export failed, and whether the last one that
// passed is too old to count on.
import { daysBetweenDays, parseDay } from './day';

// A monthly export, with a few days' slack before it is called overdue.
export const EXPORT_DUE_DAYS = 35;

const newestFirst = (a, b) =>
  a.done_on !== b.done_on ? (a.done_on < b.done_on ? 1 : -1) : String(a.created_at ?? '') < String(b.created_at ?? '') ? 1 : -1;

export function latestRecord(records = [], kind, { passedOnly = false } = {}) {
  return records.filter((r) => r.kind === kind && (!passedOnly || r.result === 'passed')).sort(newestFirst)[0] ?? null;
}

export function backupStatus(records = [], now = new Date()) {
  const lastExport = latestRecord(records, 'export');
  const lastPassedExport = latestRecord(records, 'export', { passedOnly: true });
  const lastPassedDrill = latestRecord(records, 'restore_drill', { passedOnly: true });
  const daysSinceExport = lastPassedExport ? daysBetweenDays(parseDay(lastPassedExport.done_on), now) : null;
  return {
    lastExport,
    lastPassedExport,
    lastPassedDrill,
    daysSinceExport,
    // The newest export is the one that failed: whatever passed before it is
    // older than anyone believed.
    lastExportFailed: lastExport?.result === 'failed',
    exportDue: daysSinceExport === null || daysSinceExport > EXPORT_DUE_DAYS,
  };
}
