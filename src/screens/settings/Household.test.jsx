import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

const updates = vi.hoisted(() => []);
// A save waits on `slow.until` when set, to type while it is under way, and
// answers with `slow.error` when that is set.
const slow = vi.hoisted(() => ({ until: null, error: null }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      update: (row) => ({
        eq: async () => {
          updates.push(row);
          if (slow.until) await slow.until;
          return { error: slow.error };
        },
      }),
    }),
  },
}));

const { default: Household } = await import('./Household');

beforeEach(() => {
  updates.length = 0;
  slow.until = null;
  slow.error = null;
});

const ME = { id: 'm1', display_name: 'Alex', role: 'owner', user_id: 'u1', telegram_user_id: 1 };
const PARTNER = { id: 'm2', display_name: 'Sam', role: 'member', user_id: null, telegram_user_id: null };
const HOME = { id: 'h1', name: 'Home', inr_per_aed: 25, inr_rate_set_at: '2026-11-01T02:00:00Z', inr_rate_source: 'auto' };
const view = (household, { members = [ME, PARTNER], me = ME, reload = vi.fn() } = {}) => (
  <MemoryRouter>
    <Household household={household} members={members} me={me} loading={false} reload={reload} />
  </MemoryRouter>
);
const card = () => screen.getByRole('region', { name: 'Household' });
const nameField = () => within(card()).getByLabelText('Name');
const rateField = () => within(card()).getByLabelText('Rupee rate');

// Settings -> Household like the prototype (the revamp, phase 7): the
// household's name and rupee rate in a card, saved when a field is left, and
// the members as a table.
describe('Household: the card', () => {
  it('saves the name when the field is left, and says so', async () => {
    render(view(HOME));
    fireEvent.change(nameField(), { target: { value: 'Our home ' } });
    await act(async () => fireEvent.blur(nameField()));
    expect(updates).toEqual([{ name: 'Our home' }]);
    expect(within(card()).getByText('Saved')).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('saves on Enter too, and nothing when nothing changed', async () => {
    render(view(HOME));
    await act(async () => fireEvent.blur(nameField()));
    expect(updates).toHaveLength(0);
    fireEvent.change(rateField(), { target: { value: '25.5' } });
    await act(async () => fireEvent.keyDown(rateField(), { key: 'Enter' }));
    expect(updates[0]).toMatchObject({ inr_per_aed: 25.5, inr_rate_source: 'manual' });
  });

  it('puts back a rate that is not a figure above zero, and says why', async () => {
    render(view(HOME));
    fireEvent.change(rateField(), { target: { value: '0' } });
    await act(async () => fireEvent.blur(rateField()));
    expect(updates).toHaveLength(0);
    expect(within(card()).getByRole('alert').textContent).toBe('Enter a rate greater than zero.');
    expect(rateField().value).toBe('25');
  });

  it('puts back an empty name rather than saving it', async () => {
    render(view(HOME));
    fireEvent.change(nameField(), { target: { value: '  ' } });
    await act(async () => fireEvent.blur(nameField()));
    expect(updates).toHaveLength(0);
    expect(nameField().value).toBe('Home');
  });

  it('says when the database refuses a save, and puts the field back', async () => {
    slow.error = { message: 'permission denied' };
    render(view(HOME));
    fireEvent.change(nameField(), { target: { value: 'Ours' } });
    await act(async () => fireEvent.blur(nameField()));
    expect(within(card()).getByRole('alert').textContent).toBe('permission denied');
    expect(nameField().value).toBe('Home');
    expect(within(card()).queryByText('Saved')).toBeNull();
  });

  it('says when the rate was last set, and what it is for behind its (i)', () => {
    render(view(HOME));
    expect(within(card()).getByText(/^Updated 1 Nov/)).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'About Rupee rate' })).toBeTruthy();
  });

  it('says so when no rate has been set', () => {
    render(view({ ...HOME, inr_per_aed: null, inr_rate_set_at: null }));
    expect(within(card()).getByText('Not set')).toBeTruthy();
  });

  it('names the build it is running', () => {
    render(view(HOME));
    expect(screen.getByText(/^build /)).toBeTruthy();
  });
});

