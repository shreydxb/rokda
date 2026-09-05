import { useState } from 'react';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import { usePlanningData } from './usePlanningData';
import Goals from './planning/Goals';
import DebtPayoff from './planning/DebtPayoff';
import Forecast from './planning/Forecast';
import LoadFailure from './LoadFailure';
import './Planning.css';

const TABS = [
  { id: 'goals', label: 'Goals' },
  { id: 'debt', label: 'Debt payoff' },
  { id: 'forecast', label: 'Forecast' },
];

export default function Planning() {
  const [tab, setTab] = useState('goals');
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const overview = useOverviewData(household?.id);
  const planning = usePlanningData(household?.id);
  const loading = householdLoading || overview.loading || planning.loading;

  return (
    <div className="mn">
      <div className="ov-kicker">Planning</div>
      <LoadFailure
        errors={{ ...overview.errors, ...planning.errors, ...(householdError ? { household: householdError } : {}) }}
        loadedAt={planning.loadedAt ?? overview.loadedAt}
        onRetry={async () => {
          await Promise.all([reloadHousehold(), overview.reload(), planning.reload()]);
        }}
      />
      <div className="mn-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="om-tab" data-active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

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
