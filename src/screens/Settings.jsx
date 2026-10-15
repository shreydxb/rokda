import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import Household from './settings/Household';
import CategoriesRules from './settings/CategoriesRules';
import Telegram from './settings/Telegram';
import Backups from './settings/Backups';
import LoadFailure from './LoadFailure';
import './Settings.css';

const TABS = [
  { id: 'household', label: 'Household' },
  { id: 'categories', label: 'Categories & rules' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'backups', label: 'Backups' },
];

export default function Settings() {
  // Arriving from Needs attention can name the tab to open, read once on mount.
  const location = useLocation();
  const [tab, setTab] = useState(() => (TABS.some((t) => t.id === location.state?.tab) ? location.state.tab : 'household'));
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;

  return (
    <div className="mn">
      <div className="ov-kicker">Settings</div>
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

      {tab === 'household' && (
        <Household household={household} members={members} me={me} loading={loading} reload={reloadHousehold} />
      )}
      {tab === 'categories' && <CategoriesRules household={household} members={members} data={data} loading={loading} />}
      {tab === 'telegram' && <Telegram household={household} loading={loading} />}
      {tab === 'backups' && <Backups household={household} members={members} data={data} loading={loading} />}
    </div>
  );
}
