import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useScope } from '../../lib/ScopeContext';
import { useNow } from '../../lib/useNow';
import { accountValueAed } from '../../lib/accounts';
import { isBalanceConfirmed } from '../../lib/balance';
import { activityHref, tabHref } from '../../lib/activityLink';
import { ordinal } from '../../lib/creditCard';
import { statementRows, statementsToCheck } from '../../lib/statements';
import { cardCycle, liabilityRows, paymentDue } from '../../lib/netWorthLedger';
import { LimitUsed } from './NetWorth';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { formatBalance } from '../../lib/money';
import { Chip, Drawer, InfoButton, KpiStrip } from '../../design-system/kit';
import { STATEMENT_STATUS, shortDate } from '../money/useStatementActions';
import AccountEditor from './AccountEditor';
import './AccountDrawer.css';

// An account opened through the address, `?account={id}` (the revamp, phase
// 5a; design/prototype openAccount, cycleBody, cardStatements), from Net
// worth's ledger or from a link on another page (Month end, Overview's To
// do). `?account=new` adds one. A credit card opens on its running cycle,
// with its statements and its details a tab away (`&view=statements` or
// `details`): the card stays the thing followed through to its statement
// (review H10). Every other account opens on its details.

const CARD_TABS = [
  { id: 'cycle', label: 'This cycle' },
  { id: 'statements', label: 'Statements' },
  { id: 'details', label: 'Details' },
];

export default function AccountDrawer({ household, members = [], data }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const now = useNow(data?.loadedAt);
  const money = useMoneyDisplay(household);
  const { scope } = useScope();
  // The tab a switch just chose, so the drawer drawn afresh for it keeps the
  // keyboard there (the fresh review of 5a).
  const [switchedTo, setSwitchedTo] = useState(null);
  const id = params.get('account');
  if (!id) return null;
  const { accounts = [], transactions = [], statementReconciliations = [], categories = [], reload } = data;

  // Closing leaves the page as it was under the drawer. Opened from the page
  // (`state.drawer`), it was a step forward, so closing goes back, and Back
  // then leaves the page rather than landing on it again; opened from a link
  // or a reload, the address is replaced (the fresh review of 5a).
  const close = () => {
    if (location.state?.drawer) {
      navigate(-1);
      return;
    }
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('account');
        next.delete('view');
        return next;
      },
      { replace: true },
    );
  };
  const saved = async () => {
    await reload();
    close();
  };
  const editor = (account, extra = {}) => (
    <AccountEditor account={account} householdId={household?.id} accounts={accounts} members={members} transactions={transactions} onClose={close} onSaved={saved} {...extra} />
  );

  if (id === 'new') return editor(null);
  const account = accounts.find((a) => a.id === id);
  if (!account) return null;
  if (account.type !== 'credit_card') return editor(account);

  const view = params.get('view');
  const tab = view === 'statements' || view === 'details' ? view : 'cycle';
  const setTab = (next) => {
    setSwitchedTo(`${id}:${next}`);
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'cycle') p.delete('view');
        else p.set('view', next);
        return p;
      },
      { replace: true, state: location.state },
    );
  };
  const focusTab = switchedTo === `${id}:${params.get('view') === 'statements' || params.get('view') === 'details' ? params.get('view') : 'cycle'}`;
  const ownerName = account.is_shared ? 'Shared' : (members.find((m) => m.id === account.owner_member_id)?.display_name ?? 'Unassigned');
  const kicker = `Credit card · ${ownerName}`;
  if (tab === 'details') return editor(account, { tabs: CARD_TABS, onTab: setTab, kicker, focusTab });

  const rows = statementRows({ accounts: [account], reconciliations: statementReconciliations, transactions, now });
  return (
    <Drawer
      kicker={kicker}
      title={account.name}
      tabs={CARD_TABS}
      tab={tab}
      onTab={setTab}
      focusTab={focusTab}
      wide
      onClose={close}
      footer={
        <button type="button" className="ds-btn" onClick={close}>
          Close
        </button>
      }
    >
      {tab === 'cycle' ? (
        <CardCycle account={account} transactions={transactions} rows={rows} categories={categories} money={money} now={now} whole={scope !== 'both'} />
      ) : (
        <CardStatements account={account} rows={rows} />
      )}
    </Drawer>
  );
}

