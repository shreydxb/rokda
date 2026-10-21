import { useMemo, useState } from 'react';
import { formatMoney, formatSigned } from '../../lib/money';
import { billStatus, hasEnded, nativeAmountLabel, rollForward } from '../../lib/recurring';
import RecurringEditor from './RecurringEditor';
import TransactionEditor from './TransactionEditor';
import { householdToday } from '../../lib/day';

const UNIT_LABEL = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };

const shortDay = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

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
  // Totals are of what is still to pay: a finished schedule is not a commitment.
  const live = bills.filter((r) => !hasEnded(r, now));
  const fixedTotal = live.filter((r) => r.is_fixed).reduce((s, r) => s + -Number(r.amount), 0);
  const variableTotal = live.filter((r) => !r.is_fixed).reduce((s, r) => s + -Number(r.amount), 0);
  const committedShare = fixedTotal + variableTotal > 0 ? fixedTotal / (fixedTotal + variableTotal) : null;

  return (
    <div className="rc">
      <div className="rc-toolbar">
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
          household={household}
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
          fxHistory={data.fxRateHistory}
          initial={{
            type: Number(paying.amount) >= 0 ? 'income' : 'expense',
            // A bill set in rupees is paid in rupees: the editor estimates
            // the AED until the AED debited is entered.
            ...(paying.currency && paying.currency !== 'AED' && paying.native_amount != null
              ? { entry_currency: paying.currency, amount: String(Math.abs(Number(paying.native_amount))) }
              : { amount: String(Math.abs(Number(paying.amount))) }),
            merchant: paying.name,
            occurred_at: householdToday(),
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

// A schedule that needs something done comes first (late, then due soon),
// then the rest by their next date; finished schedules fold away.
function orderRows(rows, transactions, now) {
  const RANK = { neg: 0, warn: 1 };
  return rows
    .map((r) => ({ r, status: billStatus(r, transactions, now), ended: hasEnded(r, now) }))
    .sort((a, b) => (RANK[a.status.tone] ?? 2) - (RANK[b.status.tone] ?? 2) || rollForward(a.r.next_due_date, a.r.cadence, now, a.r.interval_count) - rollForward(b.r.next_due_date, b.r.cadence, now, b.r.interval_count));
}

function RecurringGroup({ title, rows, members, transactions, now, onEdit, onMarkPaid }) {
  if (rows.length === 0) return null;
  const ordered = orderRows(rows, transactions, now);
  const current = ordered.filter((x) => !x.ended);
  const ended = ordered.filter((x) => x.ended);
  const toDo = current.filter((x) => x.status.needsAction).length;
  const row = ({ r, status, ended: isEnded }) => (
    <RecurringRow key={r.id} r={r} status={status} ended={isEnded} members={members} now={now} onEdit={onEdit} onMarkPaid={onMarkPaid} />
  );
  return (
    <section className="rc-group" aria-label={title}>
      <header className="rc-group-head">
        <span className="ov-kicker">{title}</span>
        <span className="ov-muted">{toDo > 0 ? `${toDo} to mark paid` : `${current.length}`}</span>
      </header>
      {/* The action column is kept for every row once one row has an action,
          so the amounts stay in one line down the list. */}
      <div className="rc-list" data-actions={toDo > 0}>
        {current.map(row)}
      </div>
      {ended.length > 0 && (
        <details className="rc-ended">
          <summary>{`Ended (${ended.length})`}</summary>
          <div className="rc-list">{ended.map(row)}</div>
        </details>
      )}
    </section>
  );
}

// One schedule: its name and amount on the first line, its status and terms
// on the second, and "Mark paid" in its own column when there is something
// to mark.
function RecurringRow({ r, status, ended, members, now, onEdit, onMarkPaid }) {
  const native = nativeAmountLabel(r);
  const endLabel = r.ends_on ? new Date(`${r.ends_on}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  return (
    <div className="rc-row" data-testid="recurring-row">
      <button type="button" className="rc-open" onClick={() => onEdit(r)}>
        <span className="rc-name">
          {r.name} {r.active === false && <span className="ov-muted">· paused</span>}
        </span>
        <span className={`fig rc-amt ${Number(r.amount) > 0 ? 'ov-pos' : ''}`}>
          {formatSigned(r.amount)}
          {native && <span className="ov-muted rc-native">{native}</span>}
        </span>
        <span className="ov-muted rc-meta">
          <span className={`ov-chip-${status.tone === 'pos' ? 'ok' : status.tone}`}>{status.label}</span>{' '}
          {cadenceLabel(r)} ·{' '}
          {/* A late bill says when it was due, not only when the next one is. */}
          {ended
            ? `ended ${endLabel}`
            : `${status.tone === 'neg' && status.due ? `was due ${shortDay(status.due)}, ` : ''}next ${shortDay(rollForward(r.next_due_date, r.cadence, now, r.interval_count))}${endLabel ? `, last ${endLabel}` : ''}`}
          {' · '}
          {r.is_shared ? 'Shared' : (members.find((m) => m.id === r.owner_member_id)?.display_name ?? 'Unassigned')}
          {' · '}
          {r.autopay ? 'autopay' : <span className="ov-warn">no autopay</span>}
        </span>
      </button>
      <div className="rc-action">
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
    </div>
  );
}
