import { useEffect, useRef, useState } from 'react';
import { useTab } from '../lib/useTab';
import { useHousehold } from '../lib/useHousehold';
import { usePlanningInputs } from './useOverviewData';
import { usePlanningData } from './usePlanningData';
import PlanSummary from './planning/PlanSummary';
import Goals from './planning/Goals';
import DebtPayoff from './planning/DebtPayoff';
import Forecast from './planning/Forecast';
import Drawdown from './planning/Drawdown';
import LifePlan from './planning/LifePlan';
import Notes from './planning/Notes';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import BackToReview from './BackToReview';
import AedNote from './AedNote';
import TabRow from './TabRow';
import './Planning.css';

const TABS = [
  { id: 'plan', label: 'Plan' },
  { id: 'life', label: 'Life plan' },
  { id: 'goals', label: 'Goals' },
  { id: 'debt', label: 'Debt payoff' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'drawdown', label: 'Drawdown' },
  { id: 'notes', label: 'Notes' },
];

export default function Planning() {
  // In the address, so Back returns to the tab you were on.
  const [tab, setTab] = useTab(TABS);
  const { household, members, me, loading: householdLoading, refreshing: householdRefreshing, error: householdError, reload: reloadHousehold } = useHousehold();
  const inputs = usePlanningInputs(household?.id);
  const planning = usePlanningData(household?.id);
  const loading = householdLoading || inputs.loading || planning.loading;
  // What failed, and what has ever loaded, across both reads: each tab
  // withholds what rests on a source that never arrived (lib/loadState.js).
  // The household lookup is a source too: with it unread, every list below
  // would be the empty placeholder.
  const sources = {
    errors: { ...inputs.errors, ...planning.errors, ...(householdError ? { household: householdError } : {}) },
    loaded: { ...inputs.loaded, ...planning.loaded, household: Boolean(household) },
  };
  const retry = async () => {
    await Promise.all([reloadHousehold(), inputs.reload(), planning.reload()]);
  };
  // The scenario and the money shown are chosen on Forecast, Life plan or
  // Drawdown and hold on all three until changed (planning/AssumptionsBar.jsx).
  // A look for now: never saved.
  const [scenario, setScenario] = useState('baseline');
  const [moneyMode, setMoneyMode] = useState('real');
  const lens = { scenario, onScenario: setScenario, moneyMode, onMoneyMode: setMoneyMode };

  // A link from inside a tab (one of Plan's cards) opens another tab and
  // takes focus to it, rather than leaving it nowhere when the card it was
  // on goes away (Planning audit, 0b-F).
  const focusTab = useRef(false);
  const openTab = (id) => {
    focusTab.current = true;
    setTab(id);
  };
  useEffect(() => {
    if (!focusTab.current) return;
    focusTab.current = false;
    document.querySelector('.mn-tabs [aria-current="page"]')?.focus();
  }, [tab]);

  return (
    <div className="mn">
      {/* Two loads; the older of the two is how fresh the page is. */}
      <Freshness
        title="Planning"
        loadedAt={inputs.loadedAt && planning.loadedAt ? (inputs.loadedAt < planning.loadedAt ? inputs.loadedAt : planning.loadedAt) : null}
        refreshing={householdRefreshing || inputs.refreshing || planning.refreshing}
        onRefresh={retry}
      />
      <LoadFailure
        errors={{ ...inputs.errors, ...planning.errors, ...(householdError ? { household: householdError } : {}) }}
        loadedAt={planning.loadedAt ?? inputs.loadedAt}
        onRetry={retry}
      />
      <BackToReview />
      <TabRow tabs={TABS} active={tab} onChange={setTab} />

      {(tab === 'plan' || tab === 'goals' || tab === 'debt') && <AedNote household={household} />}
      {tab === 'plan' && (
        <PlanSummary
          household={household}
          members={members}
          me={me}
          accounts={inputs.accounts}
          transactions={inputs.transactions}
          recurring={inputs.recurring}
          holdings={inputs.holdings}
          budgets={inputs.budgets}
          categories={inputs.categories}
          data={planning}
          sources={sources}
          onRetry={retry}
          loading={loading}
          onOpenTab={openTab}
        />
      )}
      {tab === 'life' && (
        <LifePlan
          {...lens}
          household={household}
          members={members}
          accounts={inputs.accounts}
          transactions={inputs.transactions}
          recurring={inputs.recurring}
          holdings={inputs.holdings}
          budgets={inputs.budgets}
          categories={inputs.categories}
          data={planning}
          sources={sources}
          onRetry={retry}
          loading={loading}
          onReload={inputs.reload}
          onOpenTab={openTab}
        />
      )}
      {tab === 'goals' && (
        <Goals
          household={household}
          members={members}
          me={me}
          accounts={inputs.accounts}
          holdings={inputs.holdings}
          transactions={inputs.transactions}
          recurring={inputs.recurring}
          budgets={inputs.budgets}
          categories={inputs.categories}
          data={planning}
          sources={sources}
          onRetry={retry}
          loading={loading}
        />
      )}
      {tab === 'debt' && (
        <DebtPayoff household={household} members={members} me={me} accounts={inputs.accounts} data={planning} sources={sources} onRetry={retry} loading={loading} onReload={inputs.reload} />
      )}
      {tab === 'forecast' && (
        <Forecast
          {...lens}
          household={household}
          members={members}
          accounts={inputs.accounts}
          transactions={inputs.transactions}
          recurring={inputs.recurring}
          holdings={inputs.holdings}
          budgets={inputs.budgets}
          categories={inputs.categories}
          data={planning}
          sources={sources}
          onRetry={retry}
          loading={loading}
          onOpenTab={openTab}
        />
      )}
      {tab === 'drawdown' && (
        <Drawdown
          {...lens}
          household={household}
          members={members}
          accounts={inputs.accounts}
          transactions={inputs.transactions}
          recurring={inputs.recurring}
          holdings={inputs.holdings}
          budgets={inputs.budgets}
          categories={inputs.categories}
          data={planning}
          sources={sources}
          onRetry={retry}
          loading={loading}
          onOpenTab={openTab}
        />
      )}
      {tab === 'notes' && <Notes household={household} me={me} members={members} data={planning} sources={sources} onRetry={retry} loading={loading} />}
    </div>
  );
}
