import { useState } from 'react';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import NetWorth from './wealth/NetWorth';
import Accounts from './wealth/Accounts';
import Investments from './wealth/Investments';
import LoadFailure from './LoadFailure';
import './Wealth.css';

const TABS = [
  { id: 'networth', label: 'Net Worth' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'investments', label: 'Investments' },
];

export default function Wealth() {
  const [tab, setTab] = useState('networth');
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;

  return (
    <div className="mn">
      <div className="ov-kicker">Wealth</div>
      <LoadFailure
        errors={{ ...data.errors, ...(householdError ? { household: householdError } : {}) }}
        loadedAt={data.loadedAt}
        onRetry={async () => {
          await Promise.all([reloadHousehold(), data.reload()]);
        }}
      />
      <div className="mn-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="om-tab" data-active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'networth' && <NetWorth household={household} me={me} members={members} data={data} loading={loading} />}
      {tab === 'accounts' && <Accounts household={household} members={members} me={me} data={data} loading={loading} />}
      {tab === 'investments' && <Investments household={household} members={members} me={me} data={data} loading={loading} />}
    </div>
  );
}
