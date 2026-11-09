import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const { default: Household } = await import('./Household');

const ME = { id: 'm1', display_name: 'Partner A', role: 'owner', user_id: 'u1' };
const view = (household) => <Household household={household} members={[ME]} me={ME} loading={false} reload={vi.fn()} />;

// Plain render, not renderScreen: a rerender must update this tree, not
// mount a new one.
//
// The outside review, E-07: the household is read again in the background
// (and the rupee rate moves every day). What a member is typing is theirs
// until they save it; only a field still showing the old value follows.
describe('Household: a refresh while typing', () => {
  it('keeps the name and rate being typed, and updates a field left alone', () => {
    const { rerender } = render(view({ id: 'h1', name: 'Home', inr_per_aed: 25 }));
    fireEvent.change(screen.getByLabelText('Rupees per dirham'), { target: { value: '26.1' } });
    fireEvent.change(screen.getByLabelText('Household name'), { target: { value: 'Our home' } });

    rerender(view({ id: 'h1', name: 'Home (renamed elsewhere)', inr_per_aed: 25.4 }));
    expect(screen.getByLabelText('Rupees per dirham').value).toBe('26.1');
    expect(screen.getByLabelText('Household name').value).toBe('Our home');
  });

  it('follows the household when nothing has been typed', () => {
    const { rerender } = render(view({ id: 'h1', name: 'Home', inr_per_aed: 25 }));
    rerender(view({ id: 'h1', name: 'Home (renamed elsewhere)', inr_per_aed: 25.4 }));
    expect(screen.getByLabelText('Rupees per dirham').value).toBe('25.4');
    expect(screen.getByLabelText('Household name').value).toBe('Home (renamed elsewhere)');
  });
});
