import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { EXPORT_DUE_DAYS, backupStatus } from '../../lib/backups';
import { householdToday } from '../../lib/day';

// Settings -> Backups: when the household's data was last exported and last
// restored from an export (docs/decisions.md, "A backup is recorded, and an
// old one says so"; SHR-238). Both are done by hand, following
// docs/backup-restore.md, and recorded here, where an old one shows.
const RUNBOOK = 'https://github.com/shreydxb/rokda/blob/main/docs/backup-restore.md';
const KINDS = { export: 'Export', restore_drill: 'Restore drill' };

const fieldStyle = {
  background: 'none',
  border: '1px solid var(--rule2)',
  borderRadius: 'var(--radius-sm)',
  padding: '9px 10px',
  fontSize: 14,
  color: 'var(--ink)',
  fontFamily: 'inherit',
};

function longDay(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Backups({ household, members = [], data, loading }) {
  const { backupRecords = [], reload } = data;
  const [form, setForm] = useState(() => ({ kind: 'export', result: 'passed', done_on: householdToday(), note: '' }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const status = backupStatus(backupRecords);
  const memberName = (id) => members.find((m) => m.id === id)?.display_name ?? null;
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

  return (
    <div>
      <section style={{ marginTop: 26, maxWidth: 520 }}>
        <div className="ov-kicker" style={{ marginBottom: 12 }}>
          Latest
        </div>
        <div className="mn-list">
          <div className="mn-row" data-testid="backup-export">
            <div className="mn-row-main">
              <div>Export</div>
              <div className={status.lastExportFailed || status.exportDue ? 'ov-warn' : 'ov-muted'}>
                {status.lastExportFailed
                  ? `The last one, on ${longDay(status.lastExport.done_on)}, failed.`
                  : status.lastPassedExport
                    ? `Passed on ${longDay(status.lastPassedExport.done_on)} · ${status.daysSinceExport} days ago${status.exportDue ? `, more than the ${EXPORT_DUE_DAYS} allowed` : ''}`
                    : 'None recorded yet.'}
              </div>
            </div>
          </div>
          <div className="mn-row" data-testid="backup-drill">
            <div className="mn-row-main">
              <div>Restore drill</div>
              <div className="ov-muted">
                {status.lastPassedDrill ? `Passed on ${longDay(status.lastPassedDrill.done_on)}` : 'None recorded yet.'}
              </div>
            </div>
          </div>
        </div>
        <div className="ov-muted" style={{ fontSize: 11.5, lineHeight: 1.65, marginTop: 10 }}>
          Exports and restore drills are taken by hand, following{' '}
          <a href={RUNBOOK} target="_blank" rel="noreferrer">
            the backup and restore runbook
          </a>
          . An export is due every {EXPORT_DUE_DAYS} days; Needs attention says so when one is late or the last one failed.
          What is recorded here is what someone said they did, not a check the app ran.
        </div>
      </section>

      <section style={{ marginTop: 34, maxWidth: 520 }}>
        <div className="ov-kicker" style={{ marginBottom: 12 }}>
          Record one
        </div>
        <form onSubmit={record} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select aria-label="What was done" value={form.kind} onChange={(e) => set('kind', e.target.value)} style={fieldStyle}>
            <option value="export">Export</option>
            <option value="restore_drill">Restore drill</option>
          </select>
          <input aria-label="Day it was done" type="date" value={form.done_on} max={householdToday()} onChange={(e) => set('done_on', e.target.value)} style={fieldStyle} required />
          <select aria-label="Result" value={form.result} onChange={(e) => set('result', e.target.value)} style={fieldStyle}>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
          </select>
          <input
            aria-label="Note"
            type="text"
            maxLength={2000}
            placeholder="Where it is kept, or what went wrong (optional)"
            value={form.note}
            onChange={(e) => set('note', e.target.value)}
            style={{ ...fieldStyle, flex: '1 1 220px', minWidth: 0 }}
          />
          <button type="submit" className="om-btn" disabled={saving || !form.done_on}>
            {saving ? 'Saving…' : 'Record'}
          </button>
        </form>
        {error && (
          <p className="ov-warn" role="alert" style={{ fontSize: 12.5, marginTop: 8 }}>
            {error}
          </p>
        )}
      </section>

      {backupRecords.length > 0 && (
        <section style={{ marginTop: 34, maxWidth: 520 }}>
          <div className="ov-kicker" style={{ marginBottom: 12 }}>
            History
          </div>
          <div className="mn-list">
            {backupRecords.map((r) => (
              <div className="mn-row" key={r.id} data-testid="backup-record">
                <div className="mn-row-main">
                  <div>
                    {`${KINDS[r.kind] ?? r.kind} · ${longDay(r.done_on)}`}
                    <span className={r.result === 'failed' ? 'ov-warn' : 'ov-muted'}>{r.result === 'failed' ? ' · failed' : ' · passed'}</span>
                  </div>
                  <div className="ov-muted" style={{ fontSize: 11.5 }}>
                    {[memberName(r.recorded_by) && `Recorded by ${memberName(r.recorded_by)}`, r.note].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
