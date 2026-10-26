import { useTab } from '../lib/useTab';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import NetWorth from './wealth/NetWorth';
import Accounts from './wealth/Accounts';
import Investments from './wealth/Investments';
import Statements from './wealth/Statements';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import BackToReview from './BackToReview';
import TabRow from './TabRow';
import './Wealth.css';

const TABS = [
  { id: 'networth', label: 'Net worth' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'investments', label: 'Investments' },
  { id: 'statements', label: 'Statements' },
];

export default function Wealth() {
  // In the address, so a link can open Accounts or Investments directly.
  const [tab, setTab] = useTab(TABS);
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;

  return (
    <div className="mn">
      <Freshness
        title="Wealth"
        loadedAt={data.loadedAt}
        refreshing={data.refreshing}
        onRefresh={async () => {
          await Promise.all([reloadHousehold(), data.reload()]);
        }}
      />
      <LoadFailure
        errors={{ ...data.errors, ...(householdError ? { household: householdError } : {}) }}
        loadedAt={data.loadedAt}
        onRetry={async () => {
          await Promise.all([reloadHousehold(), data.reload()]);
        }}
      />
      <BackToReview />
      <TabRow tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'networth' && <NetWorth household={household} me={me} members={members} data={data} loading={loading} />}
      {tab === 'accounts' && <Accounts household={household} members={members} me={me} data={data} loading={loading} />}
      {tab === 'investments' && <Investments household={household} members={members} me={me} data={data} loading={loading} reloadHousehold={reloadHousehold} />}
      {tab === 'statements' && <Statements household={household} me={me} members={members} data={data} loading={loading} />}
    </div>
  );
}
