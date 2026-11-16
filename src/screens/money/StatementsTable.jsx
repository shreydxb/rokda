import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBalance } from '../../lib/money';
import { spendDelta } from '../../lib/transactionKind';
import { ordinal } from '../../lib/creditCard';
import { Avatar, Chip, Fold, InfoButton } from '../../design-system/kit';
import { canMarkDone, keyOf, nameOf, shortDate } from './useStatementActions';
import './MonthEnd.css';

// The card statements table (the revamp, phase 4d; design/prototype
// stmtBlock): one row per statement under its card, what is still to check
// first and what is done folded below, with Mark done, Resolve and Reopen as
// Wealth -> Statements had them, and tick boxes to mark several done at once.
// Month end shows it twice: every statement still open on the running month,
// and the statements that closed in a month on its step 2. No statement total
// is typed here (the design note's decision 2): totals come in from
// reconciling a statement, and the column shows a dash until then.

const STATUS = {
  unchecked: { label: 'To check', tone: 'warn' },
  waiting: { label: 'Waiting', tone: 'neutral' },
  mismatch: { label: 'Doesn’t match', tone: 'neg' },
  confirmed: { label: 'Done', tone: 'pos' },
  reconciled: { label: 'Reconciled', tone: 'pos' },
};
const isOpen = (row) => row.status === 'unchecked' || row.status === 'waiting' || row.status === 'mismatch';
const periodOf = (row) => `${shortDate(row.periodStart)} – ${shortDate(row.statementDate)}`;

// A statement is checked to the cent, and a net refund is a negative figure:
// −50.49 must not read as 50 (docs/decisions.md, "A statement is compared to
// the cent"). Rokda stores these amounts in AED, so they are shown in AED
// whatever the display currency.
const aed = (amount) => `AED ${formatBalance(amount, { decimals: 2 })}`;

// The difference in words, so its direction is never left to a sign.
function differenceText(row) {
  if (row.difference === 0) return <span className="me-pos">Matches</span>;
  return <span className="me-neg">{`${aed(Math.abs(row.difference))} ${row.difference > 0 ? 'higher' : 'lower'} in Rokda`}</span>;
}

// "Mark n done" for the statements ticked among `rows`, or nothing.
export function MarkTicked({ rows, actions }) {
  const chosen = rows.filter((r) => canMarkDone(r) && actions.ticked.has(keyOf(r)));
  if (!chosen.length) return null;
  return (
    <button type="button" className="ds-btn ds-btn-sm" disabled={actions.busy} onClick={() => actions.markDone(chosen)}>
      {`Mark ${chosen.length} done`}
    </button>
  );
}

