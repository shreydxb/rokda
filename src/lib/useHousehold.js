import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';

const EMPTY_STATE = { loading: false, household: null, members: [], me: null, error: null, notAMember: false };

export function useHousehold() {
  const { user } = useAuth();
  const [state, setState] = useState({ ...EMPTY_STATE, loading: true });

  const reload = useCallback(async () => {
    if (!user) {
      setState(EMPTY_STATE);
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    const { data: myRows, error } = await supabase
      .from('household_members')
      .select('id, household_id, display_name, role, user_id, households(id, name, inr_per_aed, inr_rate_set_at)')
      .eq('user_id', user.id)
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
      .select('id, display_name, role, user_id')
      .eq('household_id', me.household_id);

    setState({
      loading: false,
      household: {
        id: me.household_id,
        name: me.households?.name,
        inr_per_aed: me.households?.inr_per_aed ?? null,
        inr_rate_set_at: me.households?.inr_rate_set_at ?? null,
      },
      // Falling back to just yourself would quietly hide a partner. Say the
      // roster failed instead.
      members: rosterError ? [me] : (roster ?? [me]),
      me,
      error: rosterError ?? null,
      notAMember: false,
    });
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    reload();
  }, [reload]);

  return { ...state, reload };
}
