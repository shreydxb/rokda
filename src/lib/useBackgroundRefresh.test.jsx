import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { REFRESH_EVERY_MS, STALE_AFTER_MS, useBackgroundRefresh } from './useBackgroundRefresh';

// When a screen's records, and the household, are read again while open: on
// a timer while the tab is in view, and on coming back to a stale tab. One
// schedule for both (the round 2 cleanup, SHR-383).
describe('useBackgroundRefresh', () => {
  let hidden = false;
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = ({ enabled = true, loadedAt = new Date(), inFlight = false } = {}) => {
    const reload = vi.fn();
    const loadedAtRef = { current: loadedAt };
    const inFlightRef = { current: inFlight };
    const hook = renderHook(() => useBackgroundRefresh({ reload, enabled, loadedAtRef, inFlightRef }));
    return { reload, loadedAtRef, inFlightRef, ...hook };
  };

  it('reads again every five minutes while the tab is in view, and not while hidden', () => {
    const { reload } = setup();
    vi.advanceTimersByTime(REFRESH_EVERY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    hidden = true;
    vi.advanceTimersByTime(REFRESH_EVERY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reads again on coming back to the tab, only once what it has is stale', () => {
    const { reload, loadedAtRef } = setup();
    fireEvent.focus(window);
    expect(reload).not.toHaveBeenCalled();
    loadedAtRef.current = new Date(Date.now() - STALE_AFTER_MS - 1);
    fireEvent.focus(window);
    fireEvent(window, new Event('online'));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not start a second read while one is on its way', () => {
    const { reload } = setup({ loadedAt: null, inFlight: true });
    fireEvent(document, new Event('visibilitychange'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('does nothing when switched off, and stops when unmounted', () => {
    const off = setup({ enabled: false, loadedAt: null });
    vi.advanceTimersByTime(REFRESH_EVERY_MS);
    fireEvent.focus(window);
    expect(off.reload).not.toHaveBeenCalled();
    const on = setup({ loadedAt: null });
    on.unmount();
    vi.advanceTimersByTime(REFRESH_EVERY_MS);
    fireEvent.focus(window);
    expect(on.reload).not.toHaveBeenCalled();
  });
});
