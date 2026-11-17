import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import DebtEditor from './DebtEditor';

// A debt opened through the address, `?debt={id}` (the revamp, phase 6b;
// design/prototype open-debt), from Goals & debts' table and its "Link
// account"; `?debt=new` adds one. Drawn over whichever Planning tab is open,
// as the goal drawer is.

const NONE = [];

export default function DebtDrawer({ household, members = NONE, accounts = NONE, data, onAccountsChanged }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const id = params.get('debt');
  const debts = data?.debts ?? NONE;
  const current = id && id !== 'new' ? (debts.find((d) => d.id === id) ?? null) : null;
  // Closing at once, before the page reads its data again (GoalDrawer).
  const [closedFor, setClosedFor] = useState(null);
  if (closedFor && closedFor !== id) setClosedFor(null);
  if (!id || closedFor === id) return null;
  if (id !== 'new' && !current) return null;

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
        p.delete('debt');
        return p;
      },
      { replace: true },
    );
  };

  return (
    <DebtEditor
      key={id}
      debt={current}
      householdId={household?.id}
      members={members}
      accounts={accounts}
      debts={debts}
      onClose={close}
      onSaved={async () => {
        close();
        // The debt may have made or changed its account, so both reload.
        await Promise.all([data.reload(), onAccountsChanged?.()]);
      }}
    />
  );
}
