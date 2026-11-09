import { useEffect, useState } from 'react';

// Dubai keeps +04:00 all year (no daylight saving), so the household's day
// turns at 20:00 UTC every day.
const HOUSEHOLD_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Milliseconds from `now` until the next midnight in Dubai.
export function msToNextHouseholdDay(now) {
  const local = now.getTime() + HOUSEHOLD_OFFSET_MS;
  return (Math.floor(local / DAY_MS) + 1) * DAY_MS - local;
}

// "Now" for a screen: fixed while it is on screen, so its figures hold
// still, but moved at the household's day turn and to `refreshedAt` (the
// time its data was last read) when that is later. Screens used to fix it
// when the page opened, so a page left open over midnight, or refreshed in
// the background, went on counting from the day it was opened (outside
// review, E-05). A refresh is read, not stored: setting state on it would
// render again for every new read time a caller hands over.
export function useNow(refreshedAt = null) {
  const [ticked, setTicked] = useState(() => new Date());

  useEffect(() => {
    const timer = setTimeout(() => setTicked(new Date()), msToNextHouseholdDay(ticked) + 1000);
    return () => clearTimeout(timer);
  }, [ticked]);

  return refreshedAt instanceof Date && refreshedAt > ticked ? refreshedAt : ticked;
}
