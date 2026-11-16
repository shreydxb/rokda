import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTab } from '../lib/useTab';
import { tabHref } from '../lib/activityLink';
import { monthFromParam } from '../lib/useMonthParam';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
// The tabs' shared styles first, so each tab's own stylesheet, which its
// screen imports, comes after them as it did inside this one.
import './Wealth.css';
import NetWorth from './wealth/NetWorth';
import Investments from './wealth/Investments';
import Dividends from './wealth/Dividends';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import BackToReview from './BackToReview';
import TabRow from './TabRow';
import { ToolsSlot } from './PageTools';

const TABS = [
  { id: 'networth', label: 'Net worth' },
  { id: 'investments', label: 'Investments' },
  { id: 'dividends', label: 'Dividends' },
];

export default function Wealth() {
  // In the address, so a link can open Investments or Dividends directly.
  // The accounts are Net worth's ledger (the revamp, phase 5a), so an old
  // link to the Accounts tab opens Net worth.
  const [tab, setTab] = useTab(TABS, TABS[0].id, { accounts: 'networth' });
  // The card statements moved to Money -> Month end (the revamp, phase 4d),
  // so an old link opens it: a month's statements on that month's step 2,
  // otherwise the running month, which lists every statement still open.
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const retiredStatements = params.get('tab') === 'statements';
  const statementsMonth = monthFromParam(params.get('month')) ? params.get('month') : null;
  useEffect(() => {
    if (retiredStatements) navigate(statementsMonth ? tabHref('/money', 'monthend', { month: statementsMonth, step: '2' }) : tabHref('/money', 'monthend'), { replace: true });
  }, [retiredStatements, statementsMonth, navigate]);
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;
  // The header's slot for the open tab's own controls (screens/PageTools.jsx).
  const [toolsNode, setToolsNode] = useState(null);

  return (
    <div className="mn">
      <Freshness
        title="Wealth"
        tools={<span className="mn-tools" ref={setToolsNode} />}
        loadedAt={data.loadedAt}
        refreshing={data.refreshing}
        onRefresh={async () => {
          await Promise.all([reloadHousehold(), data.reload()]);
        }}
      />
      <ToolsSlot node={toolsNode}>
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
      {tab === 'investments' && <Investments household={household} members={members} me={me} data={data} loading={loading} reloadHousehold={reloadHousehold} />}
      {tab === 'dividends' && <Dividends household={household} members={members} me={me} data={data} loading={loading} />}
      </ToolsSlot>
    </div>
  );
}