export default function StatementsTable({ rows, accounts = [], members = [], actions }) {
  const [opened, setOpened] = useState(null);
  // A resolve or reopen waiting for what was done: { key, next }.
  const [asking, setAsking] = useState(null);
  const [note, setNote] = useState('');
  const open = rows.filter(isOpen);
  const done = rows.filter((r) => !isOpen(r));
  const memberTone = new Map(members.map((m, i) => [m.id, i === 0 ? 'a' : 'b']));
  const memberName = (id) => members.find((m) => m.id === id)?.display_name ?? null;

  const owner = (account) => {
    if (account.is_shared) return <Avatar name="Shared" initial="S" />;
    const m = members.find((x) => x.id === account.owner_member_id);
    return m ? <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={memberTone.get(m.id)} /> : null;
  };

  const submit = async (row) => {
    const ok = await actions.setStatus(row, asking.next, note);
    if (ok) {
      setAsking(null);
      setNote('');
    }
  };

  // One section per card, in the order the cards are listed under Accounts,
  // newest statement first.
  const grouped = (list) => {
    const cards = [];
    for (const row of list) {
      let card = cards.find((c) => c.account.id === row.account.id);
      if (!card) cards.push((card = { account: row.account, rows: [] }));
      card.rows.push(row);
    }
    cards.sort((a, b) => accounts.findIndex((x) => x.id === a.account.id) - accounts.findIndex((x) => x.id === b.account.id));
    for (const card of cards) card.rows.sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1));
    return cards;
  };

  const statementRow = (row, ticks) => {
    const key = keyOf(row);
    const status = STATUS[row.status] ?? STATUS.unchecked;
    const closed = row.status === 'confirmed' || row.status === 'reconciled';
    const showing = opened === key;
    const askingHere = asking?.key === key ? asking.next : null;
    const closedBy = closed ? memberName(row.record?.closed_by_member_id) : null;
    return (
      <Fragment key={key}>
        <tr className={showing || askingHere ? 'me-st-open' : undefined}>
          {ticks && (
            <td className="me-st-tick">
              {canMarkDone(row) && <input type="checkbox" className="me-tick" aria-label={`Select ${nameOf(row)}`} checked={actions.ticked.has(key)} onChange={() => actions.toggle(row)} />}
            </td>
          )}
          <td>
            <button type="button" className="me-st-period" aria-expanded={showing} onClick={() => setOpened(showing ? null : key)}>
              <span className="me-caret" data-on={showing || undefined} aria-hidden="true" />
              {periodOf(row)}
            </button>
          </td>
          <td className="me-ink2">{row.dueDate ? shortDate(row.dueDate) : '—'}</td>
          <td className="ds-num">{aed(row.recordedSpend)}</td>
          <td className="ds-num">{row.statementSpend == null ? <span className="me-ink3">—</span> : aed(row.statementSpend)}</td>
          <td className="ds-num">{row.difference == null ? '' : differenceText(row)}</td>
          <td>
            <Chip tone={status.tone}>{status.label}</Chip>
          </td>
          <td className="me-st-act">
            {canMarkDone(row) && (
              <button type="button" className="ds-btn ds-btn-sm" disabled={actions.busy} onClick={() => actions.setStatus(row, 'confirmed')}>
                Mark done
              </button>
            )}
            {row.status === 'mismatch' && (
              <button type="button" className="ds-btn ds-btn-sm" onClick={() => (setAsking({ key, next: 'confirmed' }), setNote(''))}>
                Resolve…
              </button>
            )}
            {closed && (
              <button type="button" className="ds-link" onClick={() => (setAsking({ key, next: 'waiting' }), setNote(''))}>
                Reopen…
              </button>
            )}
          </td>
        </tr>
        {askingHere && (
          <tr className="me-st-sub">
            <td colSpan={ticks ? 8 : 7}>
              <form
                className="me-st-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit(row);
                }}
              >
                <input
                  className="ds-select me-st-note"
                  aria-label={askingHere === 'waiting' ? 'Why it is being reopened' : 'What was done about the difference'}
                  placeholder={askingHere === 'waiting' ? 'Why reopen it? (optional)' : 'What was fixed? (optional)'}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <button type="submit" className="ds-btn ds-btn-sm ds-btn-primary" disabled={actions.busy}>
                  {askingHere === 'waiting' ? 'Reopen' : 'Mark resolved'}
                </button>
                <button type="button" className="ds-btn ds-btn-sm" onClick={() => (setAsking(null), setNote(''))}>
                  Cancel
                </button>
              </form>
            </td>
          </tr>
        )}
        {showing && (
          <tr className="me-st-sub">
            <td colSpan={ticks ? 8 : 7}>
              <div className="me-st-detail" role="region" aria-label={nameOf(row)}>
                {row.transactions.length === 0 ? (
                  <div className="me-ink3">No transactions on the card in this period.</div>
                ) : (
                  <ul className="me-st-lines">
                    {row.transactions.map((t) => (
                      <li key={t.id}>
                        <span>{`${shortDate(t.occurred_at)} · ${t.merchant?.trim() || 'No merchant'}${t.kind === 'refund' ? ' (refund)' : ''}`}</span>
                        <span className="ds-num">{aed(spendDelta(t, Number(t.amount)))}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {row.statementBalance != null && <div className="me-ink2">{`Closing balance on the statement: ${aed(row.statementBalance)}`}</div>}
                {closed && row.record?.closed_at && <div className="me-ink2">{`${status.label}${closedBy ? ` by ${closedBy}` : ''} on ${shortDate(row.record.closed_at)}`}</div>}
                {row.record?.note && <div className="me-ink2">{row.record.note}</div>}
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  const table = (list, { ticks, label }) => (
    <div className="ds-table-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className="ds-table me-st-table">
        <thead>
          <tr>
            {ticks && <th scope="col" className="me-st-tick" aria-label="Select" />}
            <th scope="col">Period</th>
            <th scope="col" className="me-st-due">
              Due
            </th>
            <th scope="col" className="ds-num me-st-amt">
              In Rokda <InfoButton about="In Rokda">What was spent on the card over the period, refunds netted, in AED.</InfoButton>
            </th>
            <th scope="col" className="ds-num me-st-amt">
              Statement
            </th>
            <th scope="col" className="ds-num me-st-diff">
              Difference
            </th>
            <th scope="col" className="me-st-status">
              Status
            </th>
            <th scope="col" className="me-st-act" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {grouped(list).flatMap((card) => [
            <tr key={card.account.id} className="me-st-group">
              <td colSpan={ticks ? 8 : 7}>
                <span className="me-st-card">
                  {owner(card.account)}
                  <Link className="me-st-cardname" to="/wealth?tab=accounts&who=both">{`${card.account.name} →`}</Link>
                  <span className="me-ink3">{`· closes ${ordinal(card.account.statement_day)}${card.account.due_day ? ` · due ${ordinal(card.account.due_day)}` : ''}`}</span>
                </span>
              </td>
            </tr>,
            ...card.rows.map((row) => statementRow(row, ticks)),
          ])}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="me-st">
      {actions.error && (
        <div className="me-error" role="alert">
          {actions.error}
        </div>
      )}
      {open.length > 0 ? (
        table(open, { ticks: true, label: 'Statements to check' })
      ) : (
        <div className="me-ok">
          <span className="me-ok-mark" aria-hidden="true" />
          Every statement here has been checked.
        </div>
      )}
      {done.length > 0 && (
        <Fold label="Done" count={done.length}>
          {table(done, { ticks: false, label: 'Statements done' })}
        </Fold>
      )}
    </div>
  );
}
