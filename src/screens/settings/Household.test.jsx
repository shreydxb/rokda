import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { act } from 'react';

const updates = vi.hoisted(() => []);
// A save waits on `slow.until` when set, to type while it is under way.
const slow = vi.hoisted(() => ({ until: null }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      update: (row) => ({
        eq: async () => {
          updates.push(row);
          if (slow.until) await slow.until;
          return { error: null };
        },
      }),
    }),
  },
}));

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

// The fresh review of group 4: a rate saved as typed ("25.80") comes back
// as stored ("25.8"); the field takes the stored form when it saves, so it
// goes on following the household, and Save does not offer to write the
// old rate back over the next day's.
describe('Household: after a save', () => {
  it('keeps following the household when the rate was typed with a trailing zero', async () => {
    const { rerender } = render(view({ id: 'h1', name: 'Home', inr_per_aed: 25 }));
    fireEvent.change(screen.getByLabelText('Rupees per dirham'), { target: { value: '25.80' } });
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]));
    expect(updates.at(-1).inr_per_aed).toBe(25.8);
    rerender(view({ id: 'h1', name: 'Home', inr_per_aed: 25.8 }));
    rerender(view({ id: 'h1', name: 'Home', inr_per_aed: 26.1 }));
    expect(screen.getByLabelText('Rupees per dirham').value).toBe('26.1');
  });
});

// Round 2 of the outside review, E2-6: a save that took a while set the field
// to what it had sent, over whatever was typed while it was under way.
describe('Household: typing while a save is under way', () => {
  async function typeDuringSave(label, saveIndex, sent, typed) {
    let finish;
    slow.until = new Promise((resolve) => {
      finish = resolve;
    });
    render(view({ id: 'h1', name: 'Home', inr_per_aed: 25 }));
    fireEvent.change(screen.getByLabelText(label), { target: { value: sent } });
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[saveIndex]));
    fireEvent.change(screen.getByLabelText(label), { target: { value: typed } });
    slow.until = null;
    await act(async () => finish());
    return screen.getByLabelText(label).value;
  }

  it('keeps a name typed after Save was pressed', async () => {
    expect(await typeDuringSave('Household name', 0, 'Our home ', 'Our home, Dubai')).toBe('Our home, Dubai');
  });

  it('keeps a rate typed after Save was pressed', async () => {
    expect(await typeDuringSave('Rupees per dirham', 1, '25.80', '26.1')).toBe('26.1');
  });
});

// The shell (November 2026): the build id moved here from the sidebar, and
// the long notes on currency and members sit behind their own link.
describe('Household: the build, and fewer words', () => {
  it('names the build it is running, and keeps the notes closed', () => {
    render(view({ id: 'h1', name: 'Home', inr_per_aed: 25 }));
    expect(screen.getByText(/^build /)).toBeTruthy();
    expect(screen.getByText(/Everything is still stored and charged in AED/).closest('details')).toBeTruthy();
    expect(screen.getByText(/A member without a linked login/).closest('details')).toBeTruthy();
  });
});
