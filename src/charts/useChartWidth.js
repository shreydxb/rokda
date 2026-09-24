import { useLayoutEffect, useRef, useState } from 'react';

// Charts draw at the pixel width they are given rather than stretching a
// fixed viewBox: stretching distorts text and makes a 2px line 5px wide on a
// laptop and 1px on a phone. jsdom has no layout, so tests get the fallback.
export function useChartWidth(fallback = 640) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
