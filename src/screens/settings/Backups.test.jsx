import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// The screen's only write: recording a backup. The client is mocked so the
// test sees exactly what it sends.
const inserts = [];
let insertError = null;
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: (row) => {
        inserts.push({ table, row });
        return Promise.resolve({ error: insertError });
      },
    }),
  },
}));

const { default: Backups } = await import('./Backups');

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];

function renderBackups(records = []) {
  const reload = vi.fn().mockResolvedValue(undefined);
  renderScreen(<Backups household={{ id: 'h1' }} members={MEMBERS} loading={false} data={{ backupRecords: records, reload }} />);
  return { reload };
}
const latest = () => screen.getByRole('region', { name: 'Latest' });
const line = (kind) => within(latest()).getByText(kind).closest('.st-row');
const form = () => screen.getByRole('region', { name: 'Record a backup' });
const history = () => screen.getByRole('region', { name: 'History' });

// Settings -> Backups like the prototype (the revamp, phase 7b): Latest with a
// chip each, a labelled form, and the history as a table.
describe('Settings -> Backups', () => {
  beforeEach(() => {
    inserts.length = 0;
    insertError = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T10:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('says Missing when nothing has been recorded', () => {
    renderBackups();
    expect(line('Export').textContent).toBe('ExportNone recordedMissing');
    expect(line('Restore drill').textContent).toBe('Restore drillNone recordedMissing');
    expect(within(history()).getByText('None recorded yet')).toBeTruthy();
  });

  it('shows the last export and drill, how long ago, and OK', () => {
    renderBackups([
      { id: 'r1', kind: 'export', result: 'passed', done_on: '2026-10-01', recorded_by: 'm1', note: 'Kept offline', created_at: '2026-10-01T10:00:00Z' },
      { id: 'r2', kind: 'restore_drill', result: 'passed', done_on: '2026-09-19', recorded_by: null, created_at: '2026-09-19T10:00:00Z' },
    ]);
    expect(line('Export').textContent).toBe('ExportPassed 1 Oct · 14 days agoOK');
    expect(line('Restore drill').textContent).toBe('Restore drillPassed 19 Sep · 26 days agoOK');
  });

  it(`says Late once the last export is more than 35 days old`, () => {
    renderBackups([{ id: 'r1', kind: 'export', result: 'passed', done_on: '2026-09-01', created_at: '2026-09-01T10:00:00Z' }]);
    expect(line('Export').textContent).toBe('ExportPassed 1 Sep · 44 days agoLate');
  });

  it('says plainly when the newest export or drill failed', () => {
    renderBackups([
      { id: 'r1', kind: 'export', result: 'passed', done_on: '2026-09-01', created_at: '2026-09-01T10:00:00Z' },
      { id: 'r2', kind: 'export', result: 'failed', done_on: '2026-10-10', created_at: '2026-10-10T10:00:00Z' },
      { id: 'r3', kind: 'restore_drill', result: 'failed', done_on: '2026-10-12', created_at: '2026-10-12T10:00:00Z' },
    ]);
    expect(line('Export').textContent).toBe('ExportFailed 10 Oct · 5 days agoFailed');
    expect(line('Restore drill').textContent).toBe('Restore drillFailed 12 Oct · 3 days agoFailed');
  });

  // The fresh review of 7b: the form no longer stops a later date itself,
  // and one would stay the newest export for good.
  it('will not record a day after today', () => {
    renderBackups();
    fireEvent.change(within(form()).getByLabelText('Date'), { target: { value: '2026-10-16' } });
    expect(within(form()).getByRole('button', { name: 'Record' }).disabled).toBe(true);
    expect(within(form()).getByText("The date can't be after today.")).toBeTruthy();
  });

  it('says today, and 1 day ago, in words', () => {
    renderBackups([
      { id: 'r1', kind: 'export', result: 'passed', done_on: '2026-10-15', created_at: '2026-10-15T08:00:00Z' },
      { id: 'r2', kind: 'restore_drill', result: 'passed', done_on: '2026-10-14', created_at: '2026-10-14T08:00:00Z' },
    ]);
    expect(line('Export').textContent).toBe('ExportPassed 15 Oct · todayOK');
    expect(line('Restore drill').textContent).toBe('Restore drillPassed 14 Oct · 1 day agoOK');
  });

  it('puts the runbook a link away, and the rest behind an (i)', () => {
    renderBackups();
    expect(within(latest()).getByRole('link', { name: 'Runbook →' }).getAttribute('href')).toMatch(/docs\/backup-restore\.md$/);
    expect(within(latest()).getByRole('button', { name: 'About Latest' })).toBeTruthy();
  });

  it('lists the history as a table, with who recorded each', () => {
    renderBackups([
      { id: 'r1', kind: 'export', result: 'passed', done_on: '2026-10-01', recorded_by: 'm1', note: 'Kept offline', created_at: '2026-10-01T10:00:00Z' },
      { id: 'r2', kind: 'restore_drill', result: 'failed', done_on: '2025-09-19', recorded_by: null, note: null, created_at: '2025-09-19T10:00:00Z' },
    ]);
    expect(within(history()).getByText('2 recorded')).toBeTruthy();
    const rows = within(history()).getAllByRole('row').slice(1).map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent));
    expect(rows).toEqual([
      ['1 Oct', 'Export', 'Passed', 'A', 'Kept offline'],
      ['19 Sep 2025', 'Restore drill', 'Failed', '—', '—'],
    ]);
  });

  it('records what was done, leaving who did it to the database', async () => {
    const { reload } = renderBackups();
    fireEvent.change(within(form()).getByLabelText('Kind'), { target: { value: 'restore_drill' } });
    fireEvent.change(within(form()).getByLabelText('Note'), { target: { value: 'Scratch project, deleted after' } });
    expect(within(form()).getByLabelText('Date').value).toBe('2026-10-15');
    await act(async () => {
      fireEvent.click(within(form()).getByRole('button', { name: 'Record' }));
    });
    expect(inserts).toEqual([
      { table: 'backup_records', row: { household_id: 'h1', kind: 'restore_drill', result: 'passed', done_on: '2026-10-15', note: 'Scratch project, deleted after' } },
    ]);
    expect(reload).toHaveBeenCalled();
  });

  it('says so when recording fails', async () => {
    insertError = { message: 'permission denied' };
    const { reload } = renderBackups();
    await act(async () => {
      fireEvent.click(within(form()).getByRole('button', { name: 'Record' }));
    });
    expect(within(form()).getByRole('alert').textContent).toBe('permission denied');
    expect(reload).not.toHaveBeenCalled();
  });
});
