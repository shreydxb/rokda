import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useNow } from '../../lib/useNow';
import { formatBalance, formatMoney, formatSigned } from '../../lib/money';
import { activityHref, monthRange, tabHref, UNCATEGORISED } from '../../lib/activityLink';
import { monthParam } from '../../lib/useMonthParam';
import { biggestChanges, closedMonthFigures, monthEndMonth, monthEndPage, runningMonthStrip } from '../../lib/monthEnd';
import { budgetSummary } from '../../lib/monthlyReview';
import { statementRows } from '../../lib/statements';
import { pendingClose } from '../../lib/snapshots';
import { couldntLoad, neverLoaded } from '../../lib/loadState';
import { BarList, Card, Chip, EmptyState, InfoButton, KpiStrip, MonthStepper, ProgressBar } from '../../design-system/kit';
import Withheld from '../planning/Withheld';
import { Tools } from './MoneyTools';
import StatementsTable, { MarkTicked } from './StatementsTable';
import { useStatementActions } from './useStatementActions';
import MonthEndSteps from './MonthEndSteps';
import './MonthEnd.css';

// Money -> Month end (the revamp, phase 4d; design/prototype meRunning,
// meSteps, meClosed), in place of Review and Wealth -> Statements. Which page
// a month shows depends on where it is (lib/monthEnd.js): the running month
// with its strip and the card statements still open; the month just ended,
// or an earlier one never closed, as steps (MonthEndSteps.jsx); and a closed
// month on a page. It covers the whole household, whoever is selected: a
// month closes for the household.

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longMonth = (year, month) => new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long' });

export default function MonthEnd({ household, members = [], me, data, loading }) {
  const [params, setParams] = useSearchParams();
  const now = useNow(data?.loadedAt);
  const navigate = useNavigate();
  const monthValue = params.get('month');
  const { year, month } = useMemo(() => monthEndMonth(monthValue, now), [monthValue, now]);
  const running = year === now.getFullYear() && month === now.getMonth() + 1;
  // The month is in the address, shared with the other tabs; the running
  // month is left out of it, as on Activity and Budget. A step a link opened
  // belongs to the month it was opened on.
  const goTo = (date) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('step');
        if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) next.delete('month');
        else next.set('month', monthParam(date));
        return next;
      },
      { replace: true },
    );

  const tools = (
    <Tools>
      <MonthStepper label={`${SHORT[month - 1]} ${year}`} onPrev={() => goTo(new Date(year, month - 2, 1))} onNext={() => goTo(new Date(year, month, 1))} nextDisabled={running} />
    </Tools>
  );

  if (loading)
    return (
      <>
        {tools}
        <div className="ov-skel" aria-busy="true" />
      </>
    );
  // Statements checked against records that never loaded read as not
  // matching Rokda's spending of nothing (round 2 of the outside review,
  // E2-3), and a month whose close never loaded would read as one still to
  // close.
  // So would a pair already kept as two real records, offered for deleting,
  // without the transfer links; and records filed under no category without
  // the categories (the fresh review of 4d).
  const missing = neverLoaded(data, ['accounts', 'transactions', 'statementReconciliations', 'netWorthSnapshots', 'transactionLinks', 'categories']);
  if (missing.length > 0) {
    return (
      <>
        {tools}
        <Withheld missing={missing} onRetry={data.reload}>
          Month end isn&rsquo;t shown, rather than worked out from records that aren&rsquo;t here.
        </Withheld>
      </>
    );
  }

  const page = monthEndPage({ year, month }, data.netWorthSnapshots ?? [], now);
  // A month before the first record has nothing to tidy or show; the month
  // just ended always has its close, whenever the records start (the fresh
  // review of 4d).
  const first = (data.transactions ?? []).reduce((min, t) => {
    const day = String(t.occurred_at).slice(0, 7);
    return min === null || day < min ? day : min;
  }, null);
  const beforeRecords = page === 'earlier' && (first === null || monthParam(new Date(year, month - 1, 1)) < first);

  return (
    <div className="me">
      {tools}
      {beforeRecords ? (
        <EmptyState title={`No records in ${longMonth(year, month)} ${year}`} body={first ? `Records start in ${SHORT[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}.` : null} />
      ) : page === 'running' ? (
        <RunningMonth household={household} members={members} me={me} data={data} year={year} month={month} now={now} />
      ) : page === 'closed' ? (
        <>
          <ClosedMonth data={data} year={year} month={month} now={now} navigate={navigate} />
          {/* A month can be closed with steps still open ("finish after"),
              and its statements checked or reopened later, so its checks
              stay beneath its page (the fresh review of 4d). */}
          <MonthEndSteps key={`closed-${year}-${month}`} household={household} members={members} me={me} data={data} year={year} month={month} now={now} closable={false} closed />
        </>
      ) : (
        <MonthEndSteps key={`${year}-${month}`} household={household} members={members} me={me} data={data} year={year} month={month} now={now} closable={page === 'close'} />
      )}
    </div>
  );
}