// The card's running cycle: what is owed, spent and used of the limit; the
// cycle's dates and the payment due; the cycle's transactions.
function CardCycle({ account, transactions, rows, categories, money, now, whole }) {
  const cycle = cardCycle(account, transactions, now);
  const [row] = liabilityRows([account], transactions, { now });
  const due = paymentDue(account, rows, now);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const owed = accountValueAed(account);
  const foreign = String(account.currency ?? 'AED').toUpperCase() !== 'AED';
  const native = `${String(account.currency ?? 'AED').toUpperCase()} ${Number(account.balance ?? 0).toLocaleString('en-AE')}`;
  const used = row?.limitUsed;
  const count = cycle?.transactions.length ?? 0;
  return (
    <div className="ad">
      {/* In one person's view the ledger row is their part; this is the card
          itself, which both of them may use. */}
      {whole && <div className="ad-ink3">The whole card, for both of you.</div>}
      <div className="ad-kpis">
        <KpiStrip
          items={[
            {
              label: 'Owed',
              value: owed === null ? native : money.fmtBalance(owed),
              tone: owed !== null && owed > 0 ? 'neg' : undefined,
              sub: (
                <>
                  {foreign && owed !== null && `${native} · `}
                  {isBalanceConfirmed(account) && account.balance_as_of ? `checked ${shortDate(account.balance_as_of)}` : <Chip tone="warn">Not confirmed</Chip>}
                </>
              ),
            },
            {
              label: 'Spent this cycle',
              info: <InfoButton about="Spent this cycle">Purchases less refunds recorded on this card since its last statement day, counted as the statement will count them.</InfoButton>,
              value: cycle ? money.fmtBalance(cycle.spent) : '—',
              sub: cycle ? `${count} transaction${count === 1 ? '' : 's'}` : 'Needs a statement day',
            },
            {
              label: 'Limit used',
              value: used && used.share !== null ? `${Math.round(Math.max(0, used.share) * 100)}%` : '—',
              sub: used ? <LimitUsed used={used} name={account.name} money={money} /> : 'No limit set',
            },
          ]}
        />
      </div>
      <dl className="ad-kv">
        {cycle && (
          <>
            <dt>Cycle</dt>
            <dd>
              {`${shortDate(cycle.from)} – ${shortDate(cycle.to)}`}
              <span className="ad-ink3">{cycle.closesIn === 0 ? ' · closes today' : ` · closes in ${cycle.closesIn}d`}</span>
            </dd>
          </>
        )}
        {due && (
          <>
            <dt>Payment due</dt>
            <dd>
              {shortDate(due.date)}
              <span className="ad-ink3">
                {due.statementTo
                  ? ` · ${due.amount != null ? `${money.fmtBalance(due.amount, { decimals: 2 })} ` : ''}for the statement to ${shortDate(due.statementTo)}`
                  : due.cycleTo
                    ? ` · for the cycle that closes ${shortDate(due.cycleTo)}`
                    : ''}
              </span>
            </dd>
          </>
        )}
      </dl>
      {cycle && (
        <>
          <h3 className="ad-sec">{`On this card since ${shortDate(cycle.from)}`}</h3>
          {count === 0 ? (
            <div className="ad-ink3">Nothing on this card yet this cycle.</div>
          ) : (
            <table className="ds-table ad-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Merchant</th>
                  <th scope="col">Category</th>
                  <th scope="col" className="ds-num">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {cycle.transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="ad-date">{shortDate(t.occurred_at)}</td>
                    <td>{t.merchant?.trim() || 'No merchant'}</td>
                    <td className="ad-ink2">{t.is_split ? 'Split' : (catName.get(t.category_id) ?? 'Uncategorised')}</td>
                    <td className="ds-num">{money.fmtBalance(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <Link className="ds-link ds-link-accent" to={activityHref({ accountId: account.id, allDates: true, who: 'both' })}>
        All transactions on this card
      </Link>
    </div>
  );
}

// The card's recent statements, as Month end's table reads them, newest
// first, with the way to check them there.
function CardStatements({ account, rows }) {
  const list = [...rows].sort((a, b) => (a.statementDate < b.statementDate ? 1 : -1));
  const open = statementsToCheck(rows);
  const aed = (v) => `AED ${formatBalance(v, { decimals: 2 })}`;
  return (
    <div className="ad">
      <div className="ad-head">
        <span className="ad-ink2">{`Closes on the ${ordinal(account.statement_day)}${account.due_day ? ` · due on the ${ordinal(account.due_day)}` : ''}`}</span>
        {list.length > 0 && (open ? <Chip tone="warn">{`${open} to check`}</Chip> : <Chip tone="pos">All checked</Chip>)}
      </div>
      {list.length === 0 ? (
        <div className="ad-ink3">No statements yet. They start once the card has a statement day.</div>
      ) : (
        <table className="ds-table ad-table">
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col" className="ds-num">
                In Rokda
              </th>
              <th scope="col" className="ds-num">
                Statement
              </th>
              <th scope="col" className="ds-num">
                Difference
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const status = STATEMENT_STATUS[r.status] ?? STATEMENT_STATUS.unchecked;
              return (
                <tr key={r.statementDate}>
                  <td className="ad-name">{`${shortDate(r.periodStart)} – ${shortDate(r.statementDate)}`}</td>
                  <td className="ds-num">{aed(r.recordedSpend)}</td>
                  <td className="ds-num">{r.statementSpend == null ? <span className="ad-ink3">—</span> : aed(r.statementSpend)}</td>
                  <td className="ds-num">
                    {r.difference == null ? '' : r.difference === 0 ? <span className="ad-pos">Matches</span> : <span className="ad-neg">{`${aed(Math.abs(r.difference))} ${r.difference > 0 ? 'higher' : 'lower'}`}</span>}
                  </td>
                  <td>
                    <Chip tone={status.tone}>{status.label}</Chip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Link className="ds-link ds-link-accent" to={tabHref('/money', 'monthend')}>
        Check statements in Month end
      </Link>
    </div>
  );
}
