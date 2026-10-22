import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';

// A tiny stand-in for the Supabase query builder: every chained method returns
// the builder, and awaiting it resolves to whatever this table is configured
// to return.
const responses = new Map();
function builder(table) {
  const result = () => responses.get(table) ?? { data: [], error: null };
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    range: () => Promise.resolve(result()),
    maybeSingle: () => Promise.resolve(result()),
    then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}
// Every table read, in order, to count reads.
const reads = [];
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => {
      reads.push(table);
      return builder(table);
    },
  },
}));

const { useOverviewData, usePlanningInputs, PLANNING_INPUT_KEYS } = await import('./useOverviewData');
const { anyFailed, failedSources, failureMessage, neverLoaded } = await import('../lib/loadState');

const HOLDING = { id: 'h1', name: 'VWRA', value_aed: 10_000, is_shared: true };

// QA-10 / SHR-251: hooks turned a failed query into an empty array, so a failed
// holdings fetch looked exactly like "no investments".
describe('QA-10: a failed load is not an empty one', () => {
  beforeEach(() => {
    responses.clear();
  });

  it('reports the failing source instead of returning an empty list', async () => {
    responses.set('holdings', { data: null, error: { message: 'network error' } });
    const { result } = renderHook(() => useOverviewData('household-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(failedSources(result.current.errors)).toEqual(['holdings']);
    expect(failureMessage(result.current.errors)).toContain('investments');
    expect(anyFailed(result.current.errors, ['accounts', 'holdings'])).toBe(true);
  });

  it('leaves sources that did load alone', async () => {
    responses.set('holdings', { data: null, error: { message: 'network error' } });
    responses.set('accounts', { data: [{ id: 'a1', name: 'ADCB', type: 'savings', balance: 50 }], error: null });
    const { result } = renderHook(() => useOverviewData('household-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.accounts).toHaveLength(1);
    expect(result.current.errors.accounts).toBeUndefined();
  });

  it('keeps the last known values rather than blanking them on a later failure', async () => {
    responses.set('holdings', { data: [HOLDING], error: null });
    const { result } = renderHook(() => useOverviewData('household-1'));
    await waitFor(() => expect(result.current.holdings).toHaveLength(1));
    const firstLoadedAt = result.current.loadedAt;

    responses.set('holdings', { data: null, error: { message: 'gone' } });
    await act(async () => {
      await result.current.reload();
    });

    // Still shown — but flagged, and the "as of" timestamp does not move for
    // the failed source.
    expect(result.current.holdings).toHaveLength(1);
    expect(result.current.errors.holdings).toBeTruthy();
    expect(result.current.loadedAt).not.toBe(firstLoadedAt);
  });

  it('recovers cleanly when the request succeeds again', async () => {
    responses.set('holdings', { data: null, error: { message: 'network error' } });
    const { result } = renderHook(() => useOverviewData('household-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errors.holdings).toBeTruthy();

    responses.set('holdings', { data: [HOLDING], error: null });
    await act(async () => {
      await result.current.reload();
    });

    expect(failedSources(result.current.errors)).toEqual([]);
    expect(result.current.holdings).toHaveLength(1);
  });

  it('distinguishes a genuine empty result from a failure', async () => {
    responses.set('holdings', { data: [], error: null });
    const { result } = renderHook(() => useOverviewData('household-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.holdings).toEqual([]);
    expect(failedSources(result.current.errors)).toEqual([]);
  });
});

// Product review, 15 October: an open page never saw a change made elsewhere.
describe('keeping an open page fresh', () => {
  beforeEach(() => {
    responses.clear();
  });

  it('reads again in the background after the first load, keeping the figures on screen', async () => {
    responses.set('accounts', { data: [{ id: 'a1' }], error: null });
    const { result } = renderHook(() => useOverviewData('household-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    responses.set('accounts', { data: [{ id: 'a1' }, { id: 'a2' }], error: null });
    let pending;
    act(() => {
      pending = result.current.reload();
    });
    // No skeleton: the old figures stay while the new ones load.
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.accounts).toHaveLength(1);
    await act(() => pending);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.accounts).toHaveLength(2);
  });

  it('reads again when the tab comes back into view after more than a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 15, 12, 0));
      responses.set('accounts', { data: [{ id: 'a1' }], error: null });
      const { result } = renderHook(() => useOverviewData('household-1'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      responses.set('accounts', { data: [{ id: 'a1' }, { id: 'a2' }], error: null });
      // Within the minute: nothing new is read.
      vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 30));
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(result.current.refreshing).toBe(false);

      vi.setSystemTime(new Date(2026, 9, 15, 12, 2));
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => expect(result.current.accounts).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reading only what is needed, once', () => {
  beforeEach(() => {
    responses.clear();
    reads.length = 0;
  });

  it('reads once when the tab comes back, though visibilitychange and focus both fire', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 15, 12, 0));
      const { result } = renderHook(() => useOverviewData('household-1'));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const accountReads = () => reads.filter((table) => table === 'accounts').length;
      expect(accountReads()).toBe(1);

      vi.setSystemTime(new Date(2026, 9, 15, 12, 2));
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(result.current.refreshing).toBe(false));
      expect(accountReads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the sources that have loaded, so one that never did is not shown as none', async () => {
    responses.set('holdings', { data: null, error: { message: 'network error' } });
    const { result } = renderHook(() => useOverviewData('household-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(neverLoaded(result.current, ['accounts', 'holdings'])).toEqual(['holdings']);

    // Once loaded, a later failure keeps the last records, which are still real.
    responses.set('holdings', { data: [HOLDING], error: null });
    await act(() => result.current.reload());
    responses.set('holdings', { data: null, error: { message: 'network error' } });
    await act(() => result.current.reload());
    expect(result.current.errors.holdings).toBeTruthy();
    expect(result.current.holdings).toHaveLength(1);
    expect(neverLoaded(result.current, ['accounts', 'holdings'])).toEqual([]);
  });

  it('Planning reads only the six tables its tabs use', async () => {
    const { result } = renderHook(() => usePlanningInputs('household-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect([...new Set(reads)].sort()).toEqual(['accounts', 'budgets', 'categories', 'holdings', 'recurring', 'transactions']);
    expect(PLANNING_INPUT_KEYS).toHaveLength(6);
  });
});
