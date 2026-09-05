import { useMemo, useState } from 'react';
import { useScope } from '../../lib/ScopeContext';
import { resolveScopeMemberId, scopedValue } from '../../lib/scope';
import { isArchived } from '../../lib/accounts';
import { balanceStatus, unconfirmedAccounts } from '../../lib/balance';
import { closeRowFor, historyState, pendingClose } from '../../lib/snapshots';
import { supabase } from '../../lib/supabaseClient';
import { formatPct } from '../../lib/money';
import { buildNetWorthSeries, changeOverMonths } from '../../lib/netWorth';
import { ASSET_CLASS_LABELS, scopedHoldingValue, visibleHoldings } from '../../lib/holdings';
import { useMoneyDisplay } from '../../lib/CurrencyContext';
import { isLiabilityAccount, isLiquidAccount } from '../useOverviewData';
import { netWorthSummary } from '../overviewMath';

export default function NetWorth({ household, me, members, data, loading }) {
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);
  const { accounts, netWorthSnapshots, holdings, reload } = data;
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);
  // The values a close would write, shown for review before anything is
  // written. Null means "not confirming right now" (SHR-246): today's live
  // totals must not become a closed month's history without someone actually
  // looking at the number first.
  const [closeDraft, setCloseDraft] = useState(null);

  const now = useMemo(() => new Date(), []);
  const [selectedIdx, setSelectedIdx] = useState(null);

  // Closed accounts leave today's position but keep their transactions (QA-01).
  const visible = accounts.filter(
    (a) => !isArchived(a) && (scopeMemberId === null || a.is_shared || a.owner_member_id === scopeMemberId),
  );
  const assetRows = visible.filter((a) => !isLiabilityAccount(a));
  const liabilityRows = visible.filter((a) => isLiabilityAccount(a));
  const visibleHoldingRows = visibleHoldings(holdings, scopeMemberId);
  // Totals come from the shared basis rather than a parallel calculation, so
  // Wealth, Overview and Forecast cannot drift apart (QA-03).
  const unconfirmed = unconfirmedAccounts(visible);
  const summary = useMemo(() => netWorthSummary(accounts, scopeMemberId, holdings), [accounts, scopeMemberId, holdings]);
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
  const maxNet = Math.max(1, ...series.map((p) => Math.max(p.net, 0)));
  const pending = pendingClose(netWorthSnapshots, now);

  // Closing is a two-step, explicit act (SHR-246): the button only opens a
  // review of what would be written — today's live totals, offered as a
  // starting point, not a fact yet. Nothing is written until "Confirm &
  // close" is pressed on those (possibly edited) numbers.
  function reviewClose() {
    if (!pending) return;
    const household_wide = netWorthSummary(accounts, null, holdings);
    setCloseDraft({ assets: household_wide.assets, liabilities: household_wide.liabilities });
  }

  // Upserting on (household_id, snapshot_date) with ignoreDuplicates means
  // closing the same month twice from the same session changes nothing — but
  // it also means a second, stale session cannot silently overwrite a month
  // another session already closed with different numbers. Whoever closes it
  // first wins; a later attempt is a no-op, not a clobber.
  async function confirmClose() {
    if (!pending || !household?.id || !closeDraft) return;
    setClosing(true);
    setCloseError(null);
    const { error } = await supabase
      .from('net_worth_snapshots')
      .upsert(closeRowFor(household.id, pending.snapshotDate, closeDraft), {
        onConflict: 'household_id,snapshot_date',
        ignoreDuplicates: true,
      });
    setClosing(false);
    setCloseDraft(null);
    if (error) {
      setCloseError(error.message);
      return;
    }
    await reload();
  }
  const selected = selectedIdx !== null ? series[selectedIdx] : series[series.length - 1];

  if (loading) return <div className="ov-skel" aria-busy="true" />;

  return (
    <div>
      <section className="wl-hero">
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
      </section>

      <section className="wl-breakdown">
        <div className="ov-kicker" style={{ marginBottom: 10 }}>
          Assets
        </div>
        <AccountList rows={assetRows} scopeMemberId={scopeMemberId} members={members} money={money} />
        {visibleHoldingRows.length > 0 && (
          <>
            <div className="ov-kicker" style={{ marginBottom: 10, marginTop: 26 }}>
              Investments
            </div>
            <HoldingList rows={visibleHoldingRows} scopeMemberId={scopeMemberId} members={members} money={money} />
          </>
        )}
        <div className="ov-kicker" style={{ marginBottom: 10, marginTop: 26 }}>
          Liabilities
        </div>
        {liabilityRows.length === 0 ? (
          <div className="ov-muted">None.</div>
        ) : (
          <AccountList rows={liabilityRows} scopeMemberId={scopeMemberId} members={members} money={money} negative />
        )}
      </section>

      <section className="wl-history">
        <div className="wl-history-head">
          <div className="ov-kicker">How it's grown</div>
          {historyAvailable && pending && !closeDraft && (
            <button type="button" className="om-btn" disabled={closing} onClick={reviewClose}>
              {`Close ${pending.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`}
            </button>
          )}
        </div>
        {historyAvailable && !pending && netWorthSnapshots.length > 0 && (
          <div className="ov-muted" style={{ marginBottom: 12 }}>
            Every completed month is closed. Closing again would change nothing.
          </div>
        )}
        {historyAvailable && pending && closeDraft && (
          <div className="ov-card" style={{ marginBottom: 16, padding: 14 }}>
            <div className="ov-muted" style={{ marginBottom: 10 }}>
              Confirm what {pending.month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} actually closed at.
              These start from today's live totals — edit them if they don't reflect that month's actual position.
            </div>
            <div className="te-fieldgrid">
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Assets</span>
                <input
                  className="te-fieldvalue"
                  type="number"
                  step="0.01"
                  value={closeDraft.assets}
                  onChange={(e) => setCloseDraft((d) => ({ ...d, assets: Number(e.target.value) || 0 }))}
                />
              </div>
              <div className="te-fieldcell">
                <span className="te-fieldlabel">Liabilities</span>
                <input
                  className="te-fieldvalue"
                  type="number"
                  step="0.01"
                  value={closeDraft.liabilities}
                  onChange={(e) => setCloseDraft((d) => ({ ...d, liabilities: Number(e.target.value) || 0 }))}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="om-btn" disabled={closing} onClick={() => setCloseDraft(null)}>
                Cancel
              </button>
              <button type="button" className="om-btn ov-btn-primary" disabled={closing} onClick={confirmClose}>
                {closing ? 'Closing…' : 'Confirm & close'}
              </button>
            </div>
          </div>
        )}
        {closeError && (
          <div className="ov-error" role="alert" style={{ marginBottom: 12 }}>
            Couldn’t close the month: {closeError}
          </div>
        )}
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
            <div className="ov-chart" style={{ gap: series.length > 8 ? 4 : 12 }}>
              {series.map((p, i) => (
                <button
                  key={p.label + i}
                  type="button"
                  className="ov-col"
                  data-active={(selectedIdx ?? series.length - 1) === i}
                  onClick={() => setSelectedIdx(i)}
                  aria-label={`${p.label}: net worth ${money.fmtBalance(p.net)}`}
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
          </>
        )}
      </section>
    </div>
  );
}

function HoldingList({ rows, scopeMemberId, members, money }) {
  if (rows.length === 0) return <div className="ov-muted">None yet.</div>;
  return (
    <div className="mn-list">
      {rows.map((h) => (
        <div key={h.id} className="mn-row" style={{ cursor: 'default' }}>
          <div className="mn-row-main">
            <div>{h.name}</div>
            <div className="ov-muted">
              {h.is_shared ? 'Joint' : (members.find((m) => m.id === h.owner_member_id)?.display_name ?? 'Unassigned')}
              {' · '}
              {ASSET_CLASS_LABELS[h.asset_class] ?? h.asset_class}
            </div>
          </div>
          <div className="fig mn-row-amt">{money.fmt(scopedHoldingValue(h, scopeMemberId))}</div>
        </div>
      ))}
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
              {isLiquidAccount(a) ? '' : ` · ${a.type}`}
            </div>
          </div>
          <div className={`fig mn-row-amt ${negative ? 'ov-neg' : ''}`}>
            {negative ? '−' : ''}
            {balanceStatus(a) === 'unset' ? (
              <span className="ov-muted">Not set</span>
            ) : (
              money.fmtBalance(scopedValue(a.balance, a, scopeMemberId))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
