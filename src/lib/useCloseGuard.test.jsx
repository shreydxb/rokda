import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { useCloseGuard } from './useCloseGuard';

const escape = () => act(() => fireEvent.keyDown(window, { key: 'Escape' }));

// Every editor drawer closes the same way: straight away when nothing was
// changed; with "Discard changes?" first when something was, and a second
// Escape or Discard then closes it.
describe('useCloseGuard', () => {
  it('closes at once when nothing was changed, by Escape or by asking', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useCloseGuard({ dirty: false, onClose }));
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => result.current.requestClose());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(result.current.confirmingClose).toBe(false);
  });

  it('asks first when something was changed, and a second Escape discards', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useCloseGuard({ dirty: true, onClose }));
    escape();
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.confirmingClose).toBe(true);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('goes back to editing, and asks again next time', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useCloseGuard({ dirty: true, onClose }));
    act(() => result.current.requestClose());
    act(() => result.current.keepEditing());
    expect(result.current.confirmingClose).toBe(false);
    act(() => result.current.requestClose());
    expect(result.current.confirmingClose).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reads the latest changes, not those when the drawer opened', () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(({ dirty }) => useCloseGuard({ dirty, onClose }), { initialProps: { dirty: false } });
    rerender({ dirty: true });
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hands Escape to the editor when it has something to step back from first', () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    renderHook(() => useCloseGuard({ dirty: false, onClose, onEscape }));
    escape();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops listening once the drawer is gone', () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useCloseGuard({ dirty: false, onClose }));
    unmount();
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });
});
