import { useState } from 'react';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import Activity from './money/Activity';
import Recurring from './money/Recurring';
import './Money.css';

const TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'budget', label: 'Budget' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'insights', label: 'Insights' },
  { id: 'inbox', label: 'Inbox' },
];

export default function Money() {
  const [tab, setTab] = useState('activity');
  const { household, members, me, loading: householdLoading } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;

  return (
    <div className="mn">
      <div className="ov-kicker">Money</div>
      <div className="mn-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="om-tab"
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'activity' && <Activity household={household} members={members} me={me} data={data} loading={loading} />}
      {tab === 'recurring' && <Recurring household={household} members={members} data={data} loading={loading} />}
      {tab !== 'activity' && tab !== 'recurring' && (
        <div className="mn-soon">
          <div className="ov-empty-kicker">Not built yet</div>
          <div className="ov-empty-body">{TABS.find((t) => t.id === tab)?.label} is tracked in Linear and coming in a later pass.</div>
        </div>
      )}
    </div>
  );
}
