import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { msToNextHouseholdDay, useNow } from './useNow';

afterEach(() => {
  vi.useRealTimers();
});

// The outside review, E-05: screens fixed "today" when the page opened, so a
// page left open over midnight, or refreshed in the background, went on
// counting from the day before. useNow moves at the household's day turn
// and with each refresh.
describe('useNow', () => {
  it('moves at the household day turn (midnight in Dubai), not before', () => {
    vi.useFakeTimers();
    // 23:59:30 in Dubai on 8 November.
    vi.setSystemTime(new Date('2026-11-08T19:59:30Z'));
    const { result } = renderHook(() => useNow());
    const opened = result.current;
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current).toBe(opened);
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.toISOString() > '2026-11-08T20:00:00.000Z').toBe(true);
  });

  it('moves when the data it is given is read again', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T08:00:00Z'));
    const { result, rerender } = renderHook(({ at }) => useNow(at), { initialProps: { at: new Date('2026-11-08T08:00:00Z') } });
    const opened = result.current;
    vi.setSystemTime(new Date('2026-11-08T08:05:00Z'));
    rerender({ at: new Date('2026-11-08T08:05:00Z') });
    expect(result.current).not.toBe(opened);
    expect(result.current.toISOString()).toBe('2026-11-08T08:05:00.000Z');
  });

  it('counts the time to the next midnight in Dubai', () => {
    expect(msToNextHouseholdDay(new Date('2026-11-08T19:59:30Z'))).toBe(30_000);
    expect(msToNextHouseholdDay(new Date('2026-11-08T20:00:00Z'))).toBe(86_400_000);
  });
});
