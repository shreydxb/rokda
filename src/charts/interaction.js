import { nearestIndex } from './scale';

// How every chart answers the keyboard and the pointer: the arrow keys, Home
// and End move the pick once the chart has focus; hover or touch picks the
// nearest column or point. Shared by src/charts/Charts.jsx and the kit's
// charts (src/design-system/charts.jsx).
export function handleKey(e, activeIndex, count, onActiveChange) {
  const current = activeIndex ?? count - 1;
  let next = null;
  if (e.key === 'ArrowLeft') next = Math.max(0, current - 1);
  else if (e.key === 'ArrowRight') next = Math.min(count - 1, current + 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = count - 1;
  if (next !== null) {
    e.preventDefault();
    onActiveChange(next);
  }
}

export function pointerHandlers(count, onActiveChange) {
  const pick = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = nearestIndex(e.clientX - box.left, box.width, count);
    if (i !== null) onActiveChange(i);
  };
  return {
    onPointerMove: pick,
    onPointerDown: pick,
    // A mouse leaving the plot hands the pick back to the screen's default;
    // a finger lifting does not, or the readout would vanish mid-read.
    onPointerLeave: (e) => {
      if (e.pointerType === 'mouse') onActiveChange(null);
    },
  };
}

