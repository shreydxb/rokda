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
    maybeSingle: () => Promise.resolve(result()),
    then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}
vi.mock('../lib/supabaseClient', () => ({ supabase: { from: (table) => builder(table) } }));

const { useOverviewData } = await import('./useOverviewData');
const { anyFailed, failedSources, failureMessage } = await import('../lib/loadState');

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
