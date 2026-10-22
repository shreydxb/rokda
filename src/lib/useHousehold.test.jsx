import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, screen, act } from '@testing-library/react';
import { useHousehold } from './useHousehold';
import { HouseholdProvider } from './HouseholdContext';

// The signed-in user, swappable by the test, and every household lookup made.
const auth = vi.hoisted(() => ({ user: { id: 'u1' }, lookups: 0, fail: false }));

vi.mock('./AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));

vi.mock('./supabaseClient', () => {
  const rows = (table) => (table === 'household_members' ? [{ id: 'm1', household_id: 'h1', display_name: 'Alex', role: 'owner', user_id: 'u1', households: { id: 'h1', name: 'Home' } }] : []);
  const query = (table) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      limit: () => {
        auth.lookups += 1;
        return Promise.resolve(auth.fail ? { data: null, error: { message: 'network error' } } : { data: rows(table), error: null });
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

    // A different person signing in does reload, and is not shown the first
    // person's household while theirs loads.
    auth.user = { id: 'u2' };
    rerender(<Probe />);
    expect(screen.getByTestId('state').textContent).toBe('loading');
    await act(async () => {});
    expect(auth.lookups).toBe(2);
  });
});

describe('useHousehold: refreshing, and one lookup for the app', () => {
  it('keeps the household on screen while it is looked up again', async () => {
    auth.user = { id: 'u1' };
    auth.fail = false;
    const { result } = renderHook(() => useHousehold());
    await act(async () => {});
    expect(result.current.household?.name).toBe('Home');

    let pending;
    act(() => {
      pending = result.current.reload();
    });
    // Back to `loading` would blank every page to its skeleton, and an open
    // editor with it.
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.household?.name).toBe('Home');
    await act(() => pending);
    expect(result.current.refreshing).toBe(false);
  });

  it('keeps the household when a refresh fails, and says it failed', async () => {
    auth.user = { id: 'u1' };
    auth.fail = false;
    const { result } = renderHook(() => useHousehold());
    await act(async () => {});
    auth.fail = true;
    await act(() => result.current.reload());
    expect(result.current.household?.name).toBe('Home');
    expect(result.current.error?.message).toBe('network error');
    auth.fail = false;
  });

  it('looks the household up once for every screen inside the provider', async () => {
    auth.user = { id: 'u1' };
    auth.fail = false;
    const before = auth.lookups;
    render(
      <HouseholdProvider>
        <Probe />
        <Probe />
      </HouseholdProvider>,
    );
    await act(async () => {});
    expect(screen.getAllByTestId('state').map((el) => el.textContent)).toEqual(['Home', 'Home']);
    expect(auth.lookups - before).toBe(1);
  });

  it('is looked up again when the tab comes back after more than a minute, not sooner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
      auth.user = { id: 'u1' };
      auth.fail = false;
      const before = auth.lookups;
      const { result } = renderHook(() => useHousehold());
      await act(async () => {});
      expect(auth.lookups - before).toBe(1);

      vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 30));
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(auth.lookups - before).toBe(1);

      vi.setSystemTime(new Date(2026, 9, 15, 12, 2, 0));
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      expect(auth.lookups - before).toBe(2);
      expect(result.current.household?.name).toBe('Home');
    } finally {
      vi.useRealTimers();
    }
  });
});
