import { useMemo, useState } from 'react';
import { neverLoaded } from '../../lib/loadState';
import Withheld from '../planning/Withheld';
import { useNow } from '../../lib/useNow';
import { LineChart } from '../../charts/Charts';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId, scopedValue } from '../../lib/scope';
import { accountTypeLabel, accountValueAed, isArchived, unvaluedAccounts } from '../../lib/accounts';
import { balanceStatus, unconfirmedAccounts } from '../../lib/balance';
import { historyState } from '../../lib/snapshots';
import { useMonthClose } from '../../lib/useMonthClose';
import MonthCloseForm from './MonthCloseForm';
import { formatPct } from '../../lib/money';
import { buildNetWorthSeries, changeOverMonths } from '../../lib/netWorth';
import { ASSET_CLASS_LABELS, scopedHoldingValue, visibleHoldings } from '../../lib/holdings';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { isLiabilityAccount, isLiquidAccount } from '../useOverviewData';
import { incompleteNote, netWorthSummary } from '../overviewMath';
import { isAwaitingFirstValuation } from '../../lib/valuation';
import './NetWorth.css';

const COMPOSITION_PALETTE = ['var(--accent)', 'var(--pos)', 'var(--warn)', 'var(--ink2)', 'var(--neg)', 'var(--accent-hover)'];

// A breakdown of assets (accounts + holdings) by class, for the allocation
// bar -- cash accounts group together, other account types keep their own
// label, and holdings group by asset class. Liabilities aren't part of this:
// the bar shows what the household HOLDS, not what it owes.
function buildComposition(assetRows, holdingRows, scopeMemberId) {
  const totals = new Map();
  for (const a of assetRows) {
    const label = isLiquidAccount(a) ? 'Cash' : accountTypeLabel(a.type);
    // An unconverted foreign balance contributes nothing to the allocation
    // bar rather than contributing its native number as though it were
    // dirhams -- the bar is proportions of an AED total, and a rupee figure
    // in it silently rescales every other slice (QA #4). The hero above says
    // the total is incomplete, which covers the bar too.
    const aed = accountValueAed(a);
    const value = balanceStatus(a) === 'unset' || aed === null ? 0 : scopedValue(aed, a, scopeMemberId);
    totals.set(label, (totals.get(label) ?? 0) + value);
  }
  for (const h of holdingRows) {
    const label = ASSET_CLASS_LABELS[h.asset_class] ?? h.asset_class ?? 'Other';
    totals.set(label, (totals.get(label) ?? 0) + scopedHoldingValue(h, scopeMemberId));
  }
  const total = [...totals.values()].reduce((s, v) => s + Math.max(0, v), 0);
  return [...totals.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({
      label,
      value,
      pct: total > 0 ? value / total : 0,
      color: COMPOSITION_PALETTE[i % COMPOSITION_PALETTE.length],
    }));
}

