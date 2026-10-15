import { useState } from 'react';
import { statementRows, statementsToCheck } from '../../lib/statements';
import { formatBalance } from '../../lib/money';
import { spendDelta } from '../../lib/transactionKind';
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

// A statement is checked to the cent, and a net refund is a negative figure:
// −50.49 must not read as 50 (docs/decisions.md, "A statement is compared to
// the cent"). Rokda stores these amounts in AED, so they are shown in AED
// whatever the display currency.
function aed(amount) {
  return `AED ${formatBalance(amount, { decimals: 2 })}`;
}

// What Rokda's figure is against the statement's, in words, so the direction
// of a difference is never left to a sign.
function comparison(row) {
  if (row.difference === 0) return `matches the statement's ${aed(row.statementSpend)}`;
  const more = row.difference > 0;
  return `statement ${aed(row.statementSpend)}; Rokda is ${aed(Math.abs(row.difference))} ${more ? 'higher' : 'lower'}`;
}

export default function Statements({ household, me, members = [], data, loading }) {
  const { accounts, transactions, statementReconciliations = [], reload } = data;
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  // A resolve or reopen waiting for its reason: { key, next }.
  const [pending, setPending] = useState(null);
  const [note, setNote] = useState('');

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const rows = statementRows({ accounts, reconciliations: statementReconciliations, transactions });
  const toCheck = statementsToCheck(rows);
  const memberName = (id) => members.find((m) => m.id === id)?.display_name ?? null;

  // Settles a statement ('confirmed') or opens it again ('waiting'), with who
  // did it and, when given, why. Only a write that changed the row counts:
  // one that matched nothing (changed elsewhere, or not allowed) says so.
  async function setStatus(row, next, why = '') {
    const key = `${row.account.id}:${row.statementDate}`;
    setBusy(key);
    setError(null);
    const now = new Date().toISOString();
    const payload =
      next === 'waiting'
        ? { status: 'waiting', closed_at: null, closed_by_member_id: null, updated_at: now }
        : { status: 'confirmed', closed_at: now, closed_by_member_id: me?.id ?? null, updated_at: now };
    if (why.trim()) payload.note = why.trim();
    let writeError;
    if (row.record) {
      const { data: saved, error: updateError } = await supabase.from('statement_reconciliations').update(payload).eq('id', row.record.id).select('id');
      writeError = updateError?.message ?? ((saved ?? []).length === 0 ? 'Nothing was saved: this statement may have changed elsewhere. Reload the page and try again.' : null);
    } else {
      const { error: insertError } = await supabase.from('statement_reconciliations').insert({
        household_id: household.id,
        account_id: row.account.id,
        statement_date: row.statementDate,
        period_start: row.periodStart,
        due_date: row.dueDate,
        ...payload,
      });
      writeError = insertError?.message ?? null;
    }
    setBusy(null);
    if (writeError) {
      setError(writeError);
      return;
    }
    setPending(null);
    setNote('');
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
      <div className="ov-muted" style={{ fontSize: 11, marginTop: 4 }}>
        Rokda's figure is what was spent on the card over the statement's period, refunds netted, in AED.
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
          const closed = row.status === 'confirmed' || row.status === 'reconciled';
          const closedBy = closed ? memberName(row.record?.closed_by_member_id) : null;
          const asking = pending?.key === key ? pending.next : null;
          const showing = open === key;
          return (
            <div key={key} data-testid="statement-row">
              <div className="mn-row-wrap">
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
                    {/* Under the name rather than beside the figure, so it wraps on a phone. */}
                    {row.statementSpend != null && <div className="ov-muted" style={{ fontSize: 11 }}>{comparison(row)}</div>}
                    {row.statementBalance != null && (
                      <div className="ov-muted" style={{ fontSize: 11 }}>{`Closing balance on the statement: ${aed(row.statementBalance)}`}</div>
                    )}
                    {closed && row.record?.closed_at && (
                      <div className="ov-muted" style={{ fontSize: 11 }}>
                        {`${status.label}${closedBy ? ` by ${closedBy}` : ''} on ${shortDate(row.record.closed_at.slice(0, 10))}`}
                      </div>
                    )}
                    {row.record?.note && <div className="ov-muted" style={{ fontSize: 11 }}>{row.record.note}</div>}
                  </div>
                  <div className="mn-row-amt" style={{ textAlign: 'right' }}>
                    <div className="fig">{aed(row.recordedSpend)}</div>
                    <div className="ov-muted" style={{ fontSize: 11 }}>in Rokda</div>
                  </div>
                </div>
                {!asking && (
                  <div className="st-actions">
                    {row.transactions.length > 0 && (
                      <button type="button" className="om-btn rc-markpaid" aria-expanded={showing} onClick={() => setOpen(showing ? null : key)}>
                        {showing ? 'Hide transactions' : `Show ${row.transactions.length} transaction${row.transactions.length === 1 ? '' : 's'}`}
                      </button>
                    )}
                    {(row.status === 'unchecked' || row.status === 'waiting') && (
                      <button type="button" className="om-btn rc-markpaid" disabled={busy === key} onClick={() => setStatus(row, 'confirmed')}>
                        Mark done
                      </button>
                    )}
                    {row.status === 'mismatch' && (
                      <button type="button" className="om-btn rc-markpaid" onClick={() => setPending({ key, next: 'confirmed' })}>
                        Resolve…
                      </button>
                    )}
                    {closed && (
                      <button type="button" className="om-btn rc-markpaid" onClick={() => setPending({ key, next: 'waiting' })}>
                        Reopen…
                      </button>
                    )}
                  </div>
                )}
              </div>

              {showing && (
                <ul className="ov-muted" aria-label={`Transactions on ${row.account.name}, ${shortDate(row.periodStart)} to ${shortDate(row.statementDate)}`} style={{ listStyle: 'none', padding: 0, margin: '4px 0 8px', fontSize: 12 }}>
                  {row.transactions.map((t) => (
                    <li key={t.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <span>{`${shortDate(t.occurred_at)} · ${t.merchant?.trim() || 'No merchant'}${t.kind === 'refund' ? ' (refund)' : ''}`}</span>
                      <span className="fig">{aed(spendDelta(t, Number(t.amount)))}</span>
                    </li>
                  ))}
                </ul>
              )}

              {asking && (
                <form
                  style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 8px' }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setStatus(row, asking, note);
                  }}
                >
                  <input
                    className="st-note"
                    aria-label={asking === 'waiting' ? 'Why it is being reopened' : 'What was done about the difference'}
                    placeholder={asking === 'waiting' ? 'Why reopen it? (optional)' : 'What was fixed? (optional)'}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    style={{ flex: '1 1 200px' }}
                  />
                  <button type="submit" className="om-btn" disabled={busy === key}>
                    {asking === 'waiting' ? 'Reopen' : 'Mark resolved'}
                  </button>
                  <button
                    type="button"
                    className="om-btn"
                    onClick={() => {
                      setPending(null);
                      setNote('');
                    }}
                  >
                    Cancel
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
