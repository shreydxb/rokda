import { useCallback, useEffect, useRef, useState } from 'react';

// Loading a screen's records, and keeping them fresh while it is open.
//
// One entry per source, failures reported per source rather than collapsed
// into one flag (QA-10), and a source that fails keeps what it last had rather
// than turning into an empty list.
//
// Fresh (product review, 15 October): the screens read once, on opening, and
// after a save of their own. A change made by the bot or the other member
// stayed invisible until a reload by hand. Now the records are read again:
//   - when the tab comes back into view or the browser comes back online,
//     if they are more than a minute old;
//   - every five minutes while the tab is in view;
//   - when "Refresh" is pressed.
// Only the first load shows the skeleton. Every later one, including the one
// after a save, keeps the figures on screen and swaps them when the new ones
// arrive, so an open editor and its unsaved input are left alone.
export const STALE_AFTER_MS = 60 * 1000;
export const REFRESH_EVERY_MS = 5 * 60 * 1000;

export function useSources(householdId, sources, emptyState) {
  const [state, setState] = useState({ ...emptyState, loading: true, refreshing: false, loaded: {} });
  // Only the newest read may land: a slow earlier one must not overwrite it.
  const latest = useRef(0);
  const loadedAtRef = useRef(null);
  const inFlightRef = useRef(false);
  // Whether a read has finished at all, even one where every source failed:
  // after that, a read keeps the page on screen rather than showing the
  // skeleton, which unmounted whatever editor was open.
  const attemptedRef = useRef(false);

  const reload = useCallback(async () => {
    if (!householdId) {
      attemptedRef.current = false;
      setState({ ...emptyState, refreshing: false, loaded: {} });
      return;
    }
    const ticket = ++latest.current;
    inFlightRef.current = true;
    setState((s) => (attemptedRef.current ? { ...s, refreshing: true } : { ...s, loading: true }));

    const results = await Promise.all(sources.map((source) => source.run(householdId)));
    if (ticket !== latest.current) return;
    inFlightRef.current = false;
    attemptedRef.current = true;

    setState((previous) => {
      // `loaded` names every source that has loaded at least once. One that
      // failed before it ever loaded still holds its empty placeholder, which
      // a screen must not show as "you have none" (lib/loadState.js,
      // neverLoaded).
      const next = { loading: false, refreshing: false, errors: {}, loadedAt: previous.loadedAt, loaded: { ...previous.loaded } };
      let anySucceeded = false;
      sources.forEach((source, i) => {
        const { data, error } = results[i];
        if (error) {
          // Keep whatever was last known rather than replacing it with an
          // empty value, which reads as "you have none of these".
          next[source.key] = previous[source.key];
          next.errors[source.key] = error;
        } else {
          next[source.key] = data ?? source.empty ?? [];
          next.loaded[source.key] = true;
          anySucceeded = true;
        }
      });
      if (anySucceeded) next.loadedAt = new Date();
      loadedAtRef.current = next.loadedAt;
      return next;
    });
  }, [householdId, sources, emptyState]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    reload();
  }, [reload]);

  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    // Not while a read is on its way: coming back to a tab fires
    // visibilitychange and then focus, and the second started a whole second
    // read that was then thrown away. Staleness counts from the last read that
    // landed, so one that failed at once, the network still down, is tried
    // again when the browser comes back online.
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
  }, [reload]);

  return { ...state, reload };
}
