import { useMemo, useRef, useState } from 'react';
import { useNow } from '../lib/useNow';
import { useNavigate } from 'react-router-dom';
import { useHousehold } from '../lib/useHousehold';
import { useScope } from '../lib/ScopeContext';
import { resolveScopeMemberId } from '../lib/scope';
import { expectedIncome } from '../lib/expectedIncome';
import { buildNetWorthSeries, changeOverMonths } from '../lib/netWorth';
import { buildAttentionItems } from '../lib/attention';
import { buildTodo } from '../lib/todo';
import { monthActualsByCategory, monthBudgetTrack, monthSpendBreakdown } from '../lib/budget';
import { UNCATEGORISED } from '../lib/activityLink';
import { trailingAverageByCategory } from '../lib/insights';
import { statementRows } from '../lib/statements';
import { buildDividendInput, needsYou } from '../lib/dividendSummary';
import { cashCoverStatus } from '../lib/cashCover';
import { billPaymentInitial } from '../lib/transactionForm';
import { householdToday, isPosted } from '../lib/day';
import { useMoneyDisplay } from '../lib/CurrencyContext';
import { supabase } from '../lib/supabaseClient';
import { useOverviewData } from './useOverviewData';
import { usePlanningData } from './usePlanningData';
import { usePlanFigures } from './planning/usePlanFigures';
import { netWorthSummary, visibleAccounts, periodSummary, buildChartColumns, dataQuality, visibleRows, next30Items, next30Bills } from './overviewMath';
import { neverLoaded } from '../lib/loadState';
import { unconfirmedAccounts } from '../lib/balance';
import { Segmented } from '../design-system/kit';
import OverviewEmpty from './overview/OverviewEmpty';
import OverviewNetWorth from './overview/OverviewNetWorth';
import OverviewMonth from './overview/OverviewMonth';
import OverviewTodo from './overview/OverviewTodo';
import OverviewNext30 from './overview/OverviewNext30';
import OverviewFlow from './overview/OverviewFlow';
import OverviewWhere from './overview/OverviewWhere';
import OverviewPlan from './overview/OverviewPlan';
import OverviewRecent from './overview/OverviewRecent';
import { QualityChip, QualityPanel } from './overview/OverviewQuality';
import RecordEditor from './money/RecordEditor';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import './Overview.css';
import './overview/Cockpit.css';

const PERIODS = [
  { id: 'mtd', label: 'Month' },
  { id: 'qtd', label: 'Quarter' },
  { id: 'ytd', label: 'Year' },
];
const RECENT_COUNT = 5;
// Insights' own window for a category's usual month (money/Insights.jsx).
const USUAL_MONTHS = 6;
// The records a dividend question rests on (wealth/Dividends.jsx).
const DIVIDEND_SOURCES = ['holdings', 'holdingDividends', 'holdingTrades', 'dividendEvents', 'dividendSplits', 'dividendSpecialParts', 'accounts'];

