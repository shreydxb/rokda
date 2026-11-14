import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { INBOX_COUNT_EVENT } from '../shell/useInboxCount';
import { useTab } from '../lib/useTab';
import { activityHref, monthRange } from '../lib/activityLink';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
// The Money tabs' shared styles first, so each tab's own stylesheet, which
// its screen imports, comes after them as it did inside this one.
import './Money.css';
import Activity from './money/Activity';
import Recurring from './money/Recurring';
import Budget from './money/Budget';
import Insights from './money/Insights';
import Inbox from './money/Inbox';
import Review from './money/Review';
import LoadFailure from './LoadFailure';
import Freshness from './Freshness';
import { usePlanningData } from './usePlanningData';
import BackToReview from './BackToReview';
import AedNote from './AedNote';
import TabRow from './TabRow';

const TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'budget', label: 'Budget' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'insights', label: 'Insights' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'review', label: 'Review' },
];

export default function Money() {
  const navigate = useNavigate();
  // The tab and Activity's filters are in the address (lib/useTab.js,
  // lib/activityLink.js), so a link from Overview or Insights opens the tab
  // and the records it means, and Back returns to where it came from.
  const [tab, setTab] = useTab(TABS);
  const { household, members, me, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  // The review's goal action needs the goals; nothing else here does, so they
  // are read only while the review is open.
  const planning = usePlanningData(tab === 'review' ? household?.id : null);
  const loading = householdLoading || data.loading || (tab === 'review' && planning.loading);
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
  // Refresh and Try again read everything this tab shows, the review's goals
  // and plan included: those were reported as failed and never read again
  // (round 2 of the outside review, E2-9).
  const reloadAll = async () => {
    await Promise.all([reloadHousehold(), data.reload(), ...(tab === 'review' ? [planning.reload()] : [])]);
  };

  return (
    <div className="mn">
      <Freshness
        title="Money"
        loadedAt={data.loadedAt}
        refreshing={data.refreshing}
        onRefresh={reloadAll}
      />
      <AedNote household={household} />
      <LoadFailure
        errors={{ ...data.errors, ...(tab === 'review' ? planning.errors : {}), ...(householdError ? { household: householdError } : {}) }}
        loadedAt={data.loadedAt}
        onRetry={reloadAll}
      />
      <BackToReview />
      <TabRow
        tabs={TABS.map((t) => (t.id === 'inbox' && pendingIntake > 0 ? { ...t, label: `${t.label} (${pendingIntake})` } : t))}
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
      {tab === 'recurring' && <Recurring household={household} members={members} data={data} loading={loading} />}
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
      {tab === 'insights' && (
        <Insights
          me={me}
          members={members}
          data={data}
          loading={loading}
          onDrillIntoActivity={(filters) => navigate(activityHref(filters))}
        />
      )}
      {tab === 'inbox' && (
        <Inbox household={household} members={members} accounts={data.accounts} categories={data.categories} data={data} loading={loading} />
      )}
      {tab === 'review' && <Review household={household} data={data} planning={planning} loading={loading} />}
    </div>
  );
}