// The running month: nothing to close yet, but a statement can close in it,
// and records can be tidied as they come (design/prototype meRunning).
function RunningMonth({ household, members, me, data, year, month, now }) {
  const { accounts = [], transactions = [], statementReconciliations = [], netWorthSnapshots = [] } = data;
  const rows = useMemo(() => statementRows({ accounts, reconciliations: statementReconciliations, transactions, now }), [accounts, statementReconciliations, transactions, now]);
  const strip = runningMonthStrip({ year, month }, { transactions, accounts, statements: rows }, now);
  const actions = useStatementActions({ household, me, reload: data.reload });
  const pending = pendingClose(netWorthSnapshots, now);
  const clear = <Chip tone="pos">All clear</Chip>;

  return (
    <>
      <div className="me-head">
        <div>
          <h2 className="me-title">{`${longMonth(year, month)} is still running`}</h2>
          <div className="me-sub">{`Closes after ${new Date(year, month, 0).getDate()} ${SHORT[month - 1]}`}</div>
        </div>
        <span className="me-grow" />
        {pending && (
          <Link className="ds-btn ds-btn-primary" to={tabHref('/money', 'monthend', { month: monthParam(pending.month) })}>
            {`Close ${pending.month.toLocaleDateString('en-GB', { month: 'long' })}`}
          </Link>
        )}
      </div>
      <Card flush>
        <KpiStrip
          items={[
            {
              label: 'Uncategorised so far',
              value: String(strip.uncategorised),
              sub: strip.uncategorised ? (
                <Link className="ds-link ds-link-accent" to={activityHref({ categoryId: UNCATEGORISED, ...monthRange(year, month), who: 'both' })}>
                  Categorise →
                </Link>
              ) : (
                clear
              ),
            },
            {
              label: 'Statements to check',
              value: String(strip.statements),
              sub: strip.mismatched ? <Chip tone="neg">{`${strip.mismatched} ${strip.mismatched === 1 ? 'doesn’t' : 'don’t'} match`}</Chip> : strip.statements ? null : clear,
            },
            {
              label: 'Balances not confirmed',
              value: String(strip.balances),
              sub: strip.balances ? (
                <Link className="ds-link ds-link-accent" to={tabHref('/wealth', 'accounts', { who: 'both' })}>
                  Accounts →
                </Link>
              ) : (
                clear
              ),
            },
          ]}
        />
      </Card>
      <Card title="Card statements" right={<MarkTicked rows={rows} actions={actions} />} flush>
        {rows.length > 0 ? (
          <StatementsTable rows={rows} accounts={accounts} members={members} actions={actions} />
        ) : (
          <EmptyState title="No card statements yet" body="Give a card its statement day under Accounts, and its statements will be listed here." />
        )}
      </Card>
    </>
  );
}

// A change on an earlier figure, as an arrow and an amount, green when it
// went the good way.
function Delta({ value, was, goodUp, label }) {
  if (was == null) return <span className="me-ink3">The first month with records</span>;
  if (Math.abs(value - was) < 0.5) return <span className="me-ink3">{`Same as ${label}`}</span>;
  const up = value > was;
  return (
    <>
      <span className={up === goodUp ? 'me-pos' : 'me-neg'}>{`${up ? '▲' : '▼'} ${formatMoney(Math.abs(value - was))}`}</span>
      {` on ${label}`}
    </>
  );
}

