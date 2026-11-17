import { useEffect, useRef, useState } from 'react';
import { useTab } from '../lib/useTab';
import { useHousehold } from '../lib/useHousehold';
import { usePlanningInputs } from './useOverviewData';
import { usePlanningData } from './usePlanningData';
// The tabs' shared styles first, so each tab's own stylesheet, which its
// screen imports, comes after them as it did inside this one.
import './Planning.css';
import Goals from './planning/Goals';
import DebtPayoff from './planning/DebtPayoff';
import LifePlan from './planning/LifePlan';
import Notes from './planning/Notes';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import BackToReview from './BackToReview';
import AedNote from './AedNote';
import TabRow from './TabRow';
import { ToolsSlot } from './PageTools';

// Plan, Goals & debts and Notes, as the prototype has them (the revamp,
// phase 6). The Plan summary went: Overview's Plan strip and To do took its
// place in phase 3. The Life plan is Plan now, and the debts sit under the
// goals.
const TABS = [
  { id: 'plan', label: 'Plan' },
  { id: 'goals', label: 'Goals & debts' },
  { id: 'notes', label: 'Notes' },
];
// Old links land where their content went: Forecast and Drawdown went into
// the Life plan (Planning audit, 3.15), which is Plan now, and Debt payoff
// into Goals & debts.
const RETIRED_TABS = { life: 'plan', forecast: 'plan', drawdown: 'plan', debt: 'goals' };

export default function Planning() {
  // In the address, so Back returns to the tab you were on.
  const [tab, setTab] = useTab(TABS, TABS[0].id, RETIRED_TABS);
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
  // The scenario and the money shown on the Life plan hold while you move
  // between tabs (planning/AssumptionsBar.jsx). A look for now: never saved.
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

  // The header's slot for the open tab's own controls (screens/PageTools.jsx).
  const [toolsNode, setToolsNode] = useState(null);

  return (
    <div className="mn">
      {/* Two loads; the older of the two is how fresh the page is. */}
      <Freshness
        title="Planning"
        tools={<span className="mn-tools" ref={setToolsNode} />}
        loadedAt={inputs.loadedAt && planning.loadedAt ? (inputs.loadedAt < planning.loadedAt ? inputs.loadedAt : planning.loadedAt) : null}
        refreshing={householdRefreshing || inputs.refreshing || planning.refreshing}
        onRefresh={retry}
      />
      <ToolsSlot node={toolsNode}>
      <LoadFailure
        errors={{ ...inputs.errors, ...planning.errors, ...(householdError ? { household: householdError } : {}) }}
        loadedAt={planning.loadedAt ?? inputs.loadedAt}
        onRetry={retry}
      />
      <BackToReview />
      <TabRow tabs={TABS} active={tab} onChange={setTab} />

      {(tab === 'plan' || tab === 'goals') && <AedNote household={household} />}
      {tab === 'plan' && (
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
        <>
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
          <DebtPayoff household={household} members={members} me={me} accounts={inputs.accounts} data={planning} sources={sources} onRetry={retry} loading={loading} onReload={inputs.reload} />
        </>
      )}
      {tab === 'notes' && <Notes household={household} me={me} members={members} data={planning} sources={sources} onRetry={retry} loading={loading} />}
      </ToolsSlot>
    </div>
  );
}
