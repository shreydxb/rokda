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
import { monthActualsByCategory, monthBudgetTrack } from '../lib/budget';
import { notableMoves, trailingAverageByCategory } from '../lib/insights';
import { statementRows } from '../lib/statements';
import { buildDividendInput, needsYou } from '../lib/dividendSummary';
import { cashCoverStatus } from '../lib/cashCover';
import { billPaymentInitial } from '../lib/transactionForm';
import { householdToday } from '../lib/day';
import { useMoneyDisplay } from '../lib/CurrencyContext';
import { supabase } from '../lib/supabaseClient';
import { useOverviewData } from './useOverviewData';
import { usePlanningData } from './usePlanningData';
import { usePlanFigures } from './planning/usePlanFigures';
import { netWorthSummary, visibleAccounts, periodSummary, buildChartColumns, dataQuality, visibleRows, next30Items, next30Bills } from './overviewMath';
import { anyFailed, neverLoaded } from '../lib/loadState';
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
  // worth is withheld outright when accounts or holdings didn't load (QA-10).
  const netWorthTrustworthy = !anyFailed(errors, ['accounts', 'holdings']);
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
  const budget = useMemo(() => monthBudgetTrack({ budgets, categories, transactions, year, month, scopeMemberId, now }), [budgets, categories, transactions, year, month, scopeMemberId, now]);
  const columns = useMemo(() => buildChartColumns(transactions, period, scopeMemberId, now), [transactions, period, scopeMemberId, now]);

  // Where this month went, and what moved against the usual: Insights' own
  // figures (lib/insights.js), net of refunds.
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const where = useMemo(() => {
    const actual = monthActualsByCategory(transactions, year, month, scopeMemberId, now);
    const { averages } = trailingAverageByCategory(transactions, year, month, USUAL_MONTHS, scopeMemberId);
    return [...actual.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, value]) => ({ id, name: catById.get(id)?.name ?? 'Uncategorised', value, usual: averages.get(id) ?? null }));
  }, [transactions, year, month, scopeMemberId, now, catById]);
  const moves = useMemo(() => notableMoves(transactions, year, month, scopeMemberId, catById, now, { limit: 3 }), [transactions, year, month, scopeMemberId, catById, now]);

  const attention = useMemo(
    () => buildAttentionItems({ transactions, recurring, accounts, holdings, categories, snapshots: netWorthSnapshots, backupRecords, yearlyChecks, scopeMemberId, now }),
    [transactions, recurring, accounts, holdings, categories, netWorthSnapshots, backupRecords, yearlyChecks, scopeMemberId, now]
  );
  const statements = useMemo(() => statementRows({ accounts, reconciliations: statementReconciliations, transactions, now }), [accounts, statementReconciliations, transactions, now]);
  const today = householdToday(now);
  const dividendInput = useMemo(() => buildDividendInput({ data, household, scopeMemberId, today }), [data, household, scopeMemberId, today]);
  const todo = useMemo(
    () =>
      buildTodo({
        attention,
        statements,
        dividendQuestions: needsYou(dividendInput),
        holdings: dividendInput.holdings,
        goalsShort: plan.goalsMissing.length === 0 ? plan.shortOfCash : [],
      }),
    [attention, statements, dividendInput, plan.goalsMissing, plan.shortOfCash]
  );

  const next30 = useMemo(() => next30Items(recurring, attention, scopeMemberId, now), [recurring, attention, scopeMemberId, now]);
  const cover = useMemo(() => (anyFailed(errors, ['accounts', 'recurring']) ? null : cashCoverStatus(accountRows, next30Bills(next30, accounts, scopeMemberId, now), { days: 30, today: now })), [errors, accountRows, next30, accounts, scopeMemberId, now]);

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
  const recent = [...visibleRows(transactions, scopeMemberId)].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0)).slice(0, RECENT_COUNT);

  const lede = isEmpty ? 'Nothing recorded yet' : todo.length > 0 ? `${todo.length} thing${todo.length === 1 ? '' : 's'} need${todo.length === 1 ? 's' : ''} a decision` : 'All clear';

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
  const markPaid = (recurringId) => {
    const bill = recurring.find((r) => r.id === recurringId);
    if (bill) setEditing({ initial: billPaymentInitial(bill, accounts) });
  };

  const reloadAll = async () => {
    await Promise.all([reloadHousehold(), reload(), planning.reload()]);
  };

  if (loading) {
    return <div className="ov-skel" aria-busy="true" />;
  }

  return (
    <div className="ov ov-cockpit">
      <LoadFailure errors={{ ...errors, ...(householdError ? { household: householdError } : {}) }} loadedAt={loadedAt} onRetry={reloadAll} />
      <Freshness
        title={lede}
        kicker={
          <>
            <span>{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</span>
            {!isEmpty && <QualityChip issues={qualityIssues} open={qualityOpen} onToggle={() => setQualityOpen((v) => !v)} />}
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
          {qualityOpen && <QualityPanel qualityOk={qualityOk} quality={quality} accounts={accounts} />}
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
            <OverviewMonth period={period} p={p} money={money} now={now} expected={expected} budget={budget} />
          </div>
          <div className="ov-band ov-band-wide">
            <OverviewTodo rows={todo} money={money} categories={categories} categorise={categorise} markReviewed={markReviewed} onMarkPaid={markPaid} />
            <OverviewNext30 items={next30} money={money} cover={cover} now={now} />
          </div>
          <div className="ov-band ov-band-wide">
            <OverviewFlow period={period} columns={columns} money={money} now={now} />
            <OverviewWhere categories={where} moves={moves} money={money} now={now} />
          </div>
          {planning.loading ? <div className="ov-skel ov-skel-plan" aria-busy="true" /> : <OverviewPlan f={plan} unread={neverLoaded(sources, ['household'])} onRetry={reloadAll} />}
          <OverviewRecent recent={recent} money={money} categories={categories} accounts={accounts} onOpen={(tx) => setEditing(tx)} />
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
          onSaved={reload}
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