// A closed month, the month on a page (design/prototype meClosed): its
// figures with what changed, its biggest changes against the usual, and how
// it did against its budget.
function ClosedMonth({ data, year, month, now, navigate }) {
  const figures = closedMonthFigures({ year, month }, data, now);
  const changes = biggestChanges(data.transactions ?? [], data.categories ?? [], { year, month }, now);
  const budget = budgetSummary({ year, month }, data, now);
  // Budgets that never loaded are not none set.
  const budgetsUnread = neverLoaded(data, ['budgets']);
  const range = monthRange(year, month);
  const name = longMonth(year, month);
  const previous = figures.previous;

  return (
    <>
      <div className="me-head">
        <div>
          <h2 className="me-title">{`${name} ${year}`}</h2>
          <div className="me-sub">The month on a page</div>
        </div>
        <Chip tone="pos">Closed</Chip>
        <span className="me-grow" />
        <Link className="ds-link ds-link-accent" to={activityHref({ ...range, who: 'both' })}>
          Transactions →
        </Link>
      </div>
      <Card flush>
        <KpiStrip
          items={[
            { label: 'Income', value: formatMoney(figures.income), sub: <Delta value={figures.income} was={previous?.income ?? null} goodUp label={previous?.label} /> },
            { label: 'Spent', value: formatBalance(figures.spend), sub: <Delta value={figures.spend} was={previous?.spend ?? null} goodUp={false} label={previous?.label} /> },
            { label: 'Saved', value: formatBalance(figures.saved), tone: figures.saved < 0 ? 'neg' : undefined, sub: figures.rate == null ? null : `${Math.round(figures.rate * 100)}% of income` },
            {
              label: 'Net worth at close',
              value: figures.netWorth == null ? '—' : formatBalance(figures.netWorth),
              sub: figures.netWorthChange == null ? <span className="me-ink3">The first month closed</span> : <Delta value={figures.netWorth} was={figures.netWorth - figures.netWorthChange} goodUp label={figures.previousClose} />,
            },
          ]}
        />
      </Card>
      <div className="me-grid">
        <Card
          title={changes.moved ? 'Biggest changes' : 'Biggest categories'}
          info={<InfoButton about="the changes">Against each category&rsquo;s usual month: the average of up to six earlier months with records. The tick marks the usual. Choose one to see its transactions.</InfoButton>}
        >
          {changes.rows.length === 0 ? (
            <div className="me-ink3">Nothing was spent this month.</div>
          ) : (
            <BarList
              // Ranked by how far each moved, as lib/monthEnd.js gives them.
              ordered={changes.moved}
              items={changes.rows.map((r) => ({
                id: r.categoryId,
                label: r.name,
                value: r.spent,
                usual: r.usual ?? undefined,
                // Signed, since refunds can take a category below nothing; the
                // change with it, where the value column is never cut short.
                display: (
                  <>
                    <span>{formatBalance(r.spent)}</span>
                    {r.usual != null && <span className={`me-bl-note ${r.spent > r.usual ? 'me-warn' : 'me-ink3'}`}>{`${formatSigned(r.spent - r.usual)} vs usual`}</span>}
                  </>
                ),
              }))}
              onSelect={(item) => navigate(activityHref({ categoryId: item.id, ...range, who: 'both' }))}
            />
          )}
        </Card>
        <Card
          title="Against budget"
          right={
            <Link className="ds-link ds-link-accent" to={tabHref('/money', 'budget', { month: monthParam(new Date(year, month - 1, 1)), who: 'both' })}>
              Budget →
            </Link>
          }
        >
          {budgetsUnread.length > 0 ? (
            <div className="me-ink2">{couldntLoad(budgetsUnread)}</div>
          ) : budget.hasBudget ? (
            <>
              <div className="me-fig">
                {formatBalance(budget.spentInBudget)} <span className="me-of">{`of ${formatMoney(budget.budgeted)}`}</span>
              </div>
              <ProgressBar label="Spent against the budget" value={budget.spentInBudget} max={budget.budgeted} tone={budget.spentInBudget > budget.budgeted ? 'neg' : 'accent'} format={formatMoney} />
              <div className="me-chips">
                {budget.over.length > 0 ? budget.over.map((g) => <Chip key={g.categoryId} tone="neg">{`${g.name} over by ${formatMoney(g.spent - g.budget)}`}</Chip>) : <Chip tone="pos">No category over</Chip>}
              </div>
            </>
          ) : (
            <div className="me-ink2">{`No budget was set for ${name}.`}</div>
          )}
        </Card>
      </div>
    </>
  );
}