// Overview, the cockpit (the revamp, phase 3; design/prototype, review
// S-overview-1 to 12): what needs doing, how the period is going, what the
// household is worth and whether the plan holds, on one screen. Every figure
// is one the app already works out elsewhere; this lays them out.
export default function Overview() {
  const navigate = useNavigate();
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const { scope } = useScope();
  const scopeMemberId = resolveScopeMemberId(scope, me, members);
  const money = useMoneyDisplay(household);

  const data = useOverviewData(household?.id);
  const { loading: dataLoading, accounts, transactions, categories, recurring, budgets, netWorthSnapshots, holdings, backupRecords, yearlyChecks, statementReconciliations, errors, loaded, loadedAt, refreshing, reload } = data;
  // The Plan strip's records, read beside Overview's own (the revamp, phase 3).
  const planning = usePlanningData(household?.id);
  const sources = {
    errors: { ...errors, ...planning.errors, ...(householdError ? { household: householdError } : {}) },
    loaded: { ...loaded, ...planning.loaded, household: Boolean(household) },
  };
  const plan = usePlanFigures({ household, members, me, accounts, transactions, recurring, holdings, budgets, categories, data: planning, sources });

  const [period, setPeriod] = useState('mtd');
  const [qualityOpen, setQualityOpen] = useState(false);
  const [editing, setEditing] = useState(null);
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
  // worth is withheld outright when accounts or holdings never loaded
  // (QA-10); one that loaded before and failed on a refresh keeps its last
  // figures, with the banner, as Wealth does (the review of the whole
  // revamp).
  const netWorthTrustworthy = neverLoaded({ errors, loaded }, ['accounts', 'holdings']).length === 0;
  // What rests on the records or the recurring bills is withheld when they
  // never loaded, and says why: it read as zeros, "none yet" and "All clear"
  // (the review of the whole revamp).
  const txUnread = neverLoaded({ errors, loaded }, ['transactions']);
  const recurringUnread = neverLoaded({ errors, loaded }, ['recurring']);
  const todoUnread = neverLoaded({ errors, loaded }, ['transactions', 'recurring', 'accounts', 'holdings', 'statementReconciliations', 'backupRecords', 'yearlyChecks']);
  // Arithmetic over balances nobody has confirmed is provisional, and says so
  // rather than presenting itself as the household's position (QA-02).
  const unconfirmed = unconfirmedAccounts(accountRows);
  const nwSeries = useMemo(() => buildNetWorthSeries(netWorthSnapshots, nw.assets, nw.liabilities, now), [netWorthSnapshots, nw.assets, nw.liabilities, now]);
  const nwChange1mo = changeOverMonths(nwSeries, 1);

  const p = useMemo(() => periodSummary(transactions, period, scopeMemberId, now), [transactions, period, scopeMemberId, now]);
  // Pay still to come this period, so Income reading 0 before payday says why.
  const expected = useMemo(() => expectedIncome(recurring, transactions, { kind: period, start: p.start, now, scopeMemberId }), [recurring, transactions, period, p.start, now, scopeMemberId]);
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  // The budget is the household's, so its track is shown to both of you:
  // one person's share against it read as well under budget (fresh review of
  // the cockpit; Budget says the same).
  const budget = useMemo(() => (scope === 'both' ? monthBudgetTrack({ budgets, categories, transactions, year, month, scopeMemberId, now }) : null), [scope, budgets, categories, transactions, year, month, scopeMemberId, now]);
  const columns = useMemo(() => buildChartColumns(transactions, period, scopeMemberId, now), [transactions, period, scopeMemberId, now]);

  // Where this month went, and what moved against the usual: Insights' own
  // figures (lib/insights.js), net of refunds.
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const where = useMemo(() => {
    const actual = monthActualsByCategory(transactions, year, month, scopeMemberId, now);
    const { averages } = trailingAverageByCategory(transactions, year, month, USUAL_MONTHS, scopeMemberId);
    const rows = [...actual.entries()].map(([id, value]) => ({ id, name: catById.get(id)?.name ?? 'Uncategorised', value, usual: averages.get(id) ?? null }));
    // Spending with no category is a bar of its own, opening those records:
    // left out, a month whose biggest spend was uncategorised never said so
    // (the review of the whole revamp).
    const uncategorised = monthSpendBreakdown(transactions, [], year, month, scopeMemberId, now).uncategorised;
    if (uncategorised > 0) rows.push({ id: UNCATEGORISED, name: 'Uncategorised', value: uncategorised, usual: null });
    return rows
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [transactions, year, month, scopeMemberId, now, catById]);
  const attention = useMemo(
    () => buildAttentionItems({ transactions, recurring, accounts, holdings, categories, snapshots: netWorthSnapshots, backupRecords, yearlyChecks, scopeMemberId, now }),
    [transactions, recurring, accounts, holdings, categories, netWorthSnapshots, backupRecords, yearlyChecks, scopeMemberId, now]
  );
  // What changed: Needs attention's own check of a category running ahead of
  // its usual pace this month, the finding that left To do (fresh review of
  // the cockpit: a whole month's average against a month to date misread).
  const moves = useMemo(
    () =>
      attention
        .filter((a) => a.kind === 'category_anomaly')
        .map((a) => ({ categoryId: a.categoryId, categoryName: a.name, actual: a.actual, expectedSoFar: a.expectedSoFar, pct: a.actual / a.expectedSoFar - 1 }))
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 3),
    [attention]
  );
  // Statements and dividend questions only from records that loaded: with
  // them unread, every card read "To check" (fresh review of the cockpit), as
  // the Statements and Dividends tabs already guard. The cards in the scope.
  const statementsRead = neverLoaded({ errors, loaded }, ['accounts', 'transactions', 'statementReconciliations']).length === 0;
  const statements = useMemo(
    () => (statementsRead ? statementRows({ accounts: visibleAccounts(accounts, scopeMemberId), reconciliations: statementReconciliations, transactions, now }) : []),
    [statementsRead, accounts, scopeMemberId, statementReconciliations, transactions, now]
  );
  const today = householdToday(now);
  const dividendsRead = neverLoaded({ errors, loaded }, DIVIDEND_SOURCES).length === 0;
  const { holdingDividends, holdingTrades, dividendEvents, dividendSplits, dividendSpecialParts, dividendFeedStatus, fxRateHistory } = data;
  const dividendInput = useMemo(
    () => buildDividendInput({ data: { holdings, holdingDividends, holdingTrades, dividendEvents, dividendSplits, dividendSpecialParts, dividendFeedStatus, accounts, fxRateHistory }, household, scopeMemberId, today }),
    [holdings, holdingDividends, holdingTrades, dividendEvents, dividendSplits, dividendSpecialParts, dividendFeedStatus, accounts, fxRateHistory, household, scopeMemberId, today]
  );
  const todo = useMemo(
    () =>
      buildTodo({
        attention,
        statements,
        dividendQuestions: dividendsRead ? needsYou(dividendInput) : [],
        holdings: dividendInput.holdings,
        goalsShort: plan.goalsMissing.length === 0 ? plan.shortOfCash : [],
      }),
    [attention, statements, dividendsRead, dividendInput, plan.goalsMissing, plan.shortOfCash]
  );

  const next30 = useMemo(() => next30Items(recurring, attention, scopeMemberId, now), [recurring, attention, scopeMemberId, now]);
  // The cash to hand against what is committed is the household's, whoever
  // is shown, as the bot's morning check is (fresh review of the cockpit).
  const cover = useMemo(
    () => (neverLoaded({ errors, loaded }, ['accounts', 'recurring']).length > 0 ? null : cashCoverStatus(accounts, next30Bills(next30Items(recurring, [], null, now), accounts, null, now), { days: 30, today: now })),
    [errors, loaded, accounts, recurring, now]
  );

  const quality = useMemo(() => dataQuality(accounts, transactions, now), [accounts, transactions, now]);
  // The four checks behind the Data chip.
  const qualityOk = {
    transactions: quality.daysSinceLastTx !== null && quality.daysSinceLastTx <= 3,
    categorisation: quality.categorisedPct !== null && quality.categorisedPct >= 0.9,
    review: quality.openReview === 0,
    accounts: accounts.length > 0,
  };
  const qualityIssues = Object.values(qualityOk).filter((ok) => !ok).length;

  // A glance, not a ledger: Activity is where records are looked into (SHR-328).
  // Newest first, whatever order the rows arrived in.
  // Posted only, as Activity shows by default: one scheduled for later is not
  // among the newest (the review of the whole revamp).
  const recent = [...visibleRows(transactions, scopeMemberId)].filter((t) => isPosted(t, now)).sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0)).slice(0, RECENT_COUNT);

  const lede = isEmpty
    ? 'Nothing recorded yet'
    : todo.length > 0
      ? `${todo.length} thing${todo.length === 1 ? '' : 's'} need${todo.length === 1 ? 's' : ''} a decision`
      : todoUnread.length > 0
        ? 'Couldn’t check everything'
        : 'All clear';
  // The Data chip's checks are about the records and accounts themselves.
  const qualityRead = neverLoaded({ errors, loaded }, ['transactions', 'accounts']).length === 0;

  function showToast(message, undo) {
    setToast({ message, undo });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }

  // A quick action worked only if it changed the one record: a failed
  // write, or a record deleted elsewhere, used to be told it had worked,
  // with an undo for a change never made (outside review, E-11).
  async function changeRecord(tx, change) {
    const { data: rows, error } = await supabase.from('transactions').update(change).eq('id', tx.id).select('id');
    return !error && (rows?.length ?? 0) === 1;
  }

  async function quickAction(tx, change, { done, failed }) {
    const name = `"${tx.merchant ?? 'transaction'}"`;
    const before = Object.fromEntries(Object.keys(change).map((k) => [k, tx[k]]));
    const ok = await changeRecord(tx, change);
    await reload();
    if (!ok) {
      showToast(`Couldn't ${failed(name)}: it may have changed or been deleted elsewhere. Nothing was changed.`, null);
      return;
    }
    showToast(done(name), async () => {
      const undone = await changeRecord(tx, before);
      await reload();
      if (!undone) showToast(`Couldn't undo that: ${name} may have changed elsewhere.`, null);
    });
  }

  const markReviewed = (tx) => quickAction(tx, { needs_review: false }, { done: (name) => `Marked ${name} reviewed`, failed: (name) => `mark ${name} reviewed` });
  const categorise = (tx, categoryId) => quickAction(tx, { category_id: categoryId, needs_review: false }, { done: (name) => `Categorised ${name}`, failed: (name) => `categorise ${name}` });
  // "Mark paid" opens the transaction editor filled from the bill, as
  // Recurring's does (lib/transactionForm.js).
  // Dated the day it was due, so the payment settles it (fresh review of the
  // cockpit).
  const markPaid = (recurringId, dueOn) => {
    const bill = recurring.find((r) => r.id === recurringId);
    if (bill) setEditing({ initial: billPaymentInitial(bill, accounts, dueOn ?? today) });
  };

  const reloadAll = async () => {
    await Promise.all([reloadHousehold(), reload(), planning.reload()]);
  };

  if (loading) {
    return <div className="ov-skel" aria-busy="true" />;
  }

  return (
    <div className="ov ov-cockpit">
      <LoadFailure errors={{ ...errors, ...planning.errors, ...(householdError ? { household: householdError } : {}) }} loadedAt={loadedAt} onRetry={reloadAll} />
      <Freshness
        title={lede}
        kicker={
          <>
            <span>{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</span>
            {!isEmpty && qualityRead && <QualityChip issues={qualityIssues} open={qualityOpen} onToggle={() => setQualityOpen((v) => !v)} />}
          </>
        }
        tools={
          <>
            <Segmented label="Period" options={PERIODS} value={period} onChange={setPeriod} />
            <button type="button" className="ds-btn ds-btn-primary" onClick={() => setEditing('new')}>
              + Transaction
            </button>
          </>
        }
        loadedAt={loadedAt}
        refreshing={refreshing}
        onRefresh={reloadAll}
      />

      {isEmpty ? (
        <OverviewEmpty navigate={navigate} onAddTransaction={() => setEditing('new')} />
      ) : (
        <div className="ov-bands">
          {qualityOpen && qualityRead && <QualityPanel qualityOk={qualityOk} quality={quality} accounts={accounts} />}
          <div className="ov-band ov-band-hero">
            <OverviewNetWorth
              scope={scope}
              me={me}
              members={members}
              netWorthTrustworthy={netWorthTrustworthy}
              money={money}
              nw={nw}
              netWorthIsProvisional={unconfirmed.length > 0}
              unconfirmed={unconfirmed}
              nwChange1mo={nwChange1mo}
              series={nwSeries}
            />
            <OverviewMonth period={period} p={p} money={money} now={now} expected={expected} budget={budget} unread={txUnread} />
          </div>
          <div className="ov-band ov-band-wide">
            <OverviewTodo rows={todo} money={money} categories={categories} categorise={categorise} markReviewed={markReviewed} onMarkPaid={markPaid} unread={todoUnread} />
            <OverviewNext30 items={next30} money={money} cover={cover} household={scope !== 'both'} hasRecurring={recurring.length > 0} now={now} unread={recurringUnread} />
          </div>
          <div className="ov-band ov-band-wide">
            <OverviewFlow period={period} columns={columns} money={money} now={now} unread={txUnread} />
            <OverviewWhere categories={where} moves={moves} money={money} now={now} period={period} unread={txUnread} />
          </div>
          {planning.loading ? <div className="ov-skel ov-skel-plan" aria-busy="true" /> : <OverviewPlan f={plan} scope={scope} unread={neverLoaded(sources, ['household'])} onRetry={reloadAll} />}
          <OverviewRecent recent={recent} money={money} categories={categories} accounts={accounts} onOpen={(tx) => setEditing(tx)} unread={txUnread} />
        </div>
      )}

      {editing && (
        <RecordEditor
          editing={editing}
          setEditing={setEditing}
          household={household}
          accounts={accounts}
          categories={categories}
          members={members}
          transactions={transactions}
          links={data.transactionLinks ?? []}
          categoryRules={data.categoryRules ?? []}
          fxHistory={data.fxRateHistory}
          onSaved={async ({ notice } = {}) => {
            // The editor's own word on the save ("Saved, and remembered…"),
            // as Activity shows it (fresh review of the cockpit).
            if (notice?.text) showToast(notice.text, null);
            await reload();
          }}
        />
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