export default function NetWorth({ household, me, members, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);
  const { accounts, netWorthSnapshots, holdings, reload } = data;
  const now = useNow(data?.loadedAt);
  const [selectedIdx, setSelectedIdx] = useState(null);

  // Closed accounts leave today's position but keep their transactions (QA-01).
  const visible = accounts.filter(
    (a) => !isArchived(a) && (scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId),
  );
  const assetRows = visible.filter((a) => !isLiabilityAccount(a));
  const liabilityRows = visible.filter((a) => isLiabilityAccount(a));
  const visibleHoldingRows = visibleHoldings(holdings, scopeMemberId);
  // Totals come from the shared basis rather than a parallel calculation, so
  // Wealth, Overview and Forecast cannot drift apart (QA-03). That basis
  // (overviewMath.netWorthSummary) skips an account whose AED value is
  // unknown -- it does NOT fall back to the native amount -- and reports how
  // many it skipped, which is what `unvalued` below surfaces (QA #4).
  const unconfirmed = unconfirmedAccounts(visible);
  const composition = useMemo(
    () => buildComposition(assetRows, visibleHoldingRows, scopeMemberId),
    [assetRows, visibleHoldingRows, scopeMemberId]
  );
  const summary = useMemo(() => netWorthSummary(accounts, scopeMemberId, holdings), [accounts, scopeMemberId, holdings]);
  // Memoised rather than computed inline: the React Compiler cannot prove an
  // imported call on `visible` leaves it alone, and bails out of optimising
  // this whole component if one sits loose among the derived arrays that the
  // memos above depend on.
  const unvalued = useMemo(() => unvaluedAccounts(visible), [visible]);
  // Holdings the total leaves out for the same reason: never valued, so the
  // placeholder 0 they store is not in it (SHR-292). Named alongside the
  // unconverted accounts so the note says exactly what is missing.
  const unpriced = useMemo(() => visibleHoldingRows.filter(isAwaitingFirstValuation), [visibleHoldingRows]);
  const gaps = { accounts: unvalued.length, holdings: unpriced.length };
  const gapNames = [...unvalued, ...unpriced].map((r) => r.name).join(', ');
  const liveAssets = summary.assets;
  const liveLiabilities = summary.liabilities;
  const netWorth = summary.netWorth;

  // net_worth_snapshots are stored as household-wide totals, not split by
  // member, so history only means something when viewing "Both" — a scoped
  // view would be comparing a scoped live figure against unscoped history.
  const historyAvailable = scopeMemberId === null;
  const series = useMemo(
    () => (historyAvailable ? buildNetWorthSeries(netWorthSnapshots, liveAssets, liveLiabilities, now) : []),
    [historyAvailable, netWorthSnapshots, liveAssets, liveLiabilities, now]
  );
  const change1mo = historyAvailable ? changeOverMonths(series, 1) : null;
  const change12mo = historyAvailable ? changeOverMonths(series, 12) : null;
  // Closing the month just ended, shared with the monthly review.
  const close = useMonthClose({ householdId: household?.id, accounts, holdings, netWorthSnapshots, now, onClosed: reload });
  const pending = close.pending;

  const selected = selectedIdx !== null ? series[selectedIdx] : series[series.length - 1];

  if (loading) return <div className="ov-skel" aria-busy="true" />;
  // A total worked out without the accounts or holdings that failed to load
  // is not the household's, and a month must not be closed on it: no figure
  // and no close until they load (outside review, E-03).
  const missing = neverLoaded(data, ['accounts', 'holdings']);
  if (missing.length > 0) {
    return (
      <Withheld missing={missing} onRetry={reload}>
        Net worth isn&rsquo;t shown, rather than worked out without them, and no month can be closed until they load.
      </Withheld>
    );
  }

  const investmentsTotal = visibleHoldingRows.reduce((s, h) => s + scopedHoldingValue(h, scopeMemberId), 0);
  // Same last-6-closed-months delta the history table's Change column shows,
  // just as a compact list -- the design's "Monthly change" section is that
  // same figure, not a second calculation that could disagree with it.
  const monthlyChanges = historyAvailable
    ? series
        .slice(-6)
        .map((p) => {
          const prevIdx = series.indexOf(p) - 1;
          const prev = prevIdx >= 0 ? series[prevIdx] : null;
          return { label: p.label, change: prev ? p.net - prev.net : null };
        })
        .filter((c) => c.change !== null)
    : [];

  return (
    <div>
      <section className="wl-hero">
        <div className="wl-hero-row">
          <div>
            <div className="ov-kicker">Net worth</div>
            <div className="ov-hero fig">
              <span className="ov-hero-currency">{money.code}</span> {money.fmtBalance(netWorth)}
            </div>
            {unconfirmed.length > 0 && (
              <div className="ov-muted" style={{ marginTop: 6, fontSize: 12 }}>
                Provisional — {unconfirmed.length} account{unconfirmed.length === 1 ? '' : 's'} without a confirmed balance{' '}
                {unconfirmed.length === 1 ? 'is' : 'are'} counted as zero.
              </div>
            )}
            {/* Not the same as provisional: these are not counted as zero,
                they are not in the total at all (QA #4). */}
            {incompleteNote(gaps) && (
              <div className="ov-warn" style={{ marginTop: 6, fontSize: 12 }}>
                Incomplete — {incompleteNote(gaps, { capitalised: false })} ({gapNames})
              </div>
            )}
            <div className="ov-strip">
              {change1mo && (
                <span>
                  <span className={change1mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                    {change1mo.absolute >= 0 ? '▲' : '▼'} {money.fmtSigned(change1mo.absolute)}
                  </span>{' '}
                  this month
                </span>
              )}
              {change12mo && (
                <span>
                  12-mo{' '}
                  <span className={change12mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                    {change12mo.pct !== null ? formatPct(change12mo.pct) : money.fmtSigned(change12mo.absolute)}
                  </span>
                </span>
              )}
              {!change1mo && !change12mo && <span className="ov-muted">Not enough history yet for a trend.</span>}
            </div>
          </div>
          {composition.length > 0 && (
            <div className="wl-composition">
              <div className="ov-kicker" style={{ marginBottom: 10 }}>
                Composition
              </div>
              <div className="wl-composition-bar">
                {composition.map((c) => (
                  <span key={c.label} style={{ width: `${Math.max(1, c.pct * 100).toFixed(2)}%`, background: c.color }} />
                ))}
              </div>
              <div className="wl-composition-legend">
                {composition.map((c) => (
                  <span key={c.label}>
                    <span className="wl-composition-dot" style={{ background: c.color }} />
                    {c.label} {formatPct(c.pct)} · {money.fmt(c.value)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="wl-breakdown wl-breakdown-grid">
        <div>
          <div className="ov-kicker" style={{ marginBottom: 10 }}>
            Assets
          </div>
          <AccountList rows={assetRows} scopeMemberId={scopeMemberId} members={members} money={money} />
          {investmentsTotal > 0 && (
            <div className="mn-row" style={{ cursor: 'default' }}>
              <div className="mn-row-main">
                <div>Investments</div>
                <div className="ov-muted">
                  {visibleHoldingRows.length} holding{visibleHoldingRows.length === 1 ? '' : 's'}
                </div>
              </div>
              <div className="fig mn-row-amt">{money.fmt(investmentsTotal)}</div>
            </div>
          )}
          <div className="wl-total-row">
            <span>Total assets</span>
            <span className="fig">{money.fmtBalance(liveAssets)}</span>
          </div>
        </div>
        <div>
          <div className="ov-kicker" style={{ marginBottom: 10 }}>
            Liabilities
          </div>
          {liabilityRows.length === 0 ? (
            <div className="ov-muted">None.</div>
          ) : (
            <AccountList rows={liabilityRows} scopeMemberId={scopeMemberId} members={members} money={money} negative />
          )}
          <div className="wl-total-row">
            <span>Total liabilities</span>
            <span className="fig ov-neg">{liveLiabilities > 0 ? `−${money.fmt(liveLiabilities)}` : money.fmt(0)}</span>
          </div>

          {monthlyChanges.length > 0 && (
            <>
              <div className="ov-kicker" style={{ marginTop: 30, marginBottom: 10 }}>
                Monthly change
              </div>
              <div>
                {monthlyChanges.map((c) => (
                  <div key={c.label} className="wl-change-row">
                    <span className="ov-muted">{c.label}</span>
                    <span className={`fig ${c.change >= 0 ? 'ov-pos' : 'ov-neg'}`}>{money.fmtSigned(c.change)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="wl-history">
        <div className="wl-history-head">
          <div className="ov-kicker">How it's grown</div>
          {historyAvailable && pending && !close.draft && (
            <button type="button" className="om-btn" disabled={close.closing} onClick={close.open}>
              {`Close ${close.monthLabel}`}
            </button>
          )}
        </div>
        {historyAvailable && !pending && netWorthSnapshots.length > 0 && (
          <div className="ov-muted" style={{ marginBottom: 12 }}>
            Every completed month is closed. Closing again would change nothing.
          </div>
        )}
        {historyAvailable && <MonthCloseForm close={close} />}
        {!historyAvailable ? (
          <div className="ov-muted">Net worth history is tracked household-wide — switch to "Both" to see the trend.</div>
        ) : series.length < 2 ? (
          <div className="ov-muted">
            {/* History only exists because someone closes a month. Waiting
                alone never produced a point (QA-05). */}
            {historyState(netWorthSnapshots) === 'none'
              ? 'No month has been closed yet, so there is no history to show. Closing a month records today’s balances as that month’s point.'
              : 'One month has been closed so far. A second gives the first trend.'}
          </div>
        ) : (
          <>
            {/* A line, not bars: this is one quantity changing over time, and it
                can go below zero. The bars floored every negative month at a 2%
                sliver, drawing net debt as a small positive net worth. */}
            <LineChart
              points={series.map((p, i) => ({ key: p.label + i, label: p.label, value: p.net }))}
              height={170}
              formatTick={money.fmtCompact}
              labelEvery={Math.max(1, Math.ceil(series.length / 8))}
              activeIndex={selectedIdx ?? series.length - 1}
              onActiveChange={setSelectedIdx}
              ariaLabel="Net worth at each closed month, and this month live. Use the arrow keys to move between months."
            />
            {selected && (
              <div className="ov-chart-readout">
                <span className="fig">{selected.label}</span>
                <span>
                  Net <b className="fig">{money.fmtBalance(selected.net)}</b>
                </span>
                <span>
                  Assets <b className="fig">{money.fmtBalance(selected.assets)}</b>
                </span>
                <span>
                  Liabilities <b className="fig">{money.fmtBalance(selected.liabilities)}</b>
                </span>
                {selected.isLive && <span className="ov-muted">this month, live</span>}
              </div>
            )}
            <details className="wl-history-table">
              <summary>History as a table</summary>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Period</th>
                    <th scope="col">Assets</th>
                    <th scope="col">Liabilities</th>
                    <th scope="col">Net worth</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((p, i) => {
                    const prev = i > 0 ? series[i - 1] : null;
                    const change = prev ? p.net - prev.net : null;
                    return (
                      <tr key={p.label + i}>
                        <th scope="row">
                          {p.label}
                          {p.isLive ? ' (live)' : ''}
                        </th>
                        <td>{money.fmtBalance(p.assets)}</td>
                        <td>{money.fmtBalance(p.liabilities)}</td>
                        <td>{money.fmtBalance(p.net)}</td>
                        <td className={change !== null && change < 0 ? 'ov-warn' : ''}>{change !== null ? money.fmtSigned(change) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          </>
        )}
      </section>
    </div>
  );
}


function AccountList({ rows, scopeMemberId, members, money, negative }) {
  if (rows.length === 0) return <div className="ov-muted">None yet.</div>;
  return (
    <div className="mn-list">
      {rows.map((a) => (
        <div key={a.id} className="mn-row" style={{ cursor: 'default' }}>
          <div className="mn-row-main">
            <div>{a.name}</div>
            <div className="ov-muted">
              {a.is_shared ? 'Joint' : (members.find((m) => m.id === a.owner_member_id)?.display_name ?? 'Unassigned')}
              {isLiquidAccount(a) ? '' : ` · ${accountTypeLabel(a.type)}`}
            </div>
          </div>
          <div className={`fig mn-row-amt ${negative ? 'ov-neg' : ''}`}>
            {negative ? '−' : ''}
            {balanceStatus(a) === 'unset' ? (
              <span className="ov-muted">Not set</span>
            ) : accountValueAed(a) === null ? (
              <span className="ov-muted">
                {a.currency} {Number(a.balance ?? 0).toLocaleString('en-AE')} · not converted
              </span>
            ) : (
              money.fmtBalance(scopedValue(accountValueAed(a), a, scopeMemberId))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
