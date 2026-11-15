import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

// Each Money tab's own controls sit in the page header beside Refresh, as in
// the prototype (the revamp, phase 4): Activity's month and views, Recurring's
// + Bill. The tab keeps them, with the state they act on, and they are drawn
// into the header's slot. Outside Money (a tab rendered on its own, as its
// tests do) they are drawn where the tab puts them.
const Slot = createContext(undefined);

// `node` is the header's slot once it is on the page, null until then.
export function ToolsSlot({ node, children }) {
  return <Slot.Provider value={node}>{children}</Slot.Provider>;
}

export function Tools({ children }) {
  const node = useContext(Slot);
  if (node === undefined) return <div className="mn-tools-inline">{children}</div>;
  return node ? createPortal(children, node) : null;
}
