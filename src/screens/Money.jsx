import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { INBOX_COUNT_EVENT } from '../shell/useInboxCount';
import { useTab } from '../lib/useTab';
import { activityHref, monthRange, sharedMonth } from '../lib/activityLink';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
// The Money tabs' shared styles first, so each tab's own stylesheet, which
// its screen imports, comes after them as it did inside this one.
import './Money.css';
import Activity from './money/Activity';
import Recurring from './money/Recurring';
import Budget from './money/Budget';
import MonthEnd from './money/MonthEnd';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import BackToReview from './BackToReview';
import AedNote from './AedNote';
import TabRow from './TabRow';
import { ToolsSlot } from './money/MoneyTools';

const TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'budget', label: 'Budget' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'monthend', label: 'Month end' },
];

export default function Money() {
  const navigate = useNavigate();
  // The tab and Activity's filters are in the address (lib/useTab.js,
  // lib/activityLink.js), so a link from Overview or Budget opens the tab
  // and the records it means, and Back returns to where it came from.
  // Month end took Review's place (the revamp, phase 4d), so an old link to
  // the review opens it.
  const [tab, setTab] = useTab(TABS, TABS[0].id, { review: 'monthend' }, (params) => {
    const month = sharedMonth(params);
    return month ? [['month', month]] : [];
  });
  // Insights is gone (the revamp, phase 4b): its merchants are Activity's
  // Merchants view, so an old link or bookmark opens that, for its month.
  const [params, setParams] = useSearchParams();
  const retiredInsights = params.get('tab') === 'insights';
  // The Inbox is its own page (the revamp, phase 4c), so its old tab opens it.
  const retiredInbox = params.get('tab') === 'inbox';
  useEffect(() => {
    if (retiredInbox) navigate('/inbox', { replace: true });
  }, [retiredInbox, navigate]);
  useEffect(() => {
    if (!retiredInsights) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams({ tab: 'activity', view: 'merchants' });
        if (prev.get('month')) next.set('month', prev.get('month'));
        return next;
      },
      { replace: true },
    );
  }, [retiredInsights, setParams]);
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;
  const pendingIntake = data.intake?.filter((i) => i.status === 'pending').length ?? 0;
  // The sidebar shows the same count (the revamp, review N1). Say it after
  // every read here, so an approval moves it at once and the sidebar settles
  // on this figure rather than an older one of its own. Not while loading,
  // nor after a failed read, when the count here is not known.
  const intakeKnown = !data.loading && !data.errors?.intake;
  const readAt = data.loadedAt?.getTime?.() ?? null;
  useEffect(() => {
    if (intakeKnown) window.dispatchEvent(new CustomEvent(INBOX_COUNT_EVENT, { detail: pendingIntake }));
  }, [intakeKnown, pendingIntake, readAt]);
  // Refresh and Try again read everything the tabs show.
  const reloadAll = async () => {
    await Promise.all([reloadHousehold(), data.reload()]);
  };

  // The header's slot for the open tab's own controls (money/MoneyTools.jsx).
  const [toolsNode, setToolsNode] = useState(null);

  return (
    <div className="mn">
      <Freshness title="Money" tools={<span className="mn-tools" ref={setToolsNode} />} loadedAt={data.loadedAt} refreshing={data.refreshing} onRefresh={reloadAll} />
      <ToolsSlot node={toolsNode}>
      <AedNote household={household} />
      <LoadFailure
        errors={{ ...data.errors, ...(householdError ? { household: householdError } : {}) }}
        loadedAt={data.loadedAt}
        onRetry={reloadAll}
      />
      <BackToReview />
      <TabRow
        tabs={TABS}
        active={tab}
        onChange={setTab}
      />

      {tab === 'activity' && (
        <Activity
          household={household}
          members={members}
          me={me}
          data={data}
          loading={loading}
        />
      )}
      {tab === 'recurring' && <Recurring household={household} members={members} me={me} data={data} loading={loading} />}
      {tab === 'budget' && (
        <Budget
          household={household}
          members={members}
          me={me}
          data={data}
          loading={loading}
          onOpenRecords={({ categoryId, year, month }) => navigate(activityHref({ categoryId, ...monthRange(year, month) }))}
        />
      )}
      {tab === 'monthend' && <MonthEnd household={household} members={members} me={me} data={data} loading={loading} />}
      </ToolsSlot>
    </div>
  );
}
