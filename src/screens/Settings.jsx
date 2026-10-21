import { useTab } from '../lib/useTab';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import Household from './settings/Household';
import CategoriesRules from './settings/CategoriesRules';
import Telegram from './settings/Telegram';
import Backups from './settings/Backups';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import TabRow from './TabRow';
import './Settings.css';

const TABS = [
  { id: 'household', label: 'Household' },
  { id: 'categories', label: 'Categories & rules' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'backups', label: 'Backups' },
];

export default function Settings() {
  // The tab is in the address, so Needs attention can open Backups directly.
  const [tab, setTab] = useTab(TABS);
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;

  return (
    <div className="mn">
      <Freshness
        title="Settings"
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
      <TabRow tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'household' && (
        <Household household={household} members={members} me={me} loading={loading} reload={reloadHousehold} />
      )}
      {tab === 'categories' && <CategoriesRules household={household} members={members} data={data} loading={loading} />}
      {tab === 'telegram' && <Telegram household={household} loading={loading} />}
      {tab === 'backups' && <Backups household={household} members={members} data={data} loading={loading} />}
    </div>
  );
}
