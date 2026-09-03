import { useState } from 'react';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import Household from './settings/Household';
import CategoriesRules from './settings/CategoriesRules';
import './Settings.css';

const TABS = [
  { id: 'household', label: 'Household' },
  { id: 'categories', label: 'Categories & rules' },
];

export default function Settings() {
  const [tab, setTab] = useState('household');
  const { household, members, me, loading: householdLoading, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;

  return (
    <div className="mn">
      <div className="ov-kicker">Settings</div>
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
      {tab === 'categories' && <CategoriesRules household={household} data={data} loading={loading} />}
    </div>
  );
}
