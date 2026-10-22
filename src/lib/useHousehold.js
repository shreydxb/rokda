import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';

// `forUser` is whose household this is, so a refresh keeps it on screen only
// for the same person.
const EMPTY_STATE = { loading: false, refreshing: false, household: null, members: [], me: null, error: null, notAMember: false, forUser: null };

// One household lookup for the signed-in app. HouseholdProvider
// (HouseholdContext.jsx) loads it around the shell, and every screen inside
// reads that one through useHousehold rather than asking again: each screen
// used to make the same two round trips of its own before any of its reads
// could start. A screen rendered on its own, as in a test, still loads it
// itself.
export const HouseholdContext = createContext(null);

export function useHousehold() {
  const shared = useContext(HouseholdContext);
  const own = useHouseholdLoader(!shared);
  return shared ?? own;
}

export function useHouseholdLoader(enabled = true) {
  // Keyed on the user's id, not the user object. supabase-js hands over a new
  // session object, with a new user inside it, every time it refreshes the
  // token and whenever the tab regains focus (SIGNED_IN). Keyed on the object,
  // each of those reloaded the household, so every screen flashed its loading
  // state for the same person -- and the browser suite, reading the page in
  // that moment, intermittently found Overview blank.
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState({ ...EMPTY_STATE, loading: true });

  // Only the first lookup shows the loading state. A later one (Refresh, Try
  // again) keeps the household on screen and swaps it when the answer lands:
  // flipping back to loading blanked every page to its skeleton, and an open
  // editor, a half-written note included, went with it.
  const reload = useCallback(async () => {
    if (!userId) {
      setState(EMPTY_STATE);
      return;
    }
    const kept = (s) => s.household && s.forUser === userId;
    setState((s) => (kept(s) ? { ...s, refreshing: true } : { ...EMPTY_STATE, loading: true }));

    const { data: myRows, error } = await supabase
      .from('household_members')
      .select('id, household_id, display_name, role, user_id, households(id, name, inr_per_aed, inr_rate_set_at, inr_rate_source)')
      .eq('user_id', userId)
      .limit(1);

    // A failed lookup and "you are not in a household" are different facts and
    // were previously both reported as an empty state (QA-10).
    if (error) {
      // A refresh that fails keeps the household it had and says so; only a
      // first lookup that fails has nothing to show.
      setState((s) => (kept(s) ? { ...s, refreshing: false, error } : { ...EMPTY_STATE, error }));
      return;
    }
    if (!myRows?.length) {
      setState({ ...EMPTY_STATE, notAMember: true });
      return;
    }

    const me = myRows[0];
    const { data: roster, error: rosterError } = await supabase
      .from('household_members')
      .select('id, display_name, role, user_id, telegram_user_id')
      .eq('household_id', me.household_id);

    setState({
      loading: false,
      refreshing: false,
      household: {
        id: me.household_id,
        name: me.households?.name,
        inr_per_aed: me.households?.inr_per_aed ?? null,
        inr_rate_set_at: me.households?.inr_rate_set_at ?? null,
        inr_rate_source: me.households?.inr_rate_source ?? 'manual',
      },
      // Falling back to just yourself would quietly hide a partner. Say the
      // roster failed instead.
      members: rosterError ? [me] : (roster ?? [me]),
      me,
      error: rosterError ?? null,
      notAMember: false,
      forUser: userId,
    });
  }, [userId]);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    reload();
  }, [reload, enabled]);

  return { ...state, reload };
}
