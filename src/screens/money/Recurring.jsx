import { useMemo, useState } from 'react';
import { formatMoney, formatSigned } from '../../lib/money';
import { billStatus, rollForward } from '../../lib/recurring';
import RecurringEditor from './RecurringEditor';
import TransactionEditor from './TransactionEditor';

const UNIT_LABEL = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };

function cadenceLabel(r) {
  const every = Number(r.interval_count) || 1;
  if (every <= 1) return r.cadence;
  return `every ${every} ${UNIT_LABEL[r.cadence] ?? r.cadence}s`;
}

export default function Recurring({ household, members, data, loading }) {
  const { recurring, accounts, categories, transactions, reload } = data;
  const [editing, setEditing] = useState(null);
  const [paying, setPaying] = useState(null); // a recurring row being marked paid
  const now = useMemo(() => new Date(), []);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const bills = recurring.filter((r) => Number(r.amount) < 0);
  const income = recurring.filter((r) => Number(r.amount) >= 0);
  const fixedTotal = bills.filter((r) => r.is_fixed).reduce((s, r) => s + -Number(r.amount), 0);
  const variableTotal = bills.filter((r) => !r.is_fixed).reduce((s, r) => s + -Number(r.amount), 0);
  const committedShare = fixedTotal + variableTotal > 0 ? fixedTotal / (fixedTotal + variableTotal) : null;

  return (
    <div>
      <div className="mn-filters">
        <div className="ov-muted">
          Fixed {formatMoney(fixedTotal)} · Variable ~{formatMoney(variableTotal)}
          {committedShare !== null && ` · ${Math.round(committedShare * 100)}% of spend is committed before the month starts`}
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
          <RecurringGroup
            title="Bills"
            rows={bills}
            members={members}
            transactions={transactions}
            now={now}
            onEdit={setEditing}
            onMarkPaid={setPaying}
          />
          <RecurringGroup
            title="Expected income"
            rows={income}
            members={members}
            transactions={transactions}
            now={now}
            onEdit={setEditing}
            onMarkPaid={setPaying}
          />
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

      {paying && (
        <TransactionEditor
          household={household}
          householdId={household?.id}
          accounts={accounts}
          categories={categories}
          members={members}
          allTransactions={transactions}
          initial={{
            type: Number(paying.amount) >= 0 ? 'income' : 'expense',
            amount: String(Math.abs(Number(paying.amount))),
            merchant: paying.name,
            occurred_at: new Date().toISOString().slice(0, 10),
            category_id: paying.category_id ?? '',
            owner: paying.is_shared ? 'shared' : (paying.owner_member_id ?? ''),
          }}
          onClose={() => setPaying(null)}
          onSaved={async () => {
            setPaying(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function RecurringGroup({ title, rows, members, transactions, now, onEdit, onMarkPaid }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginTop: 28 }}>
      <div className="ov-kicker" style={{ marginBottom: 8 }}>
        {title}
      </div>
      <div className="mn-list">
        {rows.map((r) => {
          const status = billStatus(r, transactions, now);
          return (
            <div key={r.id} className="mn-row-wrap">
              <button type="button" className="mn-row" onClick={() => onEdit(r)}>
                <div className="mn-row-main">
                  <div>
                    {r.name} {r.active === false && <span className="ov-muted">· paused</span>}
                  </div>
                  <div className="ov-muted">
                    {cadenceLabel(r)} · next {rollForward(r.next_due_date, r.cadence, now, r.interval_count).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    {' · '}
                    {r.is_shared ? 'Shared' : (members.find((m) => m.id === r.owner_member_id)?.display_name ?? 'Unassigned')}
                    {' · '}
                    {r.autopay ? 'autopay' : <span className="ov-warn">no autopay</span>}
                  </div>
                  <div className="rc-statusrow">
                    <span className={`ov-chip-${status.tone === 'pos' ? 'ok' : status.tone}`}>{status.label}</span>
                  </div>
                </div>
                <div className={`fig mn-row-amt ${Number(r.amount) > 0 ? 'ov-pos' : ''}`}>{formatSigned(r.amount)}</div>
              </button>
              {status.needsAction && (
                <button
                  type="button"
                  className="om-btn rc-markpaid"
                  onClick={() => onMarkPaid(r)}
                  title="Records a real transaction dated today; this schedule itself is unchanged"
                >
                  Mark paid
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
