import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId } from '../../lib/scope';
import { formatMoney, formatPct } from '../../lib/money';
import {
  ASSET_CLASS_LABELS,
  GROUP_ORDER,
  RANGES,
  allocationByClass,
  groupOf,
  holdingGain,
  portfolioDayChange,
  portfolioGain,
  portfolioInvestedAndGain,
  portfolioSeries,
  scopedHoldingValue,
  scopedInvestedValue,
  visibleHoldings,
} from '../../lib/holdings';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { isStale } from '../../lib/valuation';
import { supabase } from '../../lib/supabaseClient';
import HoldingEditor from './HoldingEditor';

export default function Investments({ household, members, me, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);
  const { holdings, holdingHistory, reload } = data;

  const [group, setGroup] = useState('All');
  const [range, setRange] = useState('3M');
  const [editing, setEditing] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(null);

  const now = useMemo(() => new Date(), []);
  const rows = useMemo(() => visibleHoldings(holdings, scopeMemberId, group), [holdings, scopeMemberId, group]);
  const groupsPresent = ['All', ...GROUP_ORDER.filter((g) => g !== 'All' && holdings.some((h) => groupOf(h.asset_class) === g))];

  const totalValue = rows.reduce((s, h) => s + scopedHoldingValue(h, scopeMemberId), 0);
  const gain = useMemo(() => portfolioGain(rows, holdingHistory, range, scopeMemberId, now), [rows, holdingHistory, range, scopeMemberId, now]);
  const series = useMemo(() => portfolioSeries(rows, holdingHistory, scopeMemberId, now), [rows, holdingHistory, scopeMemberId, now]);
  const rangedSeries = useMemo(() => {
    const cutoff = rangeStart(range, now);
    const filtered = series.filter((p) => p.date >= cutoff || p.isLive);
    return filtered.length >= 2 ? filtered : series;
  }, [series, range, now]);

  const allocation = useMemo(() => allocationByClass(rows, scopeMemberId), [rows, scopeMemberId]);
  const dayChange = useMemo(() => portfolioDayChange(rows, scopeMemberId), [rows, scopeMemberId]);
  const investedGain = useMemo(() => portfolioInvestedAndGain(rows, scopeMemberId), [rows, scopeMemberId]);

  // The oldest valuation is the honest headline: a portfolio is only as fresh
  // as its stalest holding. Previously this showed the newest, which a single
  // recent edit could make look current (QA-04).
  const oldestPricedAt = holdings.reduce((oldest, h) => {
    if (!h.priced_at) return oldest;
    const d = new Date(h.priced_at);
    return !oldest || d < oldest ? d : oldest;
  }, null);
  const lastRefreshed = holdings.reduce((latest, h) => {
    if (!h.last_refreshed) return latest;
    const d = new Date(h.last_refreshed);
    return !latest || d > latest ? d : latest;
  }, null);
  const autoPriced = holdings.filter((h) => h.price_provider);
  const failing = autoPriced.filter((h) => h.price_fetch_error);
  const neverPriced = holdings.filter((h) => !h.priced_at).length;
  const staleCount = holdings.filter((h) => isStale(h, now)).length;

  // Reload re-reads what is stored. It does not reprice anything, and it must
  // never advance a valuation date — pressing it used to dismiss the staleness
  // warning without retrieving a single price.
  async function handleReload() {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }

  // Refresh live prices actually calls the price-refresh feed (SHR-237) for
  // whatever holdings have opted into a provider (price_provider set) --
  // distinct from Reload, which never fetches anything and never advances a
  // valuation date on its own.
  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError('');
    const { data, error } = await supabase.functions.invoke('price-refresh');
    setRefreshing(false);
    if (error) {
      setRefreshError(error.message ?? 'Refresh failed.');
      return;
    }
    if (data?.fx?.ok === false) {
      setRefreshError(`FX rate refresh failed: ${data.fx.error}`);
    }
    await reload();
  }

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  const selected = selectedIdx !== null ? rangedSeries[selectedIdx] : rangedSeries[rangedSeries.length - 1];

  return (
    <div>
      <div className="mn-filters">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {groupsPresent.map((g) => (
            <button key={g} type="button" className="om-seg" data-active={group === g} onClick={() => setGroup(g)}>
              {g}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="ov-muted" style={{ fontSize: 11.5, textAlign: 'right', lineHeight: 1.4 }}>
            Prices {lastRefreshed ? lastRefreshed.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never refreshed'}
          </span>
          <button type="button" className="om-btn" onClick={handleReload} disabled={refreshing}>
            {refreshing ? '…' : 'Reload'}
          </button>
          <button type="button" className="om-btn" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
          <button type="button" className="om-btn mn-add" onClick={() => setEditing('new')}>
            + Holding
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="ov-empty">
          <div className="ov-empty-kicker">No holdings</div>
          <div className="ov-empty-body">Add your first holding to start tracking performance.</div>
        </div>
      ) : (
        <>
          {(refreshError || failing.length > 0) && (
            <div style={{ marginTop: 14 }}>
              {refreshError && (
                <div className="ov-warn" style={{ fontSize: 12.5 }}>
                  {refreshError}
                </div>
              )}
              {failing.length > 0 && (
                <div className="ov-warn" style={{ fontSize: 12.5, marginTop: 4 }}>
                  {failing.length} holding{failing.length === 1 ? '' : 's'} failed to refresh and may be stale: {failing.map((h) => h.name).join(', ')}.
                </div>
              )}
            </div>
          )}

          <section style={{ display: 'flex', gap: 44, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 26 }}>
            <div style={{ minWidth: 260 }}>
              <div className="ov-kicker">Value{group !== 'All' ? ` · ${group}` : ''}</div>
              <div className="ov-hero fig">
                <span className="ov-hero-currency">{money.code}</span> {money.fmt(totalValue)}
              </div>
              {gain.available ? (
                <div className="ov-nwchange">
                  <span className={gain.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                    {gain.absolute >= 0 ? '▲' : '▼'} {money.fmtSigned(gain.absolute)}
                    {gain.pct !== null ? ` (${formatPct(gain.pct)})` : ''}
                  </span>
                  <span className="ov-muted"> {range}</span>
                </div>
              ) : (
                <div className="ov-nwchange ov-muted">
                  {/* Holding history accumulates from confirmed valuations, not
                      from time passing (QA-05). */}
                  {holdingHistory.length === 0
                    ? 'No valuation history yet. Refreshing prices records a dated point.'
                    : `Not enough history yet for ${range}.`}
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 320 }}>
              <div className="ov-seg-row" style={{ justifyContent: 'flex-end' }}>
                {RANGES.map((r) => (
                  <button key={r} type="button" className="om-seg" data-active={range === r} onClick={() => setRange(r)}>
                    {r}
                  </button>
                ))}
              </div>
              <PortfolioTrendChart series={rangedSeries} money={money} selectedIdx={selectedIdx} onSelect={setSelectedIdx} />
              {selected && (
                <div className="ov-chart-readout">
                  <span className="fig">{selected.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                  <span>
                    Value <b className="fig">{money.fmt(selected.total)}</b>
                  </span>
                  {selected.isLive && <span className="ov-muted">live</span>}
                </div>
              )}
            </div>
          </section>

          <section style={{ marginTop: 34 }}>
            <div className="ov-kicker" style={{ marginBottom: 10 }}>
              Allocation
            </div>
            <div className="wl-alloc-grid">
              {allocation.map((a) => (
                <div key={a.assetClass} className="wl-alloc-box">
                  <div className="wl-alloc-head">
                    <span>{ASSET_CLASS_LABELS[a.assetClass]}</span>
                    <span className="ov-muted">{formatPct(a.share)}</span>
                  </div>
                  <div className="fig wl-alloc-value">{money.fmt(a.value)}</div>
                  <div className="bud-bar" style={{ marginTop: 9 }}>
                    <span className="bud-bar-spent" style={{ width: `${a.share * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="wl-invstats">
            <div>
              <div className="ov-muted" style={{ fontSize: 11 }}>
                Invested
              </div>
              <div className="fig" style={{ fontSize: 19, marginTop: 5 }}>
                {investedGain.available ? money.fmt(investedGain.invested) : '—'}
              </div>
            </div>
            <div>
              <div className="ov-muted" style={{ fontSize: 11 }}>
                Profit and loss to date
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 5 }}>
                <span className={`fig ${investedGain.available ? (investedGain.absolute >= 0 ? 'ov-pos' : 'ov-neg') : ''}`} style={{ fontSize: 19 }}>
                  {investedGain.available ? money.fmtSigned(investedGain.absolute) : '—'}
                </span>
                {investedGain.available && investedGain.pct !== null && (
                  <span className={investedGain.absolute >= 0 ? 'ov-pos' : 'ov-neg'} style={{ fontSize: 12 }}>
                    {investedGain.absolute >= 0 ? '+' : ''}
                    {formatPct(investedGain.pct)}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="ov-muted" style={{ fontSize: 11 }}>
                Change today
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 5 }}>
                <span className={`fig ${dayChange.available ? (dayChange.absolute >= 0 ? 'ov-pos' : 'ov-neg') : ''}`} style={{ fontSize: 19 }}>
                  {dayChange.available ? money.fmtSigned(dayChange.absolute) : '—'}
                </span>
                {dayChange.available && dayChange.pct !== null && (
                  <span className={dayChange.absolute >= 0 ? 'ov-pos' : 'ov-neg'} style={{ fontSize: 12 }}>
                    {dayChange.absolute >= 0 ? '+' : ''}
                    {formatPct(dayChange.pct)}
                  </span>
                )}
              </div>
            </div>
          </section>

          <section style={{ marginTop: 8 }}>
            <div className="ov-muted" style={{ fontSize: 11.5 }}>
              {neverPriced > 0 && holdings.length === neverPriced
                ? 'No holding has a confirmed valuation yet.'
                : oldestPricedAt
                  ? `Oldest valuation ${oldestPricedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` +
                    (neverPriced > 0 ? ` · ${neverPriced} never valued` : '') +
                    (staleCount > 0 ? ` · ${staleCount} stale` : '')
                  : 'No holding has a confirmed valuation yet.'}
              {' · '}
              {autoPriced.length === 0
                ? 'No holding has auto-pricing set up yet — edit one to opt it in.'
                : `${autoPriced.length} holding${autoPriced.length === 1 ? '' : 's'} on a live feed`}
              {' · Reload re-reads stored values and does not fetch prices; Refresh prices calls the live feed.'}
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
                    <th>Invested ({money.code})</th>
                    <th>Value ({money.code})</th>
                    <th>P&amp;L</th>
                    <th>Today</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((h) => {
                    const gain = holdingGain(h, scopeMemberId);
                    const invested = scopedInvestedValue(h, scopeMemberId);
                    const value = scopedHoldingValue(h, scopeMemberId);
                    const pctOfTotal = totalValue > 0 ? value / totalValue : null;
                    return (
                      <tr key={h.id} className="wl-holdrow" onClick={() => setEditing(h)}>
                        <td>
                          <div>{h.name}</div>
                          <div className="ov-muted">{ASSET_CLASS_LABELS[h.asset_class]}</div>
                        </td>
                        <td>{h.is_shared ? 'Shared' : (members.find((m) => m.id === h.owner_member_id)?.display_name ?? '—')}</td>
                        <td>{h.currency}</td>
                        <td>{h.quantity != null ? Number(h.quantity).toLocaleString('en-AE') : '—'}</td>
                        <td>{h.avg_price != null ? formatMoney(h.avg_price, { decimals: 2 }) : '—'}</td>
                        <td>{h.current_price != null ? formatMoney(h.current_price, { decimals: 2 }) : '—'}</td>
                        <td>{invested !== null ? money.fmt(invested) : '—'}</td>
                        <td>
                          <div className="fig">{money.fmt(value)}</div>
                          {pctOfTotal !== null && (
                            <div className="ov-muted" style={{ fontSize: 11 }}>
                              {formatPct(pctOfTotal)} of total
                            </div>
                          )}
                        </td>
                        <td className={gain ? (gain.absolute >= 0 ? 'ov-pos' : 'ov-neg') : ''}>
                          {gain ? `${money.fmtSigned(gain.absolute)} (${formatPct(gain.pct)})` : '—'}
                        </td>
                        <td
                          className={h.price_fetch_error ? 'ov-warn' : h.day_change_pct != null ? (h.day_change_pct >= 0 ? 'ov-pos' : 'ov-neg') : ''}
                          title={h.price_fetch_error ? `Refresh failed: ${h.price_fetch_error}` : undefined}
                        >
                          {h.price_fetch_error
                            ? 'stale'
                            : h.day_change_pct != null
                              ? `${h.day_change_pct >= 0 ? '+' : ''}${h.day_change_pct.toFixed(2)}%`
                              : '—'}
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

const RANGE_DAYS = { '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825 };
function rangeStart(range, now) {
  if (range === 'YTD') return new Date(now.getFullYear(), 0, 1);
  const days = RANGE_DAYS[range] ?? 90;
  return new Date(now.getTime() - days * 86400000);
}

// A real line + filled area over the portfolio's actual daily value history
// (one point per day the nightly price-refresh ran, plus today's live
// total) -- not a bar per data point standing in for a trend.
function PortfolioTrendChart({ series, selectedIdx, onSelect }) {
  if (series.length < 2) {
    return <div className="ov-muted" style={{ marginTop: 20, fontSize: 12.5 }}>Not enough daily history yet to draw a trend.</div>;
  }
  const W = 600;
  const H = 172;
  const values = series.map((p) => p.total);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.15 || max * 0.05 || 1;
  const lo = Math.max(0, min - pad);
  const hi = max + pad;
  const x = (i) => (series.length === 1 ? W / 2 : (i / (series.length - 1)) * W);
  const y = (v) => H - ((v - lo) / (hi - lo || 1)) * H;

  const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.total).toFixed(1)}`);
  const areaPath = `M${x(0).toFixed(1)},${H} L${points.join(' L')} L${x(series.length - 1).toFixed(1)},${H} Z`;

  return (
    <div className="wl-invchart" onMouseLeave={() => onSelect(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="wl-invchart-svg">
        <path d={areaPath} fill="var(--accent)" opacity="0.14" />
        <polyline points={points.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="wl-invchart-cols">
        {series.map((p, i) => (
          <div key={i} className="wl-invchart-col" onMouseEnter={() => onSelect(i)} onClick={() => onSelect(i)} />
        ))}
      </div>
      {(selectedIdx !== null ? selectedIdx : series.length - 1) !== null && (
        <div
          className="wl-invchart-dot"
          style={{
            left: `${(x(selectedIdx !== null ? selectedIdx : series.length - 1) / W) * 100}%`,
            top: `${(y(series[selectedIdx !== null ? selectedIdx : series.length - 1].total) / H) * 100}%`,
          }}
        />
      )}
    </div>
  );
}
