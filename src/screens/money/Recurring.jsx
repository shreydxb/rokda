import { useState } from 'react';
import { useNow } from '../../lib/useNow';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatSigned } from '../../lib/money';
import { billStatus, hasEnded, nativeAmountLabel, rollForward } from '../../lib/recurring';
import { everyLabel, recurringStrip, statusWords } from '../../lib/recurringTotals';
import { scopedValue } from '../../lib/scope';
import { billPaymentInitial } from '../../lib/transactionForm';
import { householdToday } from '../../lib/day';
import { isoDay } from '../../lib/activityLink';
import { Avatar, Card, Chip, EmptyState, Fold, InfoButton, KpiStrip } from '../../design-system/kit';
import RecurringEditor from './RecurringEditor';
import TransactionEditor from './TransactionEditor';
import { Tools } from '../PageTools';
import './Recurring.css';

// Money -> Recurring, built like the prototype (the revamp, phase 4;
// design/prototype/js/screens-money.js): a strip of what the schedules come
// to a month, then the bills and the expected income as tables, what needs
// marking first, and the ended ones folded away. + Bill sits in the header.

const shortDay = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace('Sept', 'Sep');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DAY = 86400000;

function relative(day, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const n = Math.round((day - today) / DAY);
  if (n === 0) return 'today';
  return n > 0 ? `in ${plural(n, 'day')}` : `${plural(-n, 'day')} ago`;
}

