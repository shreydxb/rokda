import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId, scopedValue } from '../../lib/scope';
import { formatMoney, formatSigned, formatPct } from '../../lib/money';
import { buildNetWorthSeries, changeOverMonths } from '../../lib/netWorth';
import { isLiabilityAccount, isLiquidAccount } from '../useOverviewData';

export default function NetWorth({ me, members, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { accounts, netWorthSnapshots } = data;

  const now = useMemo(() => new Date(), []);
  const [selectedIdx, setSelectedIdx] = useState(null);

  const visible = accounts.filter((a) => scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId);
  const assetRows = visible.filter((a) => !isLiabilityAccount(a));
  const liabilityRows = visible.filter((a) => isLiabilityAccount(a));
  const liveAssets = assetRows.reduce((s, a) => s + scopedValue(a.balance, a, scopeMemberId), 0);
  const liveLiabilities = liabilityRows.reduce((s, a) => s + scopedValue(a.balance, a, scopeMemberId), 0);
  const netWorth = liveAssets - liveLiabilities;

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
  const maxNet = Math.max(1, ...series.map((p) => Math.max(p.net, 0)));
  const selected = selectedIdx !== null ? series[selectedIdx] : series[series.length - 1];

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <section className="wl-hero">
        <div className="ov-kicker">Net worth</div>
        <div className="ov-hero fig">
          <span className="ov-hero-currency">AED</span> {formatMoney(netWorth)}
        </div>
        <div className="ov-strip">
          {change1mo && (
            <span>
              <span className={change1mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                {change1mo.absolute >= 0 ? '▲' : '▼'} {formatSigned(change1mo.absolute)}
              </span>{' '}
              this month
            </span>
          )}
          {change12mo && (
            <span>
              12-mo{' '}
              <span className={change12mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                {change12mo.pct !== null ? formatPct(change12mo.pct) : formatSigned(change12mo.absolute)}
              </span>
            </span>
          )}
          {!change1mo && !change12mo && <span className="ov-muted">Not enough history yet for a trend.</span>}
        </div>
      </section>

      <section className="wl-breakdown">
        <div className="ov-kicker" style={{ marginBottom: 10 }}>
          Assets
        </div>
        <AccountList rows={assetRows} scopeMemberId={scopeMemberId} members={members} />
        <div className="ov-kicker" style={{ marginBottom: 10, marginTop: 26 }}>
          Liabilities
        </div>
        {liabilityRows.length === 0 ? (
          <div className="ov-muted">None.</div>
        ) : (
          <AccountList rows={liabilityRows} scopeMemberId={scopeMemberId} members={members} negative />
        )}
      </section>

      <section className="wl-history">
        <div className="ov-kicker" style={{ marginBottom: 14 }}>
          How it's grown
        </div>
        {!historyAvailable ? (
          <div className="ov-muted">Net worth history is tracked household-wide — switch to "Both" to see the trend.</div>
        ) : series.length < 2 ? (
          <div className="ov-muted">Net worth history builds up month by month — check back after a full month has passed.</div>
        ) : (
          <>
            <div className="ov-chart" style={{ gap: series.length > 8 ? 4 : 12 }}>
              {series.map((p, i) => (
                <button
                  key={p.label + i}
                  type="button"
                  className="ov-col"
                  data-active={(selectedIdx ?? series.length - 1) === i}
                  onClick={() => setSelectedIdx(i)}
                  aria-label={`${p.label}: net worth ${formatMoney(p.net)}`}
                >
                  <div className="ov-col-bars">
                    <span
                      className="ov-bar-inc"
                      style={{ height: `${Math.max(2, (p.net / maxNet) * 100)}%`, opacity: p.isLive ? 1 : 0.7 }}
                    />
                  </div>
                  <div className="ov-col-label">{p.label}</div>
                </button>
              ))}
            </div>
            {selected && (
              <div className="ov-chart-readout">
                <span className="fig">{selected.label}</span>
                <span>
                  Net <b className="fig">{formatMoney(selected.net)}</b>
                </span>
                <span>
                  Assets <b className="fig">{formatMoney(selected.assets)}</b>
                </span>
                <span>
                  Liabilities <b className="fig">{formatMoney(selected.liabilities)}</b>
                </span>
                {selected.isLive && <span className="ov-muted">this month, live</span>}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function AccountList({ rows, scopeMemberId, members, negative }) {
  if (rows.length === 0) return <div className="ov-muted">None yet.</div>;
  return (
    <div className="mn-list">
      {rows.map((a) => (
        <div key={a.id} className="mn-row" style={{ cursor: 'default' }}>
          <div className="mn-row-main">
            <div>{a.name}</div>
            <div className="ov-muted">
              {a.is_shared ? 'Joint' : (members.find((m) => m.id === a.owner_member_id)?.display_name ?? 'Unassigned')}
              {isLiquidAccount(a) ? '' : ` · ${a.type}`}
            </div>
          </div>
          <div className={`fig mn-row-amt ${negative ? 'ov-neg' : ''}`}>
            {negative ? '−' : ''}
            {formatMoney(scopedValue(a.balance, a, scopeMemberId))}
          </div>
        </div>
      ))}
    </div>
  );
}
