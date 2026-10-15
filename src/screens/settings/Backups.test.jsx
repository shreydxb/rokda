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

describe('Settings -> Backups', () => {
  beforeEach(() => {
    inserts.length = 0;
    insertError = null;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T10:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('says when nothing has been recorded', () => {
    renderBackups();
    expect(within(screen.getByTestId('backup-export')).getByText('None recorded yet.')).toBeTruthy();
    expect(within(screen.getByTestId('backup-drill')).getByText('None recorded yet.')).toBeTruthy();
  });

  it('shows the last export and drill that passed, and who recorded each', () => {
    renderBackups([
      { id: 'r1', kind: 'export', result: 'passed', done_on: '2026-10-01', recorded_by: 'm1', note: 'Kept offline', created_at: '2026-10-01T10:00:00Z' },
      { id: 'r2', kind: 'restore_drill', result: 'passed', done_on: '2026-09-19', recorded_by: null, created_at: '2026-09-19T10:00:00Z' },
    ]);
    expect(within(screen.getByTestId('backup-export')).getByText('Passed on 1 Oct 2026 · 14 days ago')).toBeTruthy();
    expect(within(screen.getByTestId('backup-drill')).getByText('Passed on 19 Sept 2026')).toBeTruthy();
    expect(screen.getAllByTestId('backup-record')[0].textContent).toContain('Recorded by Alex · Kept offline');
  });

  it('says plainly when the newest export failed', () => {
    renderBackups([
      { id: 'r1', kind: 'export', result: 'passed', done_on: '2026-09-01', created_at: '2026-09-01T10:00:00Z' },
      { id: 'r2', kind: 'export', result: 'failed', done_on: '2026-10-10', created_at: '2026-10-10T10:00:00Z' },
    ]);
    expect(within(screen.getByTestId('backup-export')).getByText('The last one, on 10 Oct 2026, failed.')).toBeTruthy();
  });

  it('records what was done, leaving who did it to the database', async () => {
    const { reload } = renderBackups();
    fireEvent.change(screen.getByRole('combobox', { name: 'What was done' }), { target: { value: 'restore_drill' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Scratch project, deleted after' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('permission denied');
    expect(reload).not.toHaveBeenCalled();
  });
});
