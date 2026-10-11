import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';

const EMPTY_STATE = { loading: false, household: null, members: [], me: null, error: null, notAMember: false };

export function useHousehold() {
  // Keyed on the user's id, not the user object. supabase-js hands over a new
  // session object, with a new user inside it, every time it refreshes the
  // token and whenever the tab regains focus (SIGNED_IN). Keyed on the object,
  // each of those reloaded the household, so every screen flashed its loading
  // state for the same person -- and the browser suite, reading the page in
  // that moment, intermittently found Overview blank.
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState({ ...EMPTY_STATE, loading: true });

  const reload = useCallback(async () => {
    if (!userId) {
      setState(EMPTY_STATE);
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    const { data: myRows, error } = await supabase
      .from('household_members')
      .select('id, household_id, display_name, role, user_id, households(id, name, inr_per_aed, inr_rate_set_at, inr_rate_source)')
      .eq('user_id', userId)
      .limit(1);

    // A failed lookup and "you are not in a household" are different facts and
    // were previously both reported as an empty state (QA-10).
    if (error) {
      setState({ ...EMPTY_STATE, error });
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
    });
  }, [userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    reload();
  }, [reload]);

  return { ...state, reload };
}
