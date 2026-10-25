import { useSearchParams } from 'react-router-dom';

// A screen's tab, kept in the address (`?tab=recurring`) so a link can open
// the tab it means, and Back returns to the tab you came from. Switching tabs
// adds a history entry and drops the previous tab's filters; an unknown tab
// falls back to the first. `aliases` maps a tab that has gone to the one that
// took its place, so an old link or bookmark still lands somewhere sensible.
export function useTab(tabs, fallback = tabs[0].id, aliases = {}) {
  const [params, setParams] = useSearchParams();
  const asked = aliases[params.get('tab')] ?? params.get('tab');
  const tab = tabs.some((t) => t.id === asked) ? asked : fallback;
  const setTab = (id) => setParams(id === fallback ? {} : { tab: id });
  return [tab, setTab];
}
