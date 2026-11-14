import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const calls = [];
let rows = [];
let fail = false;
const pending = [];
vi.mock('../lib/supabaseClient', () => {
  const chain = (table) => {
    const q = { table, filters: [] };
    const api = {
      select: () => api,
      eq: (col, val) => {
        q.filters.push([col, val]);
        return api;
      },
      limit: () => {
        calls.push(q);
        if (pending.hold) return new Promise((resolve) => pending.push(() => resolve({ data: rows, error: null })));
        return Promise.resolve(fail ? { data: null, error: { message: 'network' } } : { data: rows, error: null });
      },
    };
    return api;
  };
  return { supabase: { from: chain } };
});

const { useInboxCount, INBOX_COUNT_EVENT } = await import('./useInboxCount');
const wrapper = ({ children }) => <MemoryRouter>{children}</MemoryRouter>;

beforeEach(() => {
  calls.length = 0;
  rows = [];
  fail = false;
  pending.length = 0;
  pending.hold = false;
});

// Moves the router from inside the hook's tree.
import { useNavigate } from 'react-router-dom';
function useCountAndNavigate(id) {
  return { count: useInboxCount(id), navigate: useNavigate() };
}

// The sidebar's Inbox count (review N1).
describe('useInboxCount', () => {
  it("counts the household's pending items", async () => {
    rows = [{ id: 'a' }, { id: 'b' }];
    const { result } = renderHook(() => useInboxCount('hh'), { wrapper });
    await waitFor(() => expect(result.current).toBe(2));
    expect(calls[0].table).toBe('intake');
    expect(calls[0].filters).toEqual([
      ['household_id', 'hh'],
      ['status', 'pending'],
    ]);
  });

  it('asks nothing before there is a household', () => {
    const { result } = renderHook(() => useInboxCount(null), { wrapper });
    expect(result.current).toBe(0);
    expect(calls).toHaveLength(0);
  });

  // Approving in the Inbox changes the count without leaving the page; the
  // Money screen says so, and the sidebar follows at once.
  it('follows the count the Money screen announces', async () => {
    rows = [{ id: 'a' }, { id: 'b' }];
    const { result } = renderHook(() => useInboxCount('hh'), { wrapper });
    await waitFor(() => expect(result.current).toBe(2));
    act(() => {
      window.dispatchEvent(new CustomEvent(INBOX_COUNT_EVENT, { detail: 1 }));
    });
    expect(result.current).toBe(1);
  });

  // The fresh review of the revamp's shell: Activity writes its search into
  // the address on every keystroke, and each one asked again.
  it('asks again on a move to another screen, not on a change of filter', async () => {
    rows = [{ id: 'a' }];
    const { result } = renderHook(() => useCountAndNavigate('hh'), { wrapper });
    await waitFor(() => expect(result.current.count).toBe(1));
    act(() => result.current.navigate('/?q=c'));
    act(() => result.current.navigate('/?q=co'));
    expect(calls).toHaveLength(1);
    act(() => result.current.navigate('/money'));
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it('keeps the last count when a read fails', async () => {
    rows = [{ id: 'a' }, { id: 'b' }];
    const { result } = renderHook(() => useCountAndNavigate('hh'), { wrapper });
    await waitFor(() => expect(result.current.count).toBe(2));
    fail = true;
    act(() => result.current.navigate('/money'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(result.current.count).toBe(2);
  });

  // A read that set out before Money announced a newer count must not put
  // the older one back.
  it('ignores a read that started before the latest announcement', async () => {
    pending.hold = true;
    rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const { result } = renderHook(() => useInboxCount('hh'), { wrapper });
    act(() => {
      window.dispatchEvent(new CustomEvent(INBOX_COUNT_EVENT, { detail: 1 }));
    });
    expect(result.current).toBe(1);
    await act(async () => {
      pending.splice(0).forEach((resolve) => resolve());
    });
    expect(result.current).toBe(1);
  });

  it("starts from nothing for another household, not the last one's count", async () => {
    rows = [{ id: 'a' }, { id: 'b' }];
    const { result, rerender } = renderHook(({ id }) => useInboxCount(id), { wrapper, initialProps: { id: 'hh' } });
    await waitFor(() => expect(result.current).toBe(2));
    fail = true;
    rerender({ id: 'hh2' });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(result.current).toBe(0);
  });
});
