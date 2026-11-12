import { useMemo, useRef, useState } from 'react';
import { useNow } from '../lib/useNow';
import { useNavigate } from 'react-router-dom';
import { useHousehold } from '../lib/useHousehold';
import { useScope } from '../lib/ScopeContext';
import { resolveScopeMemberId } from '../lib/scope';
import { formatPct } from '../lib/money';
import { upcomingItems } from '../lib/recurring';
import { expectedIncome } from '../lib/expectedIncome';
import { buildNetWorthSeries, changeOverMonths } from '../lib/netWorth';
import { attentionPreview, buildAttentionItems } from '../lib/attention';
import { useMoneyDisplay } from '../lib/CurrencyContext';
import { supabase } from '../lib/supabaseClient';
import { useOverviewData } from './useOverviewData';
import { netWorthSummary, visibleAccounts, periodSummary, buildChartColumns, spendComposition, runwaySummary, dataQuality, previousPeriodSummary, PREVIOUS_PERIOD_LABELS, visibleRows } from './overviewMath';
import OverviewEmpty from './overview/OverviewEmpty';
import OverviewPeriod from './overview/OverviewPeriod';
import OverviewFlow from './overview/OverviewFlow';
import OverviewAttention from './overview/OverviewAttention';
import OverviewNext30 from './overview/OverviewNext30';
import OverviewNetWorth from './overview/OverviewNetWorth';
import OverviewQuality from './overview/OverviewQuality';
import OverviewSpending from './overview/OverviewSpending';
import OverviewRecent from './overview/OverviewRecent';
import OverviewAccounts from './overview/OverviewAccounts';
import { parseDay } from '../lib/day';
import { anyFailed, neverLoaded } from '../lib/loadState';
import { unconfirmedAccounts } from '../lib/balance';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import './Overview.css';

const PERIODS = ['mtd', 'qtd', 'ytd'];

