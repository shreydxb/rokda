import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { neverLoaded } from '../../lib/loadState';
import Withheld from '../planning/Withheld';
import { useNow } from '../../lib/useNow';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId, scopedValue } from '../../lib/scope';
import { accountTypeLabel, accountValueAed, archivedAccounts, unvaluedAccounts } from '../../lib/accounts';
import { unconfirmedAccounts } from '../../lib/balance';
import { historyState, pendingClose } from '../../lib/snapshots';
import { buildNetWorthSeries, changeOverMonths } from '../../lib/netWorth';
import { ASSET_CLASS_LABELS, scopedHoldingValue, visibleHoldings } from '../../lib/holdings';
import { isStale, isAwaitingFirstValuation } from '../../lib/valuation';
import { tabHref } from '../../lib/activityLink';
import { monthParam } from '../../lib/useMonthParam';
import { assetGroups, liabilityRows } from '../../lib/netWorthLedger';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { supabase } from '../../lib/supabaseClient';
import { isLiquidAccount } from '../useOverviewData';
import { incompleteNote, netWorthSummary, runwaySummary } from '../overviewMath';
import { TrendLine } from '../../design-system/charts';
import { Avatar, Card, Chip, EmptyState, Fold, InfoButton, ProgressBar, Segmented, StackBar, WarningRow } from '../../design-system/kit';
import { Tools } from '../PageTools';
import './NetWorth.css';

// Wealth -> Net worth as the prototype lays it out (the revamp, phase 5a;
// design/prototype heroCard, grownCard, assetsCard, liabilitiesCard): what
// the household is worth and which way it is moving, and below it the
// accounts ledger that was the Accounts tab (review N5). An account opens its
// drawer through the address (`?account=`), so any page can link to one.

const GROUPINGS = [
  { id: 'type', label: 'By type' },
  { id: 'owner', label: 'By owner' },
];

// What the assets are: accounts by kind (the cash-like ones together) and
// holdings by asset class, counted as the total counts them: a balance not
// converted to AED adds nothing.
function composition(accounts, holdings, scopeMemberId) {
  const totals = new Map();
  for (const a of accounts) {
    const aed = accountValueAed(a);
    const value = aed === null ? 0 : scopedValue(aed, a, scopeMemberId);
    const label = isLiquidAccount(a) ? 'Cash' : accountTypeLabel(a.type);
    totals.set(label, (totals.get(label) ?? 0) + value);
  }
  for (const h of holdings) {
    const label = ASSET_CLASS_LABELS[h.asset_class] ?? h.asset_class ?? 'Other';
    totals.set(label, (totals.get(label) ?? 0) + scopedHoldingValue(h, scopeMemberId));
  }
  return [...totals].map(([label, value]) => ({ label, value }));
}

const pctText = (share) => `${share >= 0 ? '+' : '−'}${Math.round(Math.abs(share) * 100)}%`;

