import { useSearchParams } from 'react-router-dom';

// A screen's tab, kept in the address (`?tab=recurring`) so a link can open
// the tab it means, and Back returns to the tab you came from. Switching tabs
// adds a history entry and drops the previous tab's filters; an unknown tab
// falls back to the first.
export function useTab(tabs, fallback = tabs[0].id) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = tabs.some((t) => t.id === asked) ? asked : fallback;
  const setTab = (id) => setParams(id === fallback ? {} : { tab: id });
  return [tab, setTab];
}