export default function Overview() {
  const navigate = useNavigate();
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);

  const {
    loading: dataLoading,
    accounts,
    transactions,
    categories,
    recurring,
    netWorthSnapshots,
    holdings,
    backupRecords,
    yearlyChecks,
    errors,
    loaded,
    loadedAt,
    refreshing,
    reload,
  } = useOverviewData(household?.id);

  const [period, setPeriod] = useState('mtd');
  const [selectedKey, setSelectedKey] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const now = useNow(loadedAt);
  const loading = householdLoading || dataLoading;
  // A household with nothing recorded, not one whose records did not
  // arrive: a failed read is not "Day one" (outside review, E-03).
  const unread = neverLoaded({ errors, loaded }, ['accounts', 'transactions', 'holdings']);
  const isEmpty = !loading && unread.length === 0 && accounts.length === 0 && transactions.length === 0 && holdings.length === 0;

  const accountRows = useMemo(() => visibleAccounts(accounts, scopeMemberId), [accounts, scopeMemberId]);
  const nw = useMemo(() => netWorthSummary(accounts, scopeMemberId, holdings), [accounts, scopeMemberId, holdings]);
  // A total that silently omits a failed input is worse than no total. Net
  // worth is withheld outright when accounts or holdings didn't load (QA-10).
  const netWorthTrustworthy = !anyFailed(errors, ['accounts', 'holdings']);
  // Arithmetic over balances nobody has confirmed is provisional, and says so
  // rather than presenting itself as the household's position (QA-02).
  const unconfirmed = unconfirmedAccounts(accountRows);
  const netWorthIsProvisional = unconfirmed.length > 0;
  const nwSeries = useMemo(
    () => buildNetWorthSeries(netWorthSnapshots, nw.assets, nw.liabilities, now),
    [netWorthSnapshots, nw.assets, nw.liabilities, now]
  );
  const nwChange1mo = changeOverMonths(nwSeries, 1);
  const nwChange12mo = changeOverMonths(nwSeries, 12);
  const p = useMemo(() => periodSummary(transactions, period, scopeMemberId, now), [transactions, period, scopeMemberId, now]);
  const prev = useMemo(() => previousPeriodSummary(transactions, period, scopeMemberId, now), [transactions, period, scopeMemberId, now]);
  // Pay still to come this period, so Income reading 0 before payday says why.
  const expected = useMemo(
    () => expectedIncome(recurring, transactions, { kind: period, start: p.start, now, scopeMemberId }),
    [recurring, transactions, period, p.start, now, scopeMemberId]
  );
  const prevLabel = PREVIOUS_PERIOD_LABELS[period];
  const columns = useMemo(
    () => buildChartColumns(transactions, period, scopeMemberId, now),
    [transactions, period, scopeMemberId, now]
  );
  const selected = columns.find((c) => c.key === selectedKey) ?? columns[columns.length - 1];
  const maxColValue = Math.max(1, ...columns.map((c) => Math.max(c.income, c.spend)));

  const composition = useMemo(() => {
    const { start, end } = p;
    const periodTx = transactions.filter((t) => {
      const d = parseDay(t.occurred_at);
      return d >= start && d < new Date(end.getTime() + 86400000);
    });
    return spendComposition(periodTx, scopeMemberId, { categories });
  }, [transactions, p, scopeMemberId, categories]);

  const runway = useMemo(() => runwaySummary(transactions, accounts, scopeMemberId, now), [transactions, accounts, scopeMemberId, now]);
  const next30 = useMemo(() => {
    const visible = recurring.filter((r) => scopeMemberId === null || r.is_shared || r.owner_member_id === scopeMemberId);
    return upcomingItems(visible, 30, now);
  }, [recurring, scopeMemberId, now]);
  const committed = next30.filter((r) => Number(r.amount) < 0);
  const committedTotal = committed.reduce((sum, r) => sum + -Number(r.amount), 0);
  const withoutAutopay = committed.filter((r) => !r.autopay).length;
  const quality = useMemo(() => dataQuality(accounts, transactions, now), [accounts, transactions, now]);
  // The four checks below, counted for the one-line summary. The same
  // conditions colour each check's dot when the detail is open.
  const qualityOk = {
    transactions: quality.daysSinceLastTx !== null && quality.daysSinceLastTx <= 3,
    categorisation: quality.categorisedPct !== null && quality.categorisedPct >= 0.9,
    review: quality.openReview === 0,
    accounts: accounts.length > 0,
  };
  const qualityIssues = Object.values(qualityOk).filter((ok) => !ok).length;

  const attention = useMemo(
    () => buildAttentionItems({ transactions, recurring, accounts, holdings, categories, snapshots: netWorthSnapshots, backupRecords, yearlyChecks, scopeMemberId, now }),
    [transactions, recurring, accounts, holdings, categories, netWorthSnapshots, backupRecords, yearlyChecks, scopeMemberId, now]
  );
  // The most pressing few, with the rest a tap away: a long list pushed the
  // rest of the page out of sight.
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const { shown: attentionShown, hidden: attentionHidden } = attentionPreview(attention, attentionExpanded);
  // A glance, not a ledger: Activity is where records are looked into (SHR-328).
  const recent = visibleRows(transactions, scopeMemberId).slice(0, RECENT_COUNT);

  const lede = isEmpty
    ? 'Nothing recorded yet'
    : attention.length > 0
      ? `${attention.length} thing${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} a decision`
      : p.rate !== null
        ? `Saved ${formatPct(p.rate)} of income so far this ${period === 'mtd' ? 'month' : period === 'qtd' ? 'quarter' : 'year'}`
        : netWorthIsProvisional
          ? 'Set up is incomplete'
          : 'All caught up';

  function showToast(message, undo) {
    setToast({ message, undo });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }

  // A quick action worked only if it changed the one record: a failed
  // write, or a record deleted elsewhere, used to be told it had worked,
  // with an undo for a change never made (outside review, E-11).
  async function changeRecord(tx, change) {
    const { data, error } = await supabase.from('transactions').update(change).eq('id', tx.id).select('id');
    return !error && (data?.length ?? 0) === 1;
  }

  async function quickAction(tx, change, { done, failed }) {
    const name = `"${tx.merchant ?? 'transaction'}"`;
    const prev = Object.fromEntries(Object.keys(change).map((k) => [k, tx[k]]));
    const ok = await changeRecord(tx, change);
    await reload();
    if (!ok) {
      showToast(`Couldn't ${failed(name)}: it may have changed or been deleted elsewhere. Nothing was changed.`, null);
      return;
    }
    showToast(done(name), async () => {
      const undone = await changeRecord(tx, prev);
      await reload();
      if (!undone) showToast(`Couldn't undo that: ${name} may have changed elsewhere.`, null);
    });
  }

  function markReviewed(tx) {
    return quickAction(tx, { needs_review: false }, { done: (name) => `Marked ${name} reviewed`, failed: (name) => `mark ${name} reviewed` });
  }

  function categorise(tx, categoryId) {
    return quickAction(tx, { category_id: categoryId, needs_review: false }, { done: (name) => `Categorised ${name}`, failed: (name) => `categorise ${name}` });
  }

  if (loading) {
    return <div className="ov-skel" aria-busy="true" />;
  }

  return (
    <div className="ov">
      <LoadFailure
        errors={{ ...errors, ...(householdError ? { household: householdError } : {}) }}
        loadedAt={loadedAt}
        onRetry={async () => {
          await Promise.all([reloadHousehold(), reload()]);
        }}
      />
      <Freshness
        loadedAt={loadedAt}
        refreshing={refreshing}
        onRefresh={async () => {
          await Promise.all([reloadHousehold(), reload()]);
        }}
      />
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
        <OverviewEmpty navigate={navigate} />
      ) : (
        <>

          <OverviewPeriod
            period={period}
            p={p}
            money={money}
            now={now}
            prev={prev}
            prevLabel={prevLabel}
            expected={expected}
          />

          <section className="ov-split">
            <OverviewFlow
              period={period}
              money={money}
              maxColValue={maxColValue}
              columns={columns}
              selected={selected}
              setSelectedKey={setSelectedKey}
              now={now}
            />

            <OverviewAttention
              attention={attention}
              attentionShown={attentionShown}
              money={money}
              categorise={categorise}
              categories={categories}
              markReviewed={markReviewed}
              navigate={navigate}
              now={now}
              attentionHidden={attentionHidden}
              attentionExpanded={attentionExpanded}
              setAttentionExpanded={setAttentionExpanded}
            />
          </section>


          <OverviewNext30
            next30={next30}
            recurring={recurring}
            money={money}
            committedTotal={committedTotal}
            withoutAutopay={withoutAutopay}
          />

          <OverviewNetWorth
            scope={scope}
            me={me}
            members={members}
            netWorthTrustworthy={netWorthTrustworthy}
            money={money}
            nw={nw}
            netWorthIsProvisional={netWorthIsProvisional}
            unconfirmed={unconfirmed}
            nwChange1mo={nwChange1mo}
            nwChange12mo={nwChange12mo}
            runway={runway}
          />

          <OverviewQuality
            qualityIssues={qualityIssues}
            qualityOk={qualityOk}
            quality={quality}
            accounts={accounts}
          />

          <section className="ov-triple">
            <OverviewSpending
              period={period}
              composition={composition}
              money={money}
            />

            <OverviewRecent
              recent={recent}
              money={money}
            />

            <OverviewAccounts
              unread={unread}
              accountRows={accountRows}
              members={members}
              money={money}
            />
          </section>
        </>
      )}

      {toast && (
        <div className="ov-toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => {
                toast.undo();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const RECENT_COUNT = 5;
