import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import GoalEditor from './GoalEditor';

// A goal opened through the address, `?goal={id}` (the revamp, phase 6b;
// design/prototype open-goal), from Goals & debts' tables, Plan's "Goals on
// the timeline" or To do's Open goal. It opens on its details, with its
// contributions and linked accounts a tab away (`&view=contributions` or
// `links`); `?goal=new` adds one. Drawn over whichever Planning tab is open,
// as Wealth draws an account or a holding.

const NONE = [];
const VIEWS = ['contributions', 'links'];

export default function GoalDrawer({ household, members = NONE, accounts = NONE, holdings = NONE, data }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const id = params.get('goal');
  const goals = data?.goals ?? NONE;
  const current = id && id !== 'new' ? (goals.find((g) => g.id === id) ?? null) : null;
  // The goal this drawer is closing on. A save or a delete closes at once
  // and only then has the page read its data again, so Save and Delete
  // aren't live for that second (as the holding drawer does, the fresh
  // review of 5b). Nothing is drawn while the address catches up.
  const [closedFor, setClosedFor] = useState(null);
  if (closedFor && closedFor !== id) setClosedFor(null);
  if (!id || closedFor === id) return null;
  if (id !== 'new' && !current) return null;

  const view = params.get('view');
  const tab = VIEWS.includes(view) ? view : 'details';
  const setTab = (next) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'details') p.delete('view');
        else p.set('view', next);
        return p;
      },
      { replace: true, state: location.state },
    );
  // Closing leaves the page as it was under the drawer. Opened from the page
  // (`state.drawer`), it was a step forward, so closing goes back; opened
  // from a link or a reload, the address is replaced.
  const close = () => {
    if (closedFor === id) return;
    setClosedFor(id);
    if (location.state?.drawer) {
      navigate(-1);
      return;
    }
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('goal');
        p.delete('view');
        return p;
      },
      { replace: true },
    );
  };

  return (
    <GoalEditor
      key={id}
      goal={current}
      contributions={current ? (data.goalContributions ?? NONE).filter((c) => c.goal_id === current.id) : NONE}
      allocations={current ? (data.goalAllocations ?? NONE).filter((a) => a.goal_id === current.id) : NONE}
      accounts={accounts}
      holdings={holdings}
      householdId={household?.id}
      members={members}
      tab={tab}
      onTab={setTab}
      onClose={close}
      onSaved={async () => {
        close();
        await data.reload();
      }}
      onChanged={data.reload}
    />
  );
}
