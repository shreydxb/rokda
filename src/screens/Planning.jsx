import { useState } from 'react';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import { usePlanningData } from './usePlanningData';
import PlanSummary from './planning/PlanSummary';
import Goals from './planning/Goals';
import DebtPayoff from './planning/DebtPayoff';
import Forecast from './planning/Forecast';
import './Planning.css';

const TABS = [
  { id: 'plan', label: 'Plan' },
  { id: 'goals', label: 'Goals' },
  { id: 'debt', label: 'Debt payoff' },
  { id: 'forecast', label: 'Forecast' },
];

export default function Planning() {
  const [tab, setTab] = useState('plan');
  const { household, members, me, loading: householdLoading } = useHousehold();
  const overview = useOverviewData(household?.id);
  const planning = usePlanningData(household?.id);
  const loading = householdLoading || overview.loading || planning.loading;

  return (
    <div className="mn">
      <div className="ov-kicker">Planning</div>
      <div className="mn-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="om-tab" data-active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'plan' && (
        <PlanSummary
          household={household}
          members={members}
          me={me}
          accounts={overview.accounts}
          transactions={overview.transactions}
          holdings={overview.holdings}
          data={planning}
          loading={loading}
          onOpenTab={setTab}
        />
      )}
      {tab === 'goals' && <Goals household={household} members={members} me={me} data={planning} loading={loading} />}
      {tab === 'debt' && <DebtPayoff household={household} members={members} me={me} data={planning} loading={loading} />}
      {tab === 'forecast' && (
        <Forecast
          household={household}
          accounts={overview.accounts}
          transactions={overview.transactions}
          holdings={overview.holdings}
          data={planning}
          loading={loading}
        />
      )}
    </div>
  );
}
