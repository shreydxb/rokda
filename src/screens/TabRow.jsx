import { useLayoutEffect, useRef, useState } from 'react';

// A screen's tabs in one row. On a phone the row scrolls sideways inside
// itself instead of wrapping (Planning's seven tabs took two rows, Money's
// left "Review" alone on the second), and the open tab is brought into view,
// so a link to the last tab doesn't land with it out of sight. While more
// tabs are off to the right the row fades at that edge. The open tab says so
// to a screen reader too (aria-current), not only by its underline.
export default function TabRow({ tabs, active, onChange }) {
  const ref = useRef(null);
  const [more, setMore] = useState(false);
  // Labels change after the row first lays out (Money's "Inbox (2)" once the
  // queue loads, and the web font once it arrives), so the open tab is
  // brought into view again whenever they or the row's width change.
  const labels = tabs.map((t) => t.label).join('|');
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return undefined;
    const update = () => setMore(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    const bring = () => {
      const tab = row.querySelector('[data-active="true"]');
      if (tab && row.scrollWidth > row.clientWidth) {
        const r = row.getBoundingClientRect();
        const t = tab.getBoundingClientRect();
        if (t.left < r.left) row.scrollLeft += t.left - r.left - 16;
        else if (t.right > r.right) row.scrollLeft += t.right - r.right + 16;
      }
      update();
    };
    let live = true;
    bring();
    row.addEventListener('scroll', update, { passive: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(bring);
    resized?.observe(row);
    document.fonts?.ready?.then(() => live && bring());
    return () => {
      live = false;
      row.removeEventListener('scroll', update);
      resized?.disconnect();
    };
  }, [active, labels]);
  return (
    <div className="mn-tabs" ref={ref} data-more={more}>
      {tabs.map((t) => (
        <button key={t.id} type="button" className="om-tab" data-active={active === t.id} aria-current={active === t.id ? 'page' : undefined} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
