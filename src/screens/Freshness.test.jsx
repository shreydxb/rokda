import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Freshness from './Freshness';
import { loadedLabel } from '../lib/freshness';

describe('loadedLabel', () => {
  const now = new Date(2026, 9, 15, 16, 0);
  it('gives the time for a read today and the date as well for an older one', () => {
    expect(loadedLabel(new Date(2026, 9, 15, 14, 32), now)).toBe('Loaded 14:32');
    expect(loadedLabel(new Date(2026, 9, 14, 9, 5), now)).toBe('Loaded 14 Oct, 09:05');
    expect(loadedLabel(null, now)).toBeNull();
  });
});

describe('Freshness', () => {
  it('says when the page was read and reads it again on request', () => {
    const onRefresh = vi.fn();
    render(<Freshness title="Money" loadedAt={new Date()} refreshing={false} onRefresh={onRefresh} />);
    expect(screen.getByText(/^Loaded \d{2}:\d{2}/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('says it is refreshing, and does not offer a second refresh meanwhile', () => {
    render(<Freshness title="Money" loadedAt={new Date()} refreshing onRefresh={() => {}} />);
    expect(screen.getByText(/Refreshing…/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' }).disabled).toBe(true);
  });
});