export default function Recurring({ household, members, me, data, loading }) {
  const { recurring, accounts, categories, transactions, reload } = data;
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const [editing, setEditing] = useState(null);
  // A bill being marked paid, and the day its payment is dated.
  const [paying, setPaying] = useState(null);
  const now = useNow(data?.loadedAt);

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  // One person's view shows their own schedules and the shared ones, as
  // Overview's Next 30 days does.
  const visible = recurring.filter((r) => scopeMemberId === null || r.is_shared || r.owner_member_id === scopeMemberId);
  const ordered = orderRows(visible, transactions, now);
  const current = ordered.filter((x) => !x.ended);
  const bills = current.filter((x) => Number(x.r.amount) < 0);
  const income = current.filter((x) => Number(x.r.amount) >= 0);
  const ended = ordered.filter((x) => x.ended);
  const strip = recurringStrip(visible, transactions, scopeMemberId, now);
  const markChip =
    strip.late > 0 ? <Chip tone="neg">{`${strip.late} late`}</Chip> : strip.unconfirmed > 0 ? <Chip tone="warn">Not confirmed</Chip> : strip.toMarkPaid > 0 ? <Chip tone="warn">Due soon</Chip> : <Chip tone="pos">All clear</Chip>;

  const tools = (
    <Tools>
      <button type="button" className="ds-btn ds-btn-primary" onClick={() => setEditing('new')}>
        + Bill
      </button>
    </Tools>
  );
  const table = (rows, sixth) => (
    <RecurringTable
      rows={rows}
      sixth={sixth}
      members={members}
      accounts={accounts}
      scopeMemberId={scopeMemberId}
      now={now}
      onEdit={setEditing}
      // A payment settles a bill only near its date, so a late one is paid on
      // the day it was due, as Overview's To do does; one not yet due today
      // (the fresh review of 4a).
      onMarkPaid={(bill, status) => {
        const today = householdToday();
        const due = status.due ? isoDay(status.due) : today;
        setPaying({ bill, on: due < today ? due : today });
      }}
    />
  );

  return (
    <div className="rc">
      {tools}
      {recurring.length === 0 ? (
        <Card>
          <EmptyState title="No bills yet" body="Add rent, utilities and subscriptions, and they show on Overview's Next 30 days." action={{ label: '+ Bill', onClick: () => setEditing('new') }} />
        </Card>
      ) : (
        <>
          <Card flush className="rc-strip">
            <KpiStrip
              items={[
                {
                  label: 'Fixed a month',
                  value: formatMoney(strip.fixed),
                  sub: plural(strip.fixedCount, 'bill'),
                  info: <InfoButton about="the monthly figures">A bill that comes round less often than monthly counts its share of a month: a yearly one a twelfth. Ended and paused schedules are left out.</InfoButton>,
                },
                { label: 'Variable, about', value: formatMoney(strip.variable), sub: plural(strip.variableCount, 'bill') },
                { label: 'Expected income a month', value: formatMoney(strip.income) },
                { label: 'To mark paid', value: String(strip.toMarkPaid), sub: markChip },
              ]}
            />
          </Card>
          <Card title="Bills" right={<span className="ds-muted">{bills.length}</span>} flush>
            {bills.length ? table(bills, 'Paid by') : <EmptyState title="No bills yet" body="Add rent, utilities and subscriptions." />}
          </Card>
          <Card title="Expected income" right={<span className="ds-muted">{income.length}</span>} flush>
            {income.length ? table(income, 'Paid into') : <div className="rc-none">None set up.</div>}
          </Card>
          {ended.length > 0 && (
            <Card flush className="rc-ended">
              <Fold label="Ended" count={ended.length}>
                {table(ended, 'Paid by')}
              </Fold>
            </Card>
          )}
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
          // Filled from the bill, as Overview's To do does (lib/transactionForm.js).
          initial={billPaymentInitial(paying.bill, accounts, paying.on)}
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

// A schedule that needs something done comes first (late, then due soon or
// unconfirmed), then the rest by their next date. One past its last date is
// ended only once nothing is left to mark (the fresh review of 4a); a paused
// one needs nothing.
function orderRows(rows, transactions, now) {
  const RANK = { neg: 0, warn: 1 };
  return rows
    .map((r) => {
      const status = billStatus(r, transactions, now);
      const needsAction = status.needsAction && r.active !== false;
      return { r, status: { ...status, needsAction }, words: statusWords(r, status), ended: hasEnded(r, now) && !needsAction };
    })
    .sort((a, b) => (RANK[a.words.tone] ?? 2) - (RANK[b.words.tone] ?? 2) || rollForward(a.r.next_due_date, a.r.cadence, now, a.r.interval_count) - rollForward(b.r.next_due_date, b.r.cadence, now, b.r.interval_count));
}

// The prototype's table: status, name, how often, when next (or when it was
// due, for one not yet marked), whose, how it is paid or where income lands,
// the amount, and Mark paid where there is something to mark.
function RecurringTable({ rows, sixth, members, accounts, scopeMemberId, now, onEdit, onMarkPaid }) {
  const tone = new Map(members.map((m, i) => [m.id, i === 0 ? 'a' : 'b']));
  const owner = (r) => {
    if (r.is_shared) return { name: 'Shared', avatar: <Avatar name="Shared" initial="S" /> };
    const m = members.find((x) => x.id === r.owner_member_id);
    return m ? { name: m.display_name, avatar: <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={tone.get(m.id)} /> } : { name: 'Unassigned', avatar: null };
  };
  return (
    <div className="ds-table-wrap" tabIndex={0} role="region" aria-label={`${sixth === 'Paid into' ? 'Income' : 'Bills'} table`}>
      <table className="ds-table rc-table">
        <thead>
          <tr>
            <th scope="col" className="rc-col-status">
              Status
            </th>
            <th scope="col">Name</th>
            <th scope="col" className="rc-col-every">
              Every
            </th>
            <th scope="col" className="rc-col-due">
              Next due
            </th>
            <th scope="col" className="rc-col-owner">
              Owner
            </th>
            <th scope="col" className="rc-col-paid">
              {sixth}
            </th>
            <th scope="col" className="ds-num">
              Amount
            </th>
            <th scope="col" className="rc-col-act" aria-label="Action" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, status, words: stated, ended }) => {
            const words = ended ? { label: 'Ended', tone: 'neutral' } : stated;
            const incomeRow = Number(r.amount) > 0;
            // A bill not yet marked shows the date it was due; the rest their
            // next date.
            const date = ended ? null : status.needsAction || status.label === 'Expected' ? status.due : rollForward(r.next_due_date, r.cadence, now, r.interval_count);
            const full = Number(r.amount);
            const shown = scopedValue(full, r, scopeMemberId);
            const native = nativeAmountLabel(r);
            const who = owner(r);
            return (
              <tr key={r.id} className="rc-row" data-testid="recurring-row" onClick={() => onEdit(r)}>
                <td>
                  <Chip tone={words.tone}>{words.label}</Chip>
                </td>
                <td>
                  <button
                    type="button"
                    className="rc-name"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(r);
                    }}
                  >
                    {r.name}
                  </button>
                  {r.active === false && <span className="ds-muted"> · paused</span>}
                </td>
                <td className="rc-every rc-col-every">{everyLabel(r)}</td>
                <td className="rc-due">
                  {date ? (
                    <>
                      <div>{shortDay(date)}</div>
                      <div className="rc-sub">{relative(date, now)}</div>
                    </>
                  ) : (
                    <span className="ds-muted">{r.ends_on ? `last ${shortDay(new Date(`${r.ends_on}T00:00:00`))}` : '—'}</span>
                  )}
                </td>
                <td className="rc-col-owner">
                  <span className="rc-owner">
                    {who.avatar}
                    <span className="rc-ink2">{who.name}</span>
                  </span>
                </td>
                <td className="ds-muted rc-col-paid">{incomeRow ? (accounts.find((a) => a.id === r.account_id)?.name ?? '—') : r.autopay ? 'Autopay' : 'Manual'}</td>
                <td className={`ds-num rc-amount${incomeRow ? ' ds-pos' : ''}`}>
                  {!r.is_fixed && !incomeRow && <span className="rc-about">about </span>}
                  {formatSigned(shown)}
                  {native && <div className="rc-sub">{native}</div>}
                  {scopeMemberId !== null && shown !== full && <div className="rc-sub">half of {formatSigned(full)}</div>}
                </td>
                <td className="rc-col-act">
                  {!ended && status.needsAction && (
                    <button
                      type="button"
                      className="ds-btn ds-btn-sm"
                      title="Records a real transaction, dated the day it was due; this schedule itself is unchanged"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMarkPaid(r, status);
                      }}
                    >
                      Mark paid
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
