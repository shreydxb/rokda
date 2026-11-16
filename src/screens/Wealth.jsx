import { useEffect } from 'react';
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
import Accounts from './wealth/Accounts';
import Investments from './wealth/Investments';
import Dividends from './wealth/Dividends';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import BackToReview from './BackToReview';
import TabRow from './TabRow';

const TABS = [
  { id: 'networth', label: 'Net worth' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'investments', label: 'Investments' },
  { id: 'dividends', label: 'Dividends' },
];

export default function Wealth() {
  // In the address, so a link can open Accounts or Investments directly.
  const [tab, setTab] = useTab(TABS);
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
      {tab === 'dividends' && <Dividends household={household} members={members} me={me} data={data} loading={loading} />}
    </div>
  );
}
