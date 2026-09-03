import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import { useAuth } from './AuthContext';

export function useHousehold() {
  const { user } = useAuth();
  const [state, setState] = useState({ loading: true, household: null, members: [], me: null });

  useEffect(() => {
    if (!user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting to signed-out state, not a data fetch
      setState({ loading: false, household: null, members: [], me: null });
      return;
    }
    let cancelled = false;

    (async () => {
      const { data: myRows, error } = await supabase
        .from('household_members')
        .select('id, household_id, display_name, role, user_id, households(id, name)')
        .eq('user_id', user.id)
        .limit(1);

      if (cancelled) return;
      if (error || !myRows?.length) {
        setState({ loading: false, household: null, members: [], me: null });
        return;
      }

      const me = myRows[0];
      const { data: roster } = await supabase
        .from('household_members')
        .select('id, display_name, role, user_id')
        .eq('household_id', me.household_id);

      if (cancelled) return;
      setState({
        loading: false,
        household: { id: me.household_id, name: me.households?.name },
        members: roster ?? [me],
        me,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  return state;
}
