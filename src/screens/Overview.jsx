import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHousehold } from '../lib/useHousehold';
import { useScope } from '../lib/ScopeContext';
import { resolveScopeMemberId } from '../lib/scope';
import { formatMoney, formatSigned, formatPct } from '../lib/money';
import { PERIOD_LABELS } from '../lib/period';
import { upcomingItems } from '../lib/recurring';
import { buildNetWorthSeries, changeOverMonths } from '../lib/netWorth';
import { supabase } from '../lib/supabaseClient';
import { useOverviewData } from './useOverviewData';
import {
  netWorthSummary,
  visibleAccounts,
  periodSummary,
  buildChartColumns,
  spendComposition,
  runwaySummary,
  dataQuality,
} from './overviewMath';
import './Overview.css';

const PERIODS = ['mtd', 'qtd', 'ytd'];

export default function Overview() {
  const navigate = useNavigate();
  const { household, members, me, loading: householdLoading } = useHousehold();
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);

  const {
    loading: dataLoading,
    accounts,
    transactions,
    categories,
    recurring,
    netWorthSnapshots,
    error,
    reload,
  } = useOverviewData(household?.id);

  const [period, setPeriod] = useState('mtd');
  const [selectedKey, setSelectedKey] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const now = useMemo(() => new Date(), []);
  const loading = householdLoading || dataLoading;
  const isEmpty = !loading && accounts.length === 0 && transactions.length === 0;

  const nw = useMemo(() => netWorthSummary(accounts, scopeMemberId), [accounts, scopeMemberId]);
  const nwSeries = useMemo(
    () => buildNetWorthSeries(netWorthSnapshots, nw.assets, nw.liabilities, now),
    [netWorthSnapshots, nw.assets, nw.liabilities, now]
  );
  const nwChange1mo = changeOverMonths(nwSeries, 1);
  const nwChange12mo = changeOverMonths(nwSeries, 12);
  const p = useMemo(() => periodSummary(transactions, period, scopeMemberId, now), [transactions, period, scopeMemberId, now]);
  const columns = useMemo(
    () => buildChartColumns(transactions, period, scopeMemberId, now),
    [transactions, period, scopeMemberId, now]
  );
  const selected = columns.find((c) => c.key === selectedKey) ?? columns[columns.length - 1];
  const maxColValue = Math.max(1, ...columns.map((c) => Math.max(c.income, c.spend)));

  const composition = useMemo(() => {
    const { start, end } = p;
    const periodTx = transactions.filter((t) => {
      const d = new Date(t.occurred_at);
      return d >= start && d < new Date(end.getTime() + 86400000);
    });
    return spendComposition(periodTx, scopeMemberId);
  }, [transactions, p, scopeMemberId]);

  const runway = useMemo(() => runwaySummary(transactions, accounts, scopeMemberId, now), [transactions, accounts, scopeMemberId, now]);
  const next30 = useMemo(() => {
    const visible = recurring.filter((r) => scopeMemberId === null || r.is_shared || r.owner_member_id === scopeMemberId);
    return upcomingItems(visible, 30, now);
  }, [recurring, scopeMemberId, now]);
  const committed = next30.filter((r) => Number(r.amount) < 0);
  const committedTotal = committed.reduce((sum, r) => sum + -Number(r.amount), 0);
  const withoutAutopay = committed.filter((r) => !r.autopay).length;
  const quality = useMemo(() => dataQuality(accounts, transactions, now), [accounts, transactions, now]);

  const attention = transactions.filter((t) => t.needs_review && (scopeMemberId === null || t.is_shared || t.owner_member_id === scopeMemberId));
  const recent = visibleRows(transactions, scopeMemberId).slice(0, 8);
  const accountRows = visibleAccounts(accounts, scopeMemberId);

  const lede = isEmpty
    ? 'Nothing recorded yet'
    : attention.length > 0
      ? `${attention.length} thing${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} a decision`
      : p.rate !== null
        ? `On pace to save ${formatPct(p.rate)} this ${period === 'mtd' ? 'month' : period === 'qtd' ? 'quarter' : 'year'}`
        : 'All caught up';

  function showToast(message, undo) {
    setToast({ message, undo });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }

  async function markReviewed(tx) {
    const prev = { needs_review: tx.needs_review };
    await supabase.from('transactions').update({ needs_review: false }).eq('id', tx.id);
    await reload();
    showToast(`Marked "${tx.merchant ?? 'transaction'}" reviewed`, async () => {
      await supabase.from('transactions').update(prev).eq('id', tx.id);
      await reload();
    });
  }

  async function categorise(tx, categoryId) {
    const prev = { needs_review: tx.needs_review, category_id: tx.category_id };
    await supabase.from('transactions').update({ category_id: categoryId, needs_review: false }).eq('id', tx.id);
    await reload();
    showToast(`Categorised "${tx.merchant ?? 'transaction'}"`, async () => {
      await supabase.from('transactions').update(prev).eq('id', tx.id);
      await reload();
    });
  }

  if (loading) {
    return <div className="ov-skel" aria-busy="true" />;
  }

  return (
    <div className="ov">
      {error && (
        <div className="ov-error" role="alert">
          <span>Couldn't load your data. The figures below may be incomplete or stale.</span>
          <button type="button" className="om-btn" onClick={reload}>
            Retry
          </button>
        </div>
      )}
      <div className="ov-head">
        <div>
          <div className="ov-kicker">
            {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <h1 className="ov-lede fig">{lede}</h1>
        </div>
        <div className="ov-seg-row" role="group" aria-label="Period">
          {PERIODS.map((k) => (
            <button key={k} type="button" className="om-seg" data-active={period === k} onClick={() => setPeriod(k)}>
              {k.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {isEmpty ? (
        <EmptyState navigate={navigate} />
      ) : (
        <>
          <section className="ov-hero-section">
            <div className="ov-kicker">Net worth{scope !== 'both' ? ` · ${scopeLabel(scope, me, members)}` : ''}</div>
            <div className="ov-hero fig">
              <span className="ov-hero-currency">AED</span> {formatMoney(nw.netWorth)}
            </div>
            {scope === 'both' && (nwChange1mo || nwChange12mo) && (
              <div className="ov-nwchange">
                {nwChange1mo && (
                  <span className={nwChange1mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                    {nwChange1mo.absolute >= 0 ? '▲' : '▼'} {formatSigned(nwChange1mo.absolute)}
                  </span>
                )}
                {nwChange1mo && <span className="ov-muted"> this month</span>}
                {nwChange1mo && nwChange12mo && <span className="ov-muted"> · </span>}
                {nwChange12mo && (
                  <span className="ov-muted">
                    12-mo{' '}
                    <span className={nwChange12mo.absolute >= 0 ? 'ov-pos' : 'ov-neg'}>
                      {nwChange12mo.pct !== null ? formatPct(nwChange12mo.pct) : formatSigned(nwChange12mo.absolute)}
                    </span>
                  </span>
                )}
              </div>
            )}
            <div className="ov-strip">
              <span>
                Assets <b>{formatMoney(nw.assets)}</b>
              </span>
              <span>
                Liabilities <b>{formatMoney(nw.liabilities)}</b>
              </span>
              {runway.available ? (
                <span>
                  Runway <b>{runway.months.toFixed(1)} months</b>
                </span>
              ) : (
                <span className="ov-muted">Runway needs {2 - runway.monthsOfHistory} more closed month(s) of spending</span>
              )}
              <span className="ov-link" onClick={() => navigate('/wealth')}>
                History →
              </span>
            </div>
          </section>

          <section className="ov-period-section">
            <div className="ov-section-head">
              <div className="ov-kicker">{PERIOD_LABELS[period]}</div>
              <div className="ov-muted">{p.count} record{p.count === 1 ? '' : 's'}</div>
            </div>
            <div className="ov-kpi-row">
              <div>
                <div className="ov-kpi-label">Income</div>
                <div className="ov-kpi-fig fig">{formatMoney(p.income)}</div>
              </div>
              <div>
                <div className="ov-kpi-label">Spend</div>
                <div className="ov-kpi-fig fig">{formatMoney(p.spend)}</div>
              </div>
              <div>
                <div className="ov-kpi-label">Saved</div>
                <div className="ov-kpi-fig fig">{formatSigned(p.saved)}</div>
              </div>
              <div>
                <div className="ov-kpi-label">Savings rate</div>
                <div className="ov-kpi-fig fig ov-pos">{p.rate !== null ? formatPct(p.rate) : '—'}</div>
              </div>
            </div>
          </section>

          <section className="ov-split">
            <div>
              <div className="ov-section-head">
                <div className="ov-kicker">Cash flow</div>
              </div>
              <div className="ov-chart">
                {columns.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className="ov-col"
                    data-active={selected?.key === c.key}
                    onClick={() => setSelectedKey(c.key)}
                    aria-label={`${c.label}: income ${formatMoney(c.income)}, spend ${formatMoney(c.spend)}`}
                  >
                    <div className="ov-col-bars">
                      <span className="ov-bar-inc" style={{ height: `${(c.income / maxColValue) * 100}%` }} />
                      <span className="ov-bar-out" style={{ height: `${(c.spend / maxColValue) * 100}%` }} />
                    </div>
                    <div className="ov-col-label">{c.label}</div>
                  </button>
                ))}
              </div>
              {selected && (
                <div className="ov-chart-readout">
                  <span className="fig">{selected.label}</span>
                  <span>
                    Income <b className="fig">{formatMoney(selected.income)}</b>
                  </span>
                  <span>
                    Spend <b className="fig">{formatMoney(selected.spend)}</b>
                  </span>
                  <span>
                    Rate <b className="fig ov-pos">{selected.income > 0 ? formatPct(selected.rate) : '—'}</b>
                  </span>
                </div>
              )}
              <div className="ov-legend">
                <span><i className="ov-dot-inc" />Income</span>
                <span><i className="ov-dot-out" />Spend</span>
              </div>
            </div>

            <div>
              <div className="ov-section-head">
                <div className="ov-kicker">Needs attention</div>
                <div className="ov-muted">{attention.length ? `${attention.length} open` : 'All clear'}</div>
              </div>
              {attention.length === 0 ? (
                <div className="ov-allclear">
                  <span className="ov-dot-pos" />
                  <span>All clear — nothing needs a decision.</span>
                </div>
              ) : (
                <div className="ov-attn-list">
                  {attention.map((t) => (
                    <div key={t.id} className="ov-attn-row">
                      <div className="ov-attn-main">
                        <span>{t.merchant ?? 'Transaction'}</span>
                        <span className="ov-muted">
                          {new Date(t.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ·{' '}
                          {formatMoney(t.amount)}
                        </span>
                      </div>
                      <select
                        className="ov-attn-select"
                        defaultValue=""
                        onChange={(e) => e.target.value && categorise(t, e.target.value)}
                      >
                        <option value="" disabled>
                          Categorise…
                        </option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="om-btn ov-attn-btn" onClick={() => markReviewed(t)}>
                        Mark reviewed
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="ov-quality-section">
            <div className="ov-section-head">
              <div className="ov-kicker">Data quality</div>
              <div className="ov-muted">What every figure on this page rests on</div>
            </div>
            <div className="ov-quality-grid">
              <QualityItem
                name="Transactions"
                ok={quality.daysSinceLastTx !== null && quality.daysSinceLastTx <= 3}
                label={quality.daysSinceLastTx === null ? 'None yet' : quality.daysSinceLastTx === 0 ? 'Today' : `${quality.daysSinceLastTx}d ago`}
                note={quality.lastTxDate ? `Most recent record ${quality.lastTxDate.toLocaleDateString('en-GB')}` : 'Nothing recorded yet.'}
              />
              <QualityItem
                name="Categorisation"
                ok={quality.categorisedPct !== null && quality.categorisedPct >= 0.9}
                label={quality.categorisedPct !== null ? formatPct(quality.categorisedPct) : '—'}
                note={`${quality.totalTx} record(s) total, ${quality.openReview} flagged for review.`}
              />
              <QualityItem
                name="Review queue"
                ok={quality.openReview === 0}
                label={quality.openReview === 0 ? 'Clear' : `${quality.openReview} open`}
                note="Flagged on add or import; resolved above."
              />
              <QualityItem
                name="Accounts"
                ok={accounts.length > 0}
                label={accounts.length ? `${accounts.length} tracked` : 'None yet'}
                note={quality.lastAccountUpdate ? `Balances entered manually, last touched ${quality.lastAccountUpdate.toLocaleDateString('en-GB')}.` : 'Add an account in Wealth.'}
              />
            </div>
          </section>

          <section className="ov-next30">
            <div className="ov-kicker">Next 30 days</div>
            {next30.length === 0 ? (
              <div className="ov-next30-empty">
                {recurring.length === 0
                  ? 'No recurring bills or income set up yet.'
                  : 'Nothing due in the next 30 days.'}{' '}
                <span className="ov-link" onClick={() => navigate('/money')}>
                  Recurring →
                </span>
              </div>
            ) : (
              <>
                <div className="ov-next30-row">
                  {next30.map((r) => (
                    <div key={r.id} className="ov-next30-cell">
                      <div className="ov-muted">{r.dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div>
                      <div className="ov-next30-name">{r.name}</div>
                      <div className={`fig ov-next30-amt ${Number(r.amount) > 0 ? 'ov-pos' : ''}`}>{formatSigned(r.amount)}</div>
                      <div className={Number(r.amount) < 0 && !r.autopay ? 'ov-warn' : 'ov-muted'}>
                        {Number(r.amount) > 0 ? 'expected' : r.autopay ? 'autopay' : 'no autopay'}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="ov-next30-foot">
                  <span>
                    Committed {formatMoney(committedTotal)}
                    {withoutAutopay > 0 ? ` · ${withoutAutopay} without autopay` : ''}
                  </span>
                  <span className="ov-link" onClick={() => navigate('/money')}>
                    Recurring →
                  </span>
                </div>
              </>
            )}
          </section>

          <section className="ov-triple">
            <div>
              <div className="ov-kicker">Spend composition · {PERIOD_LABELS[period]}</div>
              {composition.rows.length === 0 ? (
                <div className="ov-muted" style={{ marginTop: 12 }}>
                  No spend recorded this period.
                </div>
              ) : (
                <>
                  <div className="ov-comp-fig fig">{formatMoney(composition.total)}</div>
                  <div className="ov-comp-bar">
                    {composition.rows.map((r, i) => (
                      <span
                        key={r.name}
                        title={r.name}
                        style={{ width: `${r.share * 100}%`, opacity: 1 - i * 0.16 }}
                      />
                    ))}
                  </div>
                  <div className="ov-comp-list">
                    {composition.rows.map((r, i) => (
                      <div key={r.name} className="ov-comp-row">
                        <span className="ov-comp-dot" style={{ opacity: 1 - i * 0.16 }} />
                        <div className="ov-comp-name">{r.name}</div>
                        <div className="ov-comp-value">
                          <div className="fig">{formatMoney(r.value)}</div>
                          <div className="ov-muted">{formatPct(r.share)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div>
              <div className="ov-section-head">
                <div className="ov-kicker">Recent activity</div>
                <div className="ov-link" onClick={() => navigate('/money')}>
                  Activity →
                </div>
              </div>
              <div className="ov-list">
                {recent.length === 0 ? (
                  <div className="ov-muted" style={{ padding: '11px 0' }}>
                    Nothing yet.
                  </div>
                ) : (
                  recent.map((t) => (
                    <div key={t.id} className="ov-list-row">
                      <div className="ov-list-main">
                        <div>{t.merchant ?? 'Transaction'}</div>
                        <div className="ov-muted">
                          {new Date(t.occurred_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          {t.categories?.name ? ` · ${t.categories.name}` : ''}
                          {t.needs_review ? <span className="ov-warn"> · needs review</span> : null}
                        </div>
                      </div>
                      <div className={`fig ov-list-amt ${Number(t.amount) > 0 ? 'ov-pos' : ''}`}>
                        {formatSigned(t.amount)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <div className="ov-section-head">
                <div className="ov-kicker">Accounts</div>
                <div className="ov-link" onClick={() => navigate('/wealth')}>
                  Wealth →
                </div>
              </div>
              <div className="ov-list">
                {accountRows.length === 0 ? (
                  <div className="ov-muted" style={{ padding: '11px 0' }}>
                    No accounts yet.
                  </div>
                ) : (
                  accountRows.map((a) => (
                    <div key={a.id} className="ov-list-row">
                      <div className="ov-list-main">
                        <div>{a.name}</div>
                        <div className="ov-muted">{a.is_shared ? 'Joint' : ownerName(a.owner_member_id, members)}</div>
                      </div>
                      <div className={`fig ov-list-amt ${a.type === 'credit_card' || a.type === 'loan' ? 'ov-neg' : ''}`}>
                        {a.type === 'credit_card' || a.type === 'loan' ? '−' : ''}
                        {formatMoney(a.balance)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </>
      )}

      {toast && (
        <div className="ov-toast" role="status">
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => {
              toast.undo();
              setToast(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyState({ navigate }) {
  return (
    <div className="ov-empty">
      <div className="ov-empty-kicker">Day one</div>
      <div className="ov-empty-body">
        There are no figures to show, so none are shown. Net worth, savings rate and runway all need a first record;
        until one arrives they stay blank rather than reading as zero.
      </div>
      <div className="ov-empty-actions">
        <button type="button" className="om-btn ov-btn-primary" onClick={() => navigate('/money')}>
          Add a transaction
        </button>
        <button type="button" className="om-btn" onClick={() => navigate('/wealth')}>
          Add an account
        </button>
      </div>
      <div className="ov-empty-foot">Three records is enough for Activity and Accounts. A savings rate needs one closed month. Runway needs six.</div>
    </div>
  );
}

function QualityItem({ name, ok, label, note }) {
  return (
    <div className="ov-quality-item">
      <span className={ok ? 'ov-dot-pos' : 'ov-dot-warn'} />
      <div>
        <div className="ov-quality-row">
          <span>{name}</span>
          <span className={ok ? 'ov-chip-ok' : 'ov-chip-warn'}>{label}</span>
        </div>
        <div className="ov-muted ov-quality-note">{note}</div>
      </div>
    </div>
  );
}

function visibleRows(rows, scopeMemberId) {
  if (scopeMemberId === null) return rows;
  return rows.filter((r) => r.is_shared || r.owner_member_id === scopeMemberId);
}

function ownerName(ownerMemberId, members) {
  if (!ownerMemberId) return 'Shared';
  return members.find((m) => m.id === ownerMemberId)?.display_name ?? 'Member';
}

function scopeLabel(scope, me, members) {
  if (scope === 'me') return me?.display_name ?? 'Me';
  const partner = members.find((m) => m.id !== me?.id);
  return partner?.display_name ?? 'Partner';
}
