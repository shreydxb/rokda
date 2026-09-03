import { useState } from 'react';
import { formatSigned } from '../../lib/money';
import { rollForward } from '../../lib/recurring';
import RecurringEditor from './RecurringEditor';

export default function Recurring({ household, members, data, loading }) {
  const { recurring, accounts, categories, reload } = data;
  const [editing, setEditing] = useState(null);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const bills = recurring.filter((r) => Number(r.amount) < 0);
  const income = recurring.filter((r) => Number(r.amount) >= 0);
  const fixedTotal = bills.filter((r) => r.is_fixed).reduce((s, r) => s + -Number(r.amount), 0);
  const variableTotal = bills.filter((r) => !r.is_fixed).reduce((s, r) => s + -Number(r.amount), 0);

  return (
    <div>
      <div className="mn-filters">
        <div className="ov-muted">
          Fixed {fixedTotal.toLocaleString()} · Variable ~{variableTotal.toLocaleString()}
        </div>
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Add recurring
        </button>
      </div>

      {recurring.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">Nothing set up</div>
          <div className="ov-empty-body">
            No recurring bills or expected income yet. Add them here and they'll surface on Overview's Next 30 days.
          </div>
          <div className="ov-empty-actions">
            <button type="button" className="om-btn ov-btn-primary" onClick={() => setEditing('new')}>
              Add recurring
            </button>
          </div>
        </div>
      ) : (
        <>
          <RecurringGroup title="Bills" rows={bills} members={members} onEdit={setEditing} />
          <RecurringGroup title="Expected income" rows={income} members={members} onEdit={setEditing} />
        </>
      )}

      {editing && (
        <RecurringEditor
          item={editing === 'new' ? null : editing}
          householdId={household?.id}
          accounts={accounts}
          categories={categories}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function RecurringGroup({ title, rows, members, onEdit }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 28 }}>
      <div className="ov-kicker" style={{ marginBottom: 8 }}>
        {title}
      </div>
      <div className="mn-list">
        {rows.map((r) => (
          <button key={r.id} type="button" className="mn-row" onClick={() => onEdit(r)}>
            <div className="mn-row-main">
              <div>
                {r.name} {r.active === false && <span className="ov-muted">· paused</span>}
              </div>
              <div className="ov-muted">
                {r.cadence} · next {rollForward(r.next_due_date, r.cadence).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                {' · '}
                {r.is_shared ? 'Shared' : (members.find((m) => m.id === r.owner_member_id)?.display_name ?? 'Unassigned')}
                {' · '}
                {r.autopay ? 'autopay' : <span className="ov-warn">no autopay</span>}
              </div>
            </div>
            <div className={`fig mn-row-amt ${Number(r.amount) > 0 ? 'ov-pos' : ''}`}>{formatSigned(r.amount)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
