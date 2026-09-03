import { useState } from 'react';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import NetWorth from './wealth/NetWorth';
import './Wealth.css';

const TABS = [
  { id: 'networth', label: 'Net Worth' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'investments', label: 'Investments' },
];

export default function Wealth() {
  const [tab, setTab] = useState('networth');
  const { household, members, me, loading: householdLoading } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;

  return (
    <div className="mn">
      <div className="ov-kicker">Wealth</div>
      <div className="mn-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="om-tab" data-active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'networth' && <NetWorth me={me} members={members} data={data} loading={loading} />}
      {tab !== 'networth' && (
        <div className="mn-soon">
          <div className="ov-empty-kicker">Not built yet</div>
          <div className="ov-empty-body">{TABS.find((t) => t.id === tab)?.label} is tracked in Linear and coming in a later pass.</div>
        </div>
      )}
    </div>
  );
}
