import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { statementRows, statementRowsForMonth, statementsToCheck } from '../../lib/statements';
import { monthFromParam } from '../../lib/useMonthParam';
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

// The statement's own figure against Rokda's, as a third figure: what the
// difference is and which way it goes, in words, so its direction is never
// left to a sign.
function differenceText(row) {
  if (row.difference === 0) return 'Matches';
  return `${aed(Math.abs(row.difference))} ${row.difference > 0 ? 'higher' : 'lower'} in Rokda`;
}

const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const NEEDS_CHECK = new Set(['unchecked', 'waiting', 'mismatch']);

export default function Statements({ household, me, members = [], data, loading }) {
  const { accounts, transactions, statementReconciliations = [], reload } = data;
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  // A resolve or reopen waiting for its reason: { key, next }.
  const [pending, setPending] = useState(null);
  const [note, setNote] = useState('');

  // A link for one month (the monthly review's) lists the statements that
  // closed in it, however long ago; otherwise the recent ones.
  const [params] = useSearchParams();
  const forMonth = monthFromParam(params.get('month'));

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const rows = forMonth
    ? statementRowsForMonth({ accounts, reconciliations: statementReconciliations, transactions, year: forMonth.getFullYear(), month: forMonth.getMonth() + 1 })
    : statementRows({ accounts, reconciliations: statementReconciliations, transactions });
  const monthLabel = forMonth ? forMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : null;
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

  const recentLink = forMonth && (
    <Link className="ov-link" to="/wealth?tab=statements" style={{ fontSize: 12 }}>
      Show recent statements
    </Link>
  );

  if (rows.length === 0 && forMonth) {
    return (
      <div className="ov-empty">
        <div className="ov-empty-kicker">No statements closed in {monthLabel}</div>
        <div className="ov-empty-body">{recentLink}</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="ov-empty">
        <div className="ov-empty-kicker">No statements yet</div>
        <div className="ov-empty-body">Give a card its statement day under Accounts, and its statements will be listed here.</div>
      </div>
    );
  }

  // One section per card, in the order the cards are listed under Accounts.
  // Within it, what is still to check comes first; what is settled folds away
  // below, so a card with nothing to do takes one line.
  const cards = [];
  for (const row of rows) {
    let card = cards.find((c) => c.account.id === row.account.id);
    if (!card) {
      card = { account: row.account, open: [], settled: [] };
      cards.push(card);
    }
    (NEEDS_CHECK.has(row.status) ? card.open : card.settled).push(row);
  }
  cards.sort((a, b) => accounts.indexOf(a.account) - accounts.indexOf(b.account));
  for (const card of cards) {
    card.open.sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1));
    card.settled.sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1));
  }

  const item = (row) => (
    <StatementItem
      key={`${row.account.id}:${row.statementDate}`}
      row={row}
      memberName={memberName}
      busy={busy}
      open={open}
      setOpen={setOpen}
      pending={pending}
      setPending={setPending}
      note={note}
      setNote={setNote}
      setStatus={setStatus}
    />
  );

  return (
    <div className="st">
      {forMonth && (
        <div className="st-month">
          <span className="ov-kicker">Statements that closed in {monthLabel}</span>
          {recentLink}
        </div>
      )}
      <div className="st-summary">
        <div className="st-summary-head" data-done={toCheck === 0}>
          {toCheck === 0
            ? forMonth
              ? 'Every statement that closed this month has been checked.'
              : 'Every recent statement has been checked.'
            : `${toCheck} statement${toCheck === 1 ? '' : 's'} still to check against Rokda.`}
        </div>
        <div className="ov-muted">
          {toCheck > 0 && "The bot asks about each one on Telegram until it's done. "}
          Rokda&rsquo;s figure is what was spent on the card over the statement&rsquo;s period, refunds netted, in AED.
        </div>
      </div>
      {error && (
        <div className="ov-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {cards.map((card) => (
        <section key={card.account.id} className="st-card" aria-label={card.account.name}>
          <header className="st-card-head">
            <h3 className="st-card-name">{card.account.name}</h3>
            <span className="ov-muted">
              {`Closes on the ${ordinal(card.account.statement_day)}${card.account.due_day ? `, due on the ${ordinal(card.account.due_day)}` : ''}`}
            </span>
          </header>
          {card.open.length > 0 ? (
            <div className="st-items">{card.open.map(item)}</div>
          ) : (
            <div className="ov-muted st-allclear">Nothing to check.</div>
          )}
          {card.settled.length > 0 && (
            <details className="st-settled" open={card.open.length === 0 && Boolean(forMonth)}>
              <summary>{`Checked (${card.settled.length})`}</summary>
              <div className="st-items">{card.settled.map(item)}</div>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}

// One statement: its period and status, the three figures that decide it, and
// its actions, always in the same places so the eye and the thumb know where
// to go.
function StatementItem({ row, memberName, busy, open, setOpen, pending, setPending, note, setNote, setStatus }) {
  const key = `${row.account.id}:${row.statementDate}`;
  const status = STATUS[row.status] ?? STATUS.unchecked;
  const closed = row.status === 'confirmed' || row.status === 'reconciled';
  const closedBy = closed ? memberName(row.record?.closed_by_member_id) : null;
  const asking = pending?.key === key ? pending.next : null;
  const showing = open === key;
  const count = row.transactions.length;

  return (
    <article className="st-item" data-testid="statement-row" data-status={row.status}>
      <div className="st-item-head">
        <span className="st-period">{`${shortDate(row.periodStart)} – ${shortDate(row.statementDate)}`}</span>
        <span className={`wl-card-chip${status.warn ? ' wl-card-chip-warn' : ''}`}>{status.label}</span>
      </div>
      <div className="ov-muted st-meta">
        {`Closed ${shortDate(row.statementDate)}`}
        {row.dueDate && ` · due ${shortDate(row.dueDate)}`}
      </div>

      <dl className="st-figures">
        <div>
          <dt>In Rokda</dt>
          <dd className="fig">{aed(row.recordedSpend)}</dd>
        </div>
        <div>
          <dt>Statement</dt>
          <dd className={row.statementSpend == null ? 'ov-muted' : 'fig'}>{row.statementSpend == null ? 'Not entered' : aed(row.statementSpend)}</dd>
        </div>
        {row.difference != null && (
          <div>
            <dt>Difference</dt>
            <dd className="fig" data-tone={row.difference === 0 ? 'pos' : 'warn'}>
              {differenceText(row)}
            </dd>
          </div>
        )}
      </dl>

      {(row.statementBalance != null || (closed && row.record?.closed_at) || row.record?.note) && (
        <div className="ov-muted st-notes">
          {row.statementBalance != null && <div>{`Closing balance on the statement: ${aed(row.statementBalance)}`}</div>}
          {closed && row.record?.closed_at && <div>{`${status.label}${closedBy ? ` by ${closedBy}` : ''} on ${shortDate(row.record.closed_at.slice(0, 10))}`}</div>}
          {row.record?.note && <div>{row.record.note}</div>}
        </div>
      )}

      {asking ? (
        <form
          className="st-form"
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
          />
          <button type="submit" className="om-btn st-primary" disabled={busy === key}>
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
      ) : (
        <div className="st-actions">
          {(row.status === 'unchecked' || row.status === 'waiting') && (
            <button type="button" className="om-btn st-primary" disabled={busy === key} onClick={() => setStatus(row, 'confirmed')}>
              Mark done
            </button>
          )}
          {row.status === 'mismatch' && (
            <button type="button" className="om-btn st-primary" onClick={() => setPending({ key, next: 'confirmed' })}>
              Resolve…
            </button>
          )}
          {count > 0 && (
            <button type="button" className="om-btn" aria-expanded={showing} onClick={() => setOpen(showing ? null : key)}>
              {showing ? 'Hide transactions' : `Show ${count} transaction${count === 1 ? '' : 's'}`}
            </button>
          )}
          {closed && (
            <button type="button" className="om-btn st-quiet" onClick={() => setPending({ key, next: 'waiting' })}>
              Reopen…
            </button>
          )}
        </div>
      )}

      {showing && (
        <ul className="st-lines" aria-label={`Transactions on ${row.account.name}, ${shortDate(row.periodStart)} to ${shortDate(row.statementDate)}`}>
          {row.transactions.map((t) => (
            <li key={t.id}>
              <span>{`${shortDate(t.occurred_at)} · ${t.merchant?.trim() || 'No merchant'}${t.kind === 'refund' ? ' (refund)' : ''}`}</span>
              <span className="fig">{aed(spendDelta(t, Number(t.amount)))}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
