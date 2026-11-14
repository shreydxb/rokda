import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const calls = [];
let rows = [];
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
        return Promise.resolve({ data: rows, error: null });
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
});

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
});
