import { useEffect } from 'react';

// When records on screen are read again while it is open (product review, 15
// October): every five minutes while the tab is in view, and on coming back
// to the tab or back online once what is shown is more than a minute old.
// The household (useHousehold) and each screen's records (useSources) kept a
// copy each; this is their one schedule (the round 2 cleanup, SHR-383).
//
// `loadedAtRef` holds when the last read landed and `inFlightRef` whether one
// is on its way: coming back to a tab fires visibilitychange and then focus,
// and the second started a whole second read that was thrown away.
// Staleness counts from the last read that landed, so one that failed at
// once, the network still down, is tried again when it comes back.
export const STALE_AFTER_MS = 60 * 1000;
export const REFRESH_EVERY_MS = 5 * 60 * 1000;

export function useBackgroundRefresh({ reload, enabled = true, loadedAtRef, inFlightRef }) {
  useEffect(() => {
    if (!enabled) return undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const refreshIfStale = () => {
      if (!visible() || inFlightRef.current) return;
      const at = loadedAtRef.current;
      if (!at || Date.now() - at.getTime() > STALE_AFTER_MS) reload();
    };
    const tick = () => {
      if (visible()) reload();
    };
    document.addEventListener('visibilitychange', refreshIfStale);
    window.addEventListener('focus', refreshIfStale);
    window.addEventListener('online', refreshIfStale);
    const timer = window.setInterval(tick, REFRESH_EVERY_MS);
    return () => {
      document.removeEventListener('visibilitychange', refreshIfStale);
      window.removeEventListener('focus', refreshIfStale);
      window.removeEventListener('online', refreshIfStale);
      window.clearInterval(timer);
    };
  }, [reload, enabled, loadedAtRef, inFlightRef]);
}
