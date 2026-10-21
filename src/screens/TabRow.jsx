import { useLayoutEffect, useRef } from 'react';

// A screen's tabs in one row. On a phone the row scrolls sideways inside
// itself instead of wrapping (Planning's seven tabs took two rows, Money's
// left "Review" alone on the second), and the open tab is brought into view,
// so a link to the last tab doesn't land with it out of sight.
export default function TabRow({ tabs, active, onChange }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const row = ref.current;
    const tab = row?.querySelector('[data-active="true"]');
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    const r = row.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < r.left || t.right > r.right) row.scrollLeft += t.left - r.left - 16;
  }, [active]);
  return (
    <div className="mn-tabs" ref={ref}>
      {tabs.map((t) => (
        <button key={t.id} type="button" className="om-tab" data-active={active === t.id} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