export default function NetWorth({ household, me, members, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);
  const { accounts = [], netWorthSnapshots = [], holdings = [], transactions = [], reload } = data;
  const now = useNow(data?.loadedAt);
  const [, setParams] = useSearchParams();
  const [by, setBy] = useState('type');
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The account drawer is opened through the address, so a link from any page
  // opens the same thing (screens/wealth/AccountDrawer.jsx).
  const openAccount = (id) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('account', id);
      return next;
    });

  const inView = useMemo(() => accounts.filter((a) => scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId), [accounts, scopeMemberId]);
  const open = useMemo(() => inView.filter((a) => !a.archived_at), [inView]);
  const held = useMemo(() => visibleHoldings(holdings, scopeMemberId), [holdings, scopeMemberId]);
  // Totals come from the shared basis, so Wealth, Overview and the plan
  // cannot drift apart (QA-03).
  const summary = useMemo(() => netWorthSummary(accounts, scopeMemberId, holdings), [accounts, scopeMemberId, holdings]);
  const groups = useMemo(() => assetGroups(accounts, { by, members, scopeMemberId, now }), [accounts, by, members, scopeMemberId, now]);
  const debts = useMemo(() => liabilityRows(accounts, transactions, { scopeMemberId, now }), [accounts, transactions, scopeMemberId, now]);
  const runway = useMemo(() => runwaySummary(transactions, accounts, scopeMemberId, now), [transactions, accounts, scopeMemberId, now]);
  const parts = useMemo(() => composition(open.filter((a) => !['credit_card', 'loan'].includes(a.type)), held, scopeMemberId), [open, held, scopeMemberId]);
  // Closed months are household totals, so history only means something in
  // the household's view.
  const historyAvailable = scopeMemberId === null;
  const series = useMemo(() => (historyAvailable ? buildNetWorthSeries(netWorthSnapshots, summary.assets, summary.liabilities, now) : []), [historyAvailable, netWorthSnapshots, summary, now]);

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  // A total worked out without the accounts or holdings that failed to load
  // is not the household's (outside review, E-03).
  const missing = neverLoaded(data, ['accounts', 'holdings']);
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={reload}>
        Net worth isn&rsquo;t shown, rather than worked out without them.
      </Withheld>
    );
  }

  const unconfirmed = unconfirmedAccounts(open);
  const gaps = { accounts: unvaluedAccounts(open).length, holdings: held.filter(isAwaitingFirstValuation).length };
  const gapNames = [...unvaluedAccounts(open), ...held.filter(isAwaitingFirstValuation)].map((r) => r.name).join(', ');
  const change1 = historyAvailable ? changeOverMonths(series, 1) : null;
  const change12 = historyAvailable ? changeOverMonths(series, 12) : null;
  const pending = open.length > 0 ? pendingClose(netWorthSnapshots, now) : null;
  const pendingName = pending?.month.toLocaleDateString('en-GB', { month: 'long' });
  const investmentsTotal = held.reduce((s, h) => s + scopedHoldingValue(h, scopeMemberId), 0);
  const staleHoldings = held.filter((h) => isStale(h, now)).length;
  const closed = archivedAccounts(inView);
  const memberTone = new Map(members.map((m, i) => [m.id, i === 0 ? 'a' : 'b']));
  const owner = (a) => {
    if (a.is_shared) return <Avatar name="Shared" initial="S" />;
    const m = members.find((x) => x.id === a.owner_member_id);
    return m ? <Avatar name={m.display_name} initial={m.display_name.slice(0, 1).toUpperCase()} tone={memberTone.get(m.id)} /> : null;
  };

  async function reopen(account) {
    setBusy(true);
    setError(null);
    const { error: writeError } = await supabase.from('accounts').update({ archived_at: null, updated_at: new Date().toISOString() }).eq('id', account.id);
    setBusy(false);
    if (writeError) {
      setError(writeError.message);
      return;
    }
    await reload();
  }

  // A row opens its account; its name is the button a keyboard reaches.
  const nameCell = (row, extra) => (
    <td>
      <button type="button" className="nw-name" onClick={() => openAccount(row.account.id)}>
        {row.account.name}
      </button>
      {extra ?? (row.sub && <div className="nw-sub">{row.sub}</div>)}
    </td>
  );
  const statusCell = (row) => (
    <td className="nw-status">
      {row.status?.kind === 'unset' && (
        <span className="nw-status-in">
          <Chip tone="warn">Not confirmed</Chip>
          <button type="button" className="ds-btn ds-btn-sm" onClick={() => openAccount(row.account.id)}>
            Confirm
          </button>
        </span>
      )}
      {row.status?.kind === 'stale' && <Chip>{`Checked ${row.status.days}d ago`}</Chip>}
    </td>
  );
  const amount = (row, negative = false) =>
    row.value !== null ? (
      <span className={negative ? 'nw-neg' : undefined}>{negative ? `−${money.fmt(row.value)}` : money.fmtBalance(row.value)}</span>
    ) : (
      <span className="nw-ink3" title="Not converted to AED, so not counted">
        {row.native}
      </span>
    );
  const groupRow = (key, label, total) => (
    <tr key={key} className="nw-group">
      <td colSpan={3}>{label}</td>
      <td className="ds-num">{total == null ? '' : money.fmtBalance(total)}</td>
    </tr>
  );

  const points = series.map((p, i) => ({ key: `${p.label}-${i}`, label: p.isLive ? 'Today' : p.label, value: p.net }));
  const picked = pick !== null ? series[pick] : null;
  const history = [...series].reverse();

  return (
    <div className="nw">
      <Tools>
        <Segmented label="Group the accounts" options={GROUPINGS} value={by} onChange={setBy} />
        <button type="button" className="ds-btn ds-btn-primary" onClick={() => openAccount('new')}>
          + Account
        </button>
      </Tools>
      {error && (
        <div className="nw-error" role="alert">
          {`Couldn’t update the account: ${error}`}
        </div>
      )}

      <div className="nw-top">
        <Card title="Net worth" className="nw-hero">
          <div className="nw-hero-row">
            <div className="nw-fig">
              <span className="nw-code">{money.code}</span>
              {money.fmtBalance(summary.netWorth)}
            </div>
            {unconfirmed.length > 0 && <Chip tone="warn">Provisional</Chip>}
          </div>
          <div className="nw-change">
            {change1 ? (
              <>
                <span className={change1.absolute >= 0 ? 'nw-pos' : 'nw-neg'}>{`${change1.absolute >= 0 ? '▲' : '▼'} ${money.fmt(Math.abs(change1.absolute))}`}</span>
                {' this month'}
                {change12?.pct != null && <span className="nw-ink3">{` · ${pctText(change12.pct)} in 12 months`}</span>}
              </>
            ) : (
              <span className="nw-ink3">Not enough history yet for a trend.</span>
            )}
          </div>
          {unconfirmed.length > 0 && (
            <WarningRow action={{ label: 'Confirm', onClick: () => openAccount(unconfirmed[0].id) }}>{`${unconfirmed.map((a) => a.name).join(', ')} · balance not confirmed`}</WarningRow>
          )}
          {/* Not counted as zero but left out: these are not in the total
              at all (QA #4). */}
          {incompleteNote(gaps) && <WarningRow>{`Incomplete: ${incompleteNote(gaps, { capitalised: false })} (${gapNames})`}</WarningRow>}
          <dl className="nw-mini">
            <div>
              <dt>Assets</dt>
              <dd>{money.fmtBalance(summary.assets)}</dd>
            </div>
            <div>
              <dt>Liabilities</dt>
              <dd>{summary.liabilities > 0 ? `−${money.fmt(summary.liabilities)}` : money.fmt(0)}</dd>
            </div>
            <div>
              <dt>
                Runway <InfoButton about="Runway">Cash in current, savings and cash accounts, divided by an average month of spending over the months just ended.</InfoButton>
              </dt>
              <dd>
                {runway.available ? (
                  <>
                    {Math.round(runway.months)} <span className="nw-unit">months</span>
                  </>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        </Card>

        <Card
          title="How it has grown"
          flush
          right={
            pending && (
              <Link className="ds-btn ds-btn-sm" to={tabHref('/money', 'monthend', { month: monthParam(pending.month) })}>
                {`Close ${pendingName}`}
              </Link>
            )
          }
        >
          {!historyAvailable ? (
            <div className="nw-note">Net worth history is tracked for the household: switch to Both to see the trend.</div>
          ) : series.length < 2 ? (
            <div className="nw-note">
              {/* History only exists because someone closes a month (QA-05). */}
              {historyState(netWorthSnapshots) === 'none'
                ? 'No month has been closed yet, so there is no history to show. Closing a month in Month end records its balances as that month’s point.'
                : 'One month has been closed so far. A second gives the first trend.'}
            </div>
          ) : (
            <>
              <div className="nw-chart">
                <TrendLine points={points} height={176} activeIndex={pick} onActiveChange={setPick} ariaLabel="Net worth at each month's close, and today. Use the arrow keys to move between months." />
                <div className="nw-readout" aria-live="polite">
                  {picked ? `${picked.isLive ? 'Today' : picked.label} · ${money.code} ${money.fmtBalance(picked.net)}` : pending ? `${pendingName} is not closed yet` : 'Every month is closed'}
                </div>
              </div>
              <Fold label="History as a table">
                <table className="ds-table nw-history">
                  <thead>
                    <tr>
                      <th scope="col">Month</th>
                      <th scope="col" className="ds-num">
                        Net worth
                      </th>
                      <th scope="col" className="ds-num">
                        Change
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((p, i) => {
                      const before = history[i + 1];
                      return (
                        <tr key={`${p.label}-${i}`}>
                          <td>{p.isLive ? 'Today · live' : p.label}</td>
                          <td className="ds-num">{money.fmtBalance(p.net)}</td>
                          <td className="ds-num">{before ? money.fmtSigned(p.net - before.net) : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Fold>
            </>
          )}
        </Card>
      </div>

      <div className="nw-ledger">
        <Card title="Assets" right={<span className="nw-ink3">{`${groups.reduce((s, g) => s + g.rows.length, 0)} accounts`}</span>} flush>
          {groups.length === 0 && held.length === 0 ? (
            <EmptyState title="No accounts yet" body="Add an account to start tracking net worth." />
          ) : (
            <div className="ds-table-wrap" tabIndex={0} role="region" aria-label="Assets by account">
              <table className="ds-table nw-table">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col" className="nw-col-owner">
                      Owner
                    </th>
                    <th scope="col" className="nw-col-status" aria-label="Status" />
                    <th scope="col" className="ds-num nw-col-amt">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.flatMap((g) => [
                    groupRow(g.id, g.label, g.total),
                    ...g.rows.map((row) => (
                      <tr key={row.account.id} className="nw-row" onClick={(e) => !e.target.closest('button') && openAccount(row.account.id)}>
                        {nameCell(row)}
                        <td>{owner(row.account)}</td>
                        {statusCell(row)}
                        <td className="ds-num">{amount(row)}</td>
                      </tr>
                    )),
                  ])}
                  {held.length > 0 && [
                    groupRow('invested', 'Invested', null),
                    <tr key="investments" className="nw-row" onClick={(e) => !e.target.closest('button') && setParams({ tab: 'investments' })}>
                      <td>
                        <button type="button" className="nw-name" onClick={() => setParams({ tab: 'investments' })}>
                          Investments
                        </button>
                        <div className="nw-sub">{`${held.length} holding${held.length === 1 ? '' : 's'}`}</div>
                      </td>
                      <td />
                      <td className="nw-status">{staleHoldings > 0 && <Chip tone="warn">{`${staleHoldings} stale price${staleHoldings === 1 ? '' : 's'}`}</Chip>}</td>
                      <td className="ds-num">
                        {money.fmt(investmentsTotal)} <span className="nw-ink3">→</span>
                      </td>
                    </tr>,
                  ]}
                  <tr className="nw-total">
                    <td colSpan={3}>Total assets</td>
                    <td className="ds-num">{money.fmtBalance(summary.assets)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="nw-stack">
          <Card title="Liabilities" right={<span className="nw-ink3">{`${debts.length} account${debts.length === 1 ? '' : 's'}`}</span>} flush>
            {debts.length === 0 ? (
              <EmptyState title="Nothing owed" />
            ) : (
              <div className="ds-table-wrap" tabIndex={0} role="region" aria-label="Liabilities by account">
                <table className="ds-table nw-table">
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col" className="nw-col-owner">
                        Owner
                      </th>
                      <th scope="col" className="nw-col-limit">
                        Limit used
                      </th>
                      <th scope="col" className="ds-num nw-col-owed">
                        Owed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {debts.map((row) => (
                      <tr key={row.account.id} className="nw-row" onClick={(e) => !e.target.closest('button') && openAccount(row.account.id)}>
                        {nameCell(
                          row,
                          <div className="nw-sub">
                            {row.cycle ? `${money.fmt(row.cycle.spent)} this cycle · closes in ${row.cycle.closesIn}d` : row.sub}
                            {row.status?.kind === 'unset' && (
                              <>
                                {' '}
                                <Chip tone="warn">Not confirmed</Chip>
                              </>
                            )}
                          </div>,
                        )}
                        <td>{owner(row.account)}</td>
                        <td>
                          {row.limitUsed && (
                            <div className="nw-util">
                              <ProgressBar label={`${row.account.name}, limit used`} value={Math.max(0, row.limitUsed.share) * row.limitUsed.limit} max={row.limitUsed.limit} tone={row.limitUsed.share > 0.8 ? 'neg' : 'accent'} />
                              <span className="nw-sub">{`${Math.round(row.limitUsed.share * 100)}% of ${row.limitUsed.currency === 'AED' ? '' : `${row.limitUsed.currency} `}${Number(row.limitUsed.limit).toLocaleString('en-AE')}`}</span>
                            </div>
                          )}
                        </td>
                        <td className="ds-num">{amount(row, true)}</td>
                      </tr>
                    ))}
                    <tr className="nw-total">
                      <td colSpan={3}>Total liabilities</td>
                      <td className="ds-num nw-neg">{summary.liabilities > 0 ? `−${money.fmt(summary.liabilities)}` : money.fmt(0)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {closed.length > 0 && (
              <Fold label="Closed" count={closed.length}>
                <ul className="nw-closed">
                  {closed.map((a) => (
                    <li key={a.id}>
                      <span className="nw-closed-main">
                        <span className="nw-closed-name">{a.name}</span>
                        <span className="nw-sub">{`${accountTypeLabel(a.type)} · stays in history`}</span>
                      </span>
                      <button type="button" className="ds-btn ds-btn-sm" disabled={busy} onClick={() => reopen(a)}>
                        Reopen
                      </button>
                    </li>
                  ))}
                </ul>
              </Fold>
            )}
          </Card>

          {parts.some((p) => p.value > 0) && (
            <Card title="What the assets are" right={<span className="nw-ink3">{`${money.fmt(summary.assets)} in all`}</span>}>
              <StackBar label="What the assets are, by share" parts={parts} />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
