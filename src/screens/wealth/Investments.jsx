import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatSigned, formatPct } from '../../lib/money';
import {
  ASSET_CLASS_LABELS,
  GROUP_ORDER,
  RANGES,
  allocationByClass,
  groupOf,
  holdingGain,
  portfolioGain,
  portfolioSeries,
  scopedHoldingValue,
  scopedInvestedValue,
  visibleHoldings,
} from '../../lib/holdings';
import { supabase } from '../../lib/supabaseClient';
import HoldingEditor from './HoldingEditor';

export default function Investments({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const { holdings, holdingHistory, reload } = data;

  const [group, setGroup] = useState('All');
  const [range, setRange] = useState('3M');
  const [editing, setEditing] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const now = useMemo(() => new Date(), []);
  const rows = useMemo(() => visibleHoldings(holdings, scopeMemberId, group), [holdings, scopeMemberId, group]);
  const groupsPresent = ['All', ...GROUP_ORDER.filter((g) => g !== 'All' && holdings.some((h) => groupOf(h.asset_class) === g))];

  const totalValue = rows.reduce((s, h) => s + scopedHoldingValue(h, scopeMemberId), 0);
  const gain = useMemo(() => portfolioGain(rows, holdingHistory, range, scopeMemberId, now), [rows, holdingHistory, range, scopeMemberId, now]);
  const series = useMemo(() => portfolioSeries(rows, holdingHistory, scopeMemberId, now), [rows, holdingHistory, scopeMemberId, now]);
  const maxTotal = Math.max(1, ...series.map((p) => p.total));

  const allocation = useMemo(() => allocationByClass(rows, scopeMemberId), [rows, scopeMemberId]);

  const lastRefreshed = holdings.reduce((latest, h) => {
    if (!h.last_refreshed) return latest;
    const d = new Date(h.last_refreshed);
    return !latest || d > latest ? d : latest;
  }, null);

  async function handleRefresh() {
    setRefreshing(true);
    const ids = holdings.map((h) => h.id);
    await supabase.from('holdings').update({ last_refreshed: new Date().toISOString() }).in('id', ids);
    setRefreshing(false);
    await reload();
  }

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <div className="mn-filters">
        {groupsPresent.map((g) => (
          <button key={g} type="button" className="om-seg" data-active={group === g} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
        <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
          + Add holding
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No holdings</div>
          <div className="ov-empty-body">Add your first holding to start tracking performance.</div>
        </div>
      ) : (
        <>
          <section className="wl-hero" style={{ marginTop: 22 }}>
            <div className="ov-kicker">Value{group !== 'All' ? ` · ${group}` : ''}</div>
            <div className="ov-hero fig">
              <span className="ov-hero-currency">AED</span> {formatMoney(totalValue)}
            </div>
            {gain.available ? (
              <div className="ov-nwchange">
                <span className={gain.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                  {gain.absolute >= 0 ? '▲' : '▼'} {formatSigned(gain.absolute)}
                  {gain.pct !== null ? ` (${formatPct(gain.pct)})` : ''}
                </span>
                <span className="ov-muted"> {range}</span>
              </div>
            ) : (
              <div className="ov-nwchange ov-muted">Not enough history yet for {range}.</div>
            )}
            <div className="ov-seg-row" style={{ marginTop: 14 }}>
              {RANGES.map((r) => (
                <button key={r} type="button" className="om-seg" data-active={range === r} onClick={() => setRange(r)}>
                  {r}
                </button>
              ))}
            </div>
          </section>

          <section style={{ marginTop: 26 }}>
            <div className="ov-chart">
              {series.map((p, i) => (
                <div key={i} className="ov-col" data-active={p.isLive}>
                  <div className="ov-col-bars">
                    <span className="ov-bar-inc" style={{ height: `${Math.max(2, (p.total / maxTotal) * 100)}%`, opacity: p.isLive ? 1 : 0.7 }} />
                  </div>
                  <div className="ov-col-label">{p.date.toLocaleDateString('en-GB', { month: 'short' })}</div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ marginTop: 34, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" className="om-btn" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <span className="ov-muted">
              {lastRefreshed
                ? `Last refreshed ${lastRefreshed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · manual, no live price feed yet`
                : 'Never refreshed'}
            </span>
          </section>

          <section style={{ marginTop: 34 }}>
            <div className="ov-kicker" style={{ marginBottom: 10 }}>
              Allocation
            </div>
            <div className="ov-quality-grid">
              {allocation.map((a) => (
                <div key={a.assetClass} className="ov-quality-item">
                  <span className="ov-dot-pos" />
                  <div style={{ flex: 1 }}>
                    <div className="ov-quality-row">
                      <span>{ASSET_CLASS_LABELS[a.assetClass]}</span>
                      <span className="fig">{formatMoney(a.value)}</span>
                    </div>
                    <div className="bud-bar" style={{ marginTop: 6 }}>
                      <span className="bud-bar-spent" style={{ width: `${a.share * 100}%` }} />
                    </div>
                    <div className="ov-muted ov-quality-note">{formatPct(a.share)} of portfolio</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ marginTop: 34, paddingBottom: 40 }}>
            <div className="ov-kicker" style={{ marginBottom: 10 }}>
              Holdings
            </div>
            <div className="wl-holdwrap">
              <table className="wl-holdtable">
                <thead>
                  <tr>
                    <th>Holding</th>
                    <th>Owner</th>
                    <th>Ccy</th>
                    <th>Units</th>
                    <th>Avg price</th>
                    <th>Price now</th>
                    <th>Invested</th>
                    <th>Value</th>
                    <th>P&amp;L</th>
                    <th>Today</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((h) => {
                    const gain = holdingGain(h, scopeMemberId);
                    const invested = scopedInvestedValue(h, scopeMemberId);
                    return (
                      <tr key={h.id} className="wl-holdrow" onClick={() => setEditing(h)}>
                        <td>
                          <div>{h.name}</div>
                          <div className="ov-muted">
                            {ASSET_CLASS_LABELS[h.asset_class]} ·{' '}
                            {h.is_shared ? 'Shared' : (members.find((m) => m.id === h.owner_member_id)?.display_name ?? 'Unassigned')}
                          </div>
                        </td>
                        <td>{h.is_shared ? 'Shared' : (members.find((m) => m.id === h.owner_member_id)?.display_name ?? '—')}</td>
                        <td>{h.currency}</td>
                        <td>{h.quantity != null ? Number(h.quantity).toLocaleString('en-AE') : '—'}</td>
                        <td>{h.avg_price != null ? formatMoney(h.avg_price, { decimals: 2 }) : '—'}</td>
                        <td>{h.current_price != null ? formatMoney(h.current_price, { decimals: 2 }) : '—'}</td>
                        <td>{invested !== null ? formatMoney(invested) : '—'}</td>
                        <td className="fig">{formatMoney(scopedHoldingValue(h, scopeMemberId))}</td>
                        <td className={gain ? (gain.absolute >= 0 ? 'ov-pos' : 'ov-neg') : ''}>
                          {gain ? `${formatSigned(gain.absolute)} (${formatPct(gain.pct)})` : '—'}
                        </td>
                        <td className={h.day_change_pct != null ? (h.day_change_pct >= 0 ? 'ov-pos' : 'ov-neg') : ''}>
                          {h.day_change_pct != null ? `${h.day_change_pct >= 0 ? '+' : ''}${h.day_change_pct.toFixed(2)}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {editing && (
        <HoldingEditor
          holding={editing === 'new' ? null : editing}
          householdId={household?.id}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}
