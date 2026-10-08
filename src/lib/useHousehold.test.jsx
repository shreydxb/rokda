import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useHousehold } from './useHousehold';

// The signed-in user, swappable by the test, and every household lookup made.
const auth = vi.hoisted(() => ({ user: { id: 'u1' }, lookups: 0 }));

vi.mock('./AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));

vi.mock('./supabaseClient', () => {
  const rows = (table) => (table === 'household_members' ? [{ id: 'm1', household_id: 'h1', display_name: 'Alex', role: 'owner', user_id: 'u1', households: { id: 'h1', name: 'Home' } }] : []);
  const query = (table) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      limit: () => {
        auth.lookups += 1;
        return Promise.resolve({ data: rows(table), error: null });
      },
      then: (resolve) => resolve({ data: rows(table), error: null }),
    };
    return chain;
  };
  return { supabase: { from: query } };
});

function Probe() {
  const { loading, household } = useHousehold();
  return <span data-testid="state">{loading ? 'loading' : household?.name ?? 'none'}</span>;
}

describe('useHousehold', () => {
  it('does not reload when the session refreshes for the same person', async () => {
    const { rerender } = render(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('Home');
    expect(auth.lookups).toBe(1);

    // A token refresh, or the tab regaining focus: a new user object, same id.
    auth.user = { id: 'u1' };
    rerender(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('state').textContent).toBe('Home');
    expect(auth.lookups).toBe(1);

    // A different person signing in does reload.
    auth.user = { id: 'u2' };
    rerender(<Probe />);
    await act(async () => {});
    expect(auth.lookups).toBe(2);
  });
});
