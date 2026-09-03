import { useState } from 'react';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import Activity from './money/Activity';
import Recurring from './money/Recurring';
import Budget from './money/Budget';
import Insights from './money/Insights';
import Inbox from './money/Inbox';
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
  const pendingIntake = data.intake?.filter((i) => i.status === 'pending').length ?? 0;

  return (
    <div className="mn">
      <div className="ov-kicker">Money</div>
      <div className="mn-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="om-tab" data-active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'inbox' && pendingIntake > 0 ? ` (${pendingIntake})` : ''}
          </button>
        ))}
      </div>

      {tab === 'activity' && <Activity household={household} members={members} me={me} data={data} loading={loading} />}
      {tab === 'recurring' && <Recurring household={household} members={members} data={data} loading={loading} />}
      {tab === 'budget' && <Budget household={household} members={members} me={me} data={data} loading={loading} />}
      {tab === 'insights' && <Insights me={me} members={members} data={data} loading={loading} />}
      {tab === 'inbox' && (
        <Inbox household={household} accounts={data.accounts} categories={data.categories} data={data} loading={loading} />
      )}
    </div>
  );
}
