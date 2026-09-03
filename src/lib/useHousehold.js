import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';

const EMPTY_STATE = { loading: false, household: null, members: [], me: null };

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
      .select('id, household_id, display_name, role, user_id, households(id, name)')
      .eq('user_id', user.id)
      .limit(1);

    if (error || !myRows?.length) {
      setState(EMPTY_STATE);
      return;
    }

    const me = myRows[0];
    const { data: roster } = await supabase
      .from('household_members')
      .select('id, display_name, role, user_id')
      .eq('household_id', me.household_id);

    setState({
      loading: false,
      household: { id: me.household_id, name: me.households?.name },
      members: roster ?? [me],
      me,
    });
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off an async fetch; loading flag is the point
    reload();
  }, [reload]);

  return { ...state, reload };
}