describe('Household: the members', () => {
  it('lists each member with their role, login and Telegram', () => {
    render(view(HOME));
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).getByText('2 people')).toBeTruthy();
    const rows = within(members).getAllByRole('row').slice(1);
    expect(rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))).toEqual([
      ['AAlexyou', 'Owner', 'Linked', 'Linked'],
      ['SSam', 'Member', 'No login', 'Not linked'],
    ]);
  });

  it('opens a member from their row', () => {
    render(view(HOME));
    fireEvent.click(screen.getByRole('button', { name: 'Sam' }));
    expect(screen.getByRole('dialog', { name: 'Sam' })).toBeTruthy();
  });

  it('offers + Member to an owner, and opens an empty drawer', () => {
    render(view(HOME));
    fireEvent.click(screen.getByRole('button', { name: '+ Member' }));
    expect(screen.getByRole('dialog', { name: 'Add a member' })).toBeTruthy();
  });

  it('says only an owner can add or remove members, to a member', () => {
    const member = { ...PARTNER, user_id: 'u2' };
    render(view(HOME, { members: [ME, member], me: member }));
    expect(screen.queryByRole('button', { name: '+ Member' })).toBeNull();
    expect(screen.getByText('Only an owner can add or remove members.')).toBeTruthy();
  });
});

// Plain render, not renderScreen: a rerender must update this tree, not
// mount a new one.
//
// The outside review, E-07: the household is read again in the background
// (and the rupee rate moves every day). What a member is typing is theirs
// until it is saved; only a field still showing the old value follows.
describe('Household: a refresh while typing', () => {
  it('keeps the name and rate being typed, and updates a field left alone', () => {
    const { rerender } = render(view(HOME));
    fireEvent.change(rateField(), { target: { value: '26.1' } });
    fireEvent.change(nameField(), { target: { value: 'Our home' } });
    rerender(view({ ...HOME, name: 'Home (renamed elsewhere)', inr_per_aed: 25.4 }));
    expect(rateField().value).toBe('26.1');
    expect(nameField().value).toBe('Our home');
  });

  it('follows the household when nothing has been typed', () => {
    const { rerender } = render(view(HOME));
    rerender(view({ ...HOME, name: 'Home (renamed elsewhere)', inr_per_aed: 25.4 }));
    expect(rateField().value).toBe('25.4');
    expect(nameField().value).toBe('Home (renamed elsewhere)');
  });
});

// The fresh review of group 4: a rate saved as typed ("25.80") comes back
// as stored ("25.8"); the field takes the stored form when it saves, so it
// goes on following the household.
describe('Household: after a save', () => {
  it('keeps following the household when the rate was typed with a trailing zero', async () => {
    const { rerender } = render(view(HOME));
    fireEvent.change(rateField(), { target: { value: '25.80' } });
    await act(async () => fireEvent.blur(rateField()));
    expect(updates.at(-1).inr_per_aed).toBe(25.8);
    rerender(view({ ...HOME, inr_per_aed: 25.8 }));
    rerender(view({ ...HOME, inr_per_aed: 26.1 }));
    expect(rateField().value).toBe('26.1');
  });
});

// Round 2 of the outside review, E2-6: a save that took a while set the field
// to what it had sent, over whatever was typed while it was under way.
describe('Household: typing while a save is under way', () => {
  async function typeDuringSave(field, sent, typed) {
    let finish;
    slow.until = new Promise((resolve) => {
      finish = resolve;
    });
    render(view(HOME));
    fireEvent.change(field(), { target: { value: sent } });
    await act(async () => fireEvent.blur(field()));
    fireEvent.change(field(), { target: { value: typed } });
    slow.until = null;
    await act(async () => finish());
    return field().value;
  }

  it('keeps a name typed after it started saving', async () => {
    expect(await typeDuringSave(nameField, 'Our home ', 'Our home, Dubai')).toBe('Our home, Dubai');
  });

  it('keeps a rate typed after it started saving', async () => {
    expect(await typeDuringSave(rateField, '25.80', '26.1')).toBe('26.1');
  });
});
