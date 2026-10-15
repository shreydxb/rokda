import { describe, expect, it } from 'vitest';
import { EXPORT_DUE_DAYS, backupStatus, latestRecord } from './backups';

const NOW = new Date('2026-10-15T10:00:00');
const rec = (kind, result, done_on, created_at = `${done_on}T12:00:00Z`) => ({ kind, result, done_on, created_at });

describe('backupStatus', () => {
  it('has nothing to go on when nothing is recorded, so an export is due', () => {
    expect(backupStatus([], NOW)).toMatchObject({ lastExport: null, lastPassedExport: null, lastPassedDrill: null, daysSinceExport: null, exportDue: true, lastExportFailed: false });
  });

  it('counts days from the last export that passed', () => {
    const status = backupStatus([rec('export', 'passed', '2026-10-01'), rec('restore_drill', 'passed', '2026-09-19')], NOW);
    expect(status.daysSinceExport).toBe(14);
    expect(status.exportDue).toBe(false);
    expect(status.lastPassedDrill.done_on).toBe('2026-09-19');
  });

  it(`is due once the last passing export is more than ${EXPORT_DUE_DAYS} days old`, () => {
    expect(backupStatus([rec('export', 'passed', '2026-09-10')], NOW).exportDue).toBe(false);
    expect(backupStatus([rec('export', 'passed', '2026-09-09')], NOW).exportDue).toBe(true);
  });

  it('says when the newest export failed, and still knows the last one that passed', () => {
    const status = backupStatus([rec('export', 'passed', '2026-09-01'), rec('export', 'failed', '2026-10-01')], NOW);
    expect(status.lastExportFailed).toBe(true);
    expect(status.lastPassedExport.done_on).toBe('2026-09-01');
  });

  it('a failure followed by a pass is not a failure', () => {
    expect(backupStatus([rec('export', 'failed', '2026-10-01'), rec('export', 'passed', '2026-10-02')], NOW).lastExportFailed).toBe(false);
  });
});

describe('latestRecord', () => {
  it('takes the later record on the same day', () => {
    const first = rec('export', 'failed', '2026-10-01', '2026-10-01T08:00:00Z');
    const second = rec('export', 'passed', '2026-10-01', '2026-10-01T09:00:00Z');
    expect(latestRecord([second, first], 'export')).toBe(second);
  });
});
