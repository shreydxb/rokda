import { useId, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { EXPORT_DUE_DAYS, backupStatus } from '../../lib/backups';
import { daysBetweenDays, householdToday, parseDay } from '../../lib/day';
import { shortDate } from '../../lib/dividends';
import { Avatar, Card, Chip, EmptyState, InfoButton } from '../../design-system/kit';
import './SettingsTabs.css';

// Settings -> Backups, like the prototype (the revamp, phase 7b; review
// S-backups): when the household's data was last exported and last restored
// from an export (docs/decisions.md, "A backup is recorded, and an old one
// says so"; SHR-238), a form to record one, and the history as a table. Both
// are done by hand, following docs/backup-restore.md.
const RUNBOOK = 'https://github.com/shreydxb/rokda/blob/main/docs/backup-restore.md';
const KINDS = { export: 'Export', restore_drill: 'Restore drill' };

export default function Backups({ household, members = [], data, loading }) {
  const uid = useId();
  const { backupRecords = [], reload } = data;
  const [form, setForm] = useState(() => ({ kind: 'export', result: 'passed', done_on: householdToday(), note: '' }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const status = backupStatus(backupRecords);
  const today = householdToday();
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function record(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    // Who recorded it is set by the database, from the signed-in member.
    const { error: insertError } = await supabase.from('backup_records').insert({
      household_id: household.id,
      kind: form.kind,
      result: form.result,
      done_on: form.done_on,
      note: form.note.trim() || null,
    });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setForm((f) => ({ ...f, note: '' }));
    await reload();
  }

  // Each kind's newest record, how long ago, and a chip: OK, Late (an export
  // older than the days allowed), Failed (the newest one failed) or Missing.
  const line = (label, latest, chip) => (
    <div className="st-row">
      <div className="st-row-main">
        <div className="st-row-title">{label}</div>
        <div className="st-row-sub">
          {latest ? `${latest.result === 'failed' ? 'Failed' : 'Passed'} ${shortDate(latest.done_on, today)} · ${daysBetweenDays(parseDay(latest.done_on), new Date())} days ago` : 'None recorded'}
        </div>
      </div>
      {chip}
    </div>
  );
  const exportChip = status.lastExportFailed ? (
    <Chip tone="neg">Failed</Chip>
  ) : !status.lastExport ? (
    <Chip tone="warn">Missing</Chip>
  ) : status.exportDue ? (
    <Chip tone="warn">Late</Chip>
  ) : (
    <Chip tone="pos">OK</Chip>
  );
  const drillChip = status.lastDrillFailed ? <Chip tone="neg">Failed</Chip> : !status.lastDrill ? <Chip tone="warn">Missing</Chip> : <Chip tone="pos">OK</Chip>;
  const avatarOf = (id) => {
    const at = members.findIndex((m) => m.id === id);
    if (at < 0) return '—';
    const m = members[at];
    return <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={at === 0 ? 'a' : 'b'} />;
  };

  return (
    <div className="st-grid st-grid-5-7">
      <div className="st-stack">
        <Card
          title="Latest"
          info={
            <InfoButton about="Latest">
              Exports and restore drills are done by hand, following the runbook. An export is due every {EXPORT_DUE_DAYS} days. What is recorded here is what someone said they did, not a check the app ran.
            </InfoButton>
          }
          right={
            <a className="st-link" href={RUNBOOK} target="_blank" rel="noreferrer">
              Runbook →
            </a>
          }
          flush
        >
          <div className="st-rows">
            {line('Export', status.lastExport, exportChip)}
            {line('Restore drill', status.lastDrill, drillChip)}
          </div>
        </Card>

        <Card title="Record a backup">
          <form className="st-fields" onSubmit={record} noValidate>
            <div className="st-field-row">
              <div className="st-field">
                <label className="st-label" htmlFor={`${uid}-kind`}>
                  Kind
                </label>
                <select id={`${uid}-kind`} className="ds-select st-input" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
                  <option value="export">Export</option>
                  <option value="restore_drill">Restore drill</option>
                </select>
              </div>
              <div className="st-field">
                <label className="st-label" htmlFor={`${uid}-result`}>
                  Result
                </label>
                <select id={`${uid}-result`} className="ds-select st-input" value={form.result} onChange={(e) => set('result', e.target.value)}>
                  <option value="passed">Passed</option>
                  <option value="failed">Failed</option>
                </select>
              </div>
            </div>
            <div className="st-field">
              <label className="st-label" htmlFor={`${uid}-date`}>
                Date
              </label>
              <input id={`${uid}-date`} className="ds-select st-input" type="date" value={form.done_on} max={today} onChange={(e) => set('done_on', e.target.value)} />
            </div>
            <div className="st-field">
              <label className="st-label" htmlFor={`${uid}-note`}>
                Note
              </label>
              <input id={`${uid}-note`} className="ds-select st-input" type="text" maxLength={2000} placeholder="Where it is kept, or what went wrong" value={form.note} onChange={(e) => set('note', e.target.value)} />
            </div>
            {error && (
              <p className="ds-warn-ink st-note" role="alert">
                {error}
              </p>
            )}
            <div>
              <button type="submit" className="ds-btn ds-btn-primary" disabled={saving || !form.done_on}>
                {saving ? 'Saving…' : 'Record'}
              </button>
            </div>
          </form>
        </Card>
      </div>

      <Card title="History" right={backupRecords.length ? <span>{`${backupRecords.length} recorded`}</span> : null} flush>
        {backupRecords.length === 0 ? (
          <EmptyState title="None recorded yet" />
        ) : (
          <div className="ds-table-wrap">
            <table className="ds-table st-history">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Result</th>
                  <th scope="col">By</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {backupRecords.map((r) => (
                  <tr key={r.id}>
                    <td className="ds-muted st-mono">{shortDate(r.done_on, today)}</td>
                    <td>{KINDS[r.kind] ?? r.kind}</td>
                    <td>{r.result === 'failed' ? <Chip tone="neg">Failed</Chip> : <Chip tone="pos">Passed</Chip>}</td>
                    <td>{avatarOf(r.recorded_by)}</td>
                    <td className="st-note-cell">{r.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
