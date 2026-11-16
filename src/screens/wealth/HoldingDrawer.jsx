import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { neverLoaded } from '../../lib/loadState';
import HoldingEditor from './HoldingEditor';

// A holding opened through the address, `?holding={id}` (the revamp, phase
// 5b; design/prototype openHolding), from Investments' table or a link on
// another page (To do's Update price, the untagged chip). It opens on its
// details, with its trades and dividends a tab away (`&view=trades` or
// `dividends`); `?holding=new` adds one. Drawn over whichever Wealth tab is
// open, so Dividends can open a holding on its dividends.

const NONE = [];
const VIEWS = ['trades', 'dividends'];

export default function HoldingDrawer({ household, members = [], data }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const id = params.get('holding');
  const holdings = data?.holdings ?? NONE;
  const current = id && id !== 'new' ? (holdings.find((h) => h.id === id) ?? null) : null;
  // The row this address opened. Deleted elsewhere while open, the holding
  // drops out of the next refresh, and with it would go the editor and its
  // draft; it stays open on this row and says so (round 2 of the outside
  // review, E2-5). Forgotten when the address moves on.
  const [opened, setOpened] = useState(null);
  if (current && opened?.id !== current.id) setOpened(current);
  else if (!current && opened && opened.id !== id) setOpened(null);
  // Raised after a trade or dividend saved in the editor has been re-read:
  // the editor is then opened afresh on the holding's new figures. A refresh
  // from anywhere else leaves an open editor, and whatever is typed in it,
  // alone.
  const [generation, setGeneration] = useState(0);
  // The holding this drawer is closing on. A save or a delete closes at once
  // and only then has the page read its data again: closing after the read
  // left Save and Delete live for that second, and a second press saved
  // twice and went back past the page (the fresh review of 5b). Nothing is
  // drawn while the address catches up.
  const [closedFor, setClosedFor] = useState(null);
  if (closedFor && closedFor !== id) setClosedFor(null);
  if (!id || closedFor === id) return null;
  const gone = id !== 'new' && !current && opened?.id === id;
  const holding = id === 'new' ? null : (current ?? (gone ? opened : null));
  if (id !== 'new' && !holding) return null;

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
  // from a link or a reload, the address is replaced (as the account drawer
  // does, the fresh review of 5a).
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
        p.delete('holding');
        p.delete('view');
        return p;
      },
      { replace: true },
    );
  };

  // Trades, rates or dividends that never loaded are placeholders, not data
  // (lib/loadState.js): the editor says so rather than showing none.
  const tradesFailed = neverLoaded(data, ['holdingTrades']).length > 0;
  const dividendsFailed = neverLoaded(data, ['holdingDividends', 'dividendSpecialParts']).length > 0;

  return (
    <HoldingEditor
      key={id === 'new' ? 'new' : `${id}:${generation}`}
      holding={holding}
      gone={gone}
      householdId={household?.id}
      members={members}
      trades={data.holdingTrades ?? NONE}
      tradesFailed={tradesFailed}
      dividends={data.holdingDividends ?? NONE}
      specialParts={data.dividendSpecialParts ?? NONE}
      dividendsFailed={dividendsFailed}
      accounts={data.accounts ?? NONE}
      tab={tab}
      onTab={setTab}
      onClose={close}
      onSaved={async () => {
        close();
        await data.reload();
      }}
      onStale={data.reload}
      onTradesChanged={async () => {
        await data.reload();
        setGeneration((g) => g + 1);
      }}
    />
  );
}
