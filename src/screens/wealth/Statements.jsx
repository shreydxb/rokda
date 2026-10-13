import { useState } from 'react';
import { statementRows, statementsToCheck } from '../../lib/statements';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { supabase } from '../../lib/supabaseClient';

// Wealth -> Statements: every card's recent statements and whether each was
// reconciled against Rokda (docs/decisions.md, "A statement is reconciled,
// and Rokda records it"). The Telegram bot asks about a statement from the
// day after it closes; "Mark done" here answers it the same way.
const STATUS = {
  unchecked: { label: 'Not checked', warn: true },
  waiting: { label: 'Waiting', warn: true },
  mismatch: { label: "Doesn't match", warn: true },
  confirmed: { label: 'Done', warn: false },
  reconciled: { label: 'Reconciled', warn: false },
};

function shortDate(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function Statements({ household, me, data, loading }) {
  const money = useMoneyDisplay(household);
  const { accounts, transactions, statementReconciliations = [], reload } = data;
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const rows = statementRows({ accounts, reconciliations: statementReconciliations, transactions });
  const toCheck = statementsToCheck(rows);

  async function markDone(row) {
    setBusy(`${row.account.id}:${row.statementDate}`);
    setError(null);
    const now = new Date().toISOString();
    const done = { status: 'confirmed', closed_at: now, closed_by_member_id: me?.id ?? null, updated_at: now };
    const { error: writeError } = row.record
      ? await supabase.from('statement_reconciliations').update(done).eq('id', row.record.id)
      : await supabase.from('statement_reconciliations').insert({
          household_id: household.id,
          account_id: row.account.id,
          statement_date: row.statementDate,
          period_start: row.periodStart,
          due_date: row.dueDate,
          ...done,
        });
    setBusy(null);
    if (writeError) {
      setError(writeError.message);
      return;
    }
    await reload();
  }

  if (rows.length === 0) {
    return (
      <div className="ov-empty">
        <div className="ov-empty-kicker">No statements yet</div>
        <div className="ov-empty-body">Give a card its statement day under Accounts, and its statements will be listed here.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="ov-muted" style={{ marginTop: 18 }}>
        {toCheck === 0
          ? 'Every recent statement has been checked.'
          : `${toCheck} statement${toCheck === 1 ? '' : 's'} still to check against Rokda. The bot asks about each one on Telegram until it's done.`}
      </div>
      {error && (
        <div className="ov-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <div className="mn-list" style={{ marginTop: 12 }}>
        {rows.map((row) => {
          const key = `${row.account.id}:${row.statementDate}`;
          const status = STATUS[row.status] ?? STATUS.unchecked;
          const open = row.status === 'unchecked' || row.status === 'waiting';
          return (
            <div className="mn-row-wrap" key={key} data-testid="statement-row">
              <div className="mn-row">
                <div className="mn-row-main">
                  <div>
                    {row.account.name}
                    <span className={`wl-card-chip${status.warn ? ' wl-card-chip-warn' : ''}`} style={{ marginLeft: 8 }}>
                      {status.label}
                    </span>
                  </div>
                  <div className="ov-muted">
                    {`Closed ${shortDate(row.statementDate)} · ${shortDate(row.periodStart)} to ${shortDate(row.statementDate)}`}
                    {row.dueDate && ` · due ${shortDate(row.dueDate)}`}
                  </div>
                  {row.record?.note && <div className="ov-muted" style={{ fontSize: 11 }}>{row.record.note}</div>}
                </div>
                <div className="mn-row-amt" style={{ textAlign: 'right' }}>
                  <div className="fig">{money.fmt(row.recordedSpend)}</div>
                  <div className="ov-muted" style={{ fontSize: 11 }}>
                    {row.statementSpend == null
                      ? 'in Rokda'
                      : row.difference === 0
                        ? 'matches the statement'
                        : `statement ${money.fmt(row.statementSpend)}`}
                  </div>
                </div>
              </div>
              {open && (
                <button type="button" className="om-btn rc-markpaid" disabled={busy === key} onClick={() => markDone(row)}>
                  Mark done
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
