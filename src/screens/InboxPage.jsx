import { useEffect, useState } from 'react';
import { INBOX_COUNT_EVENT } from '../shell/useInboxCount';
import { useHousehold } from '../lib/useHousehold';
import { useOverviewData } from './useOverviewData';
import Freshness from './Freshness';
import LoadFailure from './LoadFailure';
import AedNote from './AedNote';
import Inbox from './money/Inbox';
import { ToolsSlot } from './money/MoneyTools';
import './Money.css';

// The Inbox as its own page (the revamp, phase 4c; design/prototype Inbox;
// review S-inbox-1): it is worked every day, so the sidebar names it and it
// no longer sits behind Money's tabs. The title says how many wait; the
// Inbox's own bulk actions sit in the header beside Refresh.
export default function InboxPage() {
  const { household, members, loading: householdLoading, error: householdError, reload: reloadHousehold } = useHousehold();
  const data = useOverviewData(household?.id);
  const loading = householdLoading || data.loading;
  const pending = data.intake?.filter((i) => i.status === 'pending').length ?? 0;
  // The sidebar shows the same count. Say it after every read here, so an
  // approval moves it at once; not while loading, nor after a failed read,
  // when the count here is not known.
  // Known only once the Inbox has been read for a household: before that,
  // or after a failed read, there is no count to give, not 0 (the fresh
  // review of 4c).
  const known = !!household && !data.loading && !data.errors?.intake && !!data.loaded?.intake;
  const readAt = data.loadedAt?.getTime?.() ?? null;
  useEffect(() => {
    if (known) window.dispatchEvent(new CustomEvent(INBOX_COUNT_EVENT, { detail: pending }));
  }, [known, pending, readAt]);
  const reloadAll = async () => {
    await Promise.all([reloadHousehold(), data.reload()]);
  };
  // The header's slot for the Inbox's own controls (money/MoneyTools.jsx).
  const [toolsNode, setToolsNode] = useState(null);

  return (
    <div className="mn ib-page">
      <Freshness
        title={
          <>
            Inbox
            {known && <span className="ib-title-count">{` · ${pending} waiting`}</span>}
          </>
        }
        tools={<span className="mn-tools" ref={setToolsNode} />}
        loadedAt={data.loadedAt}
        refreshing={data.refreshing}
        onRefresh={reloadAll}
      />
      <AedNote household={household} />
      <LoadFailure errors={{ ...data.errors, ...(householdError ? { household: householdError } : {}) }} loadedAt={data.loadedAt} onRetry={reloadAll} />
      <ToolsSlot node={toolsNode}>
        <Inbox household={household} members={members} accounts={data.accounts ?? []} categories={data.categories ?? []} data={data} loading={loading} />
      </ToolsSlot>
    </div>
  );
}
