import { beforeEach, describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { act } from '@testing-library/react';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import Notes from './Notes';

// `stored` is the note's updated_at in the database: an update filtered on an
// older one matches no row, as PostgREST's would after a partner's save.
const calls = vi.hoisted(() => ({ inserts: [], updates: [], deletes: [], stored: null }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.inserts.push({ table, row });
        return { error: null };
      },
      update: (row) => {
        const filters = {};
        const chain = {
          eq: (col, value) => {
            filters[col] = value;
            return chain;
          },
          select: async () => {
            calls.updates.push({ table, row, id: filters.id, updatedAt: filters.updated_at });
            const matches = calls.stored === null || filters.updated_at === calls.stored;
            return { data: matches ? [{ id: filters.id }] : [], error: null };
          },
          // An update awaited without reading back, as Checked today does.
          then: (resolve) => {
            calls.updates.push({ table, row, id: filters.id, updatedAt: filters.updated_at });
            resolve({ error: null });
          },
        };
        return chain;
      },
      delete: () => ({
        eq: async (col, id) => {
          calls.deletes.push({ table, id });
          return { error: null };
        },
      }),
    }),
  },
}));

beforeEach(() => {
  calls.inserts.length = 0;
  calls.updates.length = 0;
  calls.deletes.length = 0;
  calls.stored = null;
});

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
const NOTE = { id: 'n1', title: 'Who pays what', body: '# Split\nShared costs by income.\n\n- **Rent** is shared\n- <b>not markup</b>', position: 1, updated_by: 'm1', updated_at: '2026-09-28T10:00:00Z' };

function renderNotes(notes = [NOTE], sources) {
  const reload = vi.fn().mockResolvedValue(undefined);
  const onRetry = vi.fn();
  renderScreen(<Notes household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} data={{ notes, reload }} sources={sources} onRetry={onRetry} loading={false} />);
  return { reload, onRetry };
}

describe('Notes', () => {
  it('renders headings, bullets and bold, and shows markup as text', () => {
    renderNotes();
    const card = screen.getByLabelText('Who pays what');
    expect(card.querySelector('h3').textContent).toBe('Split');
    expect(card.querySelector('strong').textContent).toBe('Rent');
    expect(card.querySelector('b')).toBeNull();
    expect(card.textContent).toContain('<b>not markup</b>');
    expect(card.textContent).toMatch(/by Alex/);
  });

  it('adds a note with who wrote it', async () => {
    const { reload } = renderNotes([]);
    fireEvent.click(screen.getByText('+ Add note'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Who pays what'), { target: { value: 'Open items' } });
    fireEvent.click(screen.getByText('Add note'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.inserts[0]).toMatchObject({ table: 'household_notes', row: { title: 'Open items', household_id: 'h', updated_by: 'm1' } });
  });

  it('will not save without a title', async () => {
    renderNotes([]);
    fireEvent.click(screen.getByText('+ Add note'));
    fireEvent.click(screen.getByText('Add note'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(calls.inserts).toHaveLength(0);
  });

  it('edits and deletes after a confirm', async () => {
    const { reload } = renderNotes();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(calls.updates).toHaveLength(1));
    expect(calls.updates[0]).toMatchObject({ id: 'n1', updatedAt: NOTE.updated_at });
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText('Delete this note?')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(calls.deletes).toEqual([{ table: 'household_notes', id: 'n1' }]));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('asks before Cancel throws away a changed note, and not when nothing changed', () => {
    renderNotes();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Discard changes?')).toBeNull();
    expect(screen.getByText('Edit')).toBeTruthy();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Who pays what'), { target: { value: 'Who pays what, and why' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    fireEvent.click(screen.getByText('Keep editing'));
    expect(screen.getByPlaceholderText('e.g. Who pays what').value).toBe('Who pays what, and why');
  });

  it('will not save over a note changed since it was opened', async () => {
    const { reload } = renderNotes();
    calls.stored = '2026-09-29T08:00:00Z';
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Who pays what'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/^This note was changed after you opened it/));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('e.g. Who pays what').value).toBe('Mine');
  });

  it('says the notes did not load, rather than that there are none', () => {
    const { onRetry } = renderNotes([], { errors: { notes: { message: 'timeout' } }, loaded: {} });
    expect(screen.queryByText('No notes')).toBeNull();
    expect(screen.getByText('Couldn’t load household notes.')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('saves only over the version it was opened from, though the note is read again while it is open', async () => {
    // The page reads the notes again every few minutes; here that brings in
    // the partner's save while this edit is still open.
    let setNotes;
    function Page() {
      const [notes, set] = useState([NOTE]);
      setNotes = set;
      return <Notes household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} data={{ notes, reload: vi.fn() }} loading={false} />;
    }
    renderScreen(<Page />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Who pays what'), { target: { value: 'Mine' } });

    const theirs = { ...NOTE, body: 'Their text', updated_at: '2026-09-29T08:00:00Z' };
    calls.stored = theirs.updated_at;
    act(() => setNotes([theirs]));
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/^This note was changed after you opened it/));
    expect(calls.updates[0].updatedAt).toBe(NOTE.updated_at);
  });

  it('opens a note again only once the read after its save has landed', async () => {
    let finishReload;
    const reload = vi.fn(() => new Promise((resolve) => (finishReload = resolve)));
    renderScreen(<Notes household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} data={{ notes: [NOTE], reload }} loading={false} />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.getByText('Edit').disabled).toBe(true);
    await act(async () => finishReload());
    expect(screen.getByText('Edit').disabled).toBe(false);
  });
});

// A note checked once a year (Planning audit, 4.18): the editor marks it, and
// the note says where it stands and takes Checked today.
describe('a yearly check', () => {
  it('is marked in the editor and saved with the note', async () => {
    renderNotes([]);
    fireEvent.click(screen.getByRole('button', { name: '+ Add note' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Who pays what'), { target: { value: 'Protection' } });
    const toggle = screen.getByRole('button', { name: /Check once a year/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add note' })));
    expect(calls.inserts[0].row).toMatchObject({ title: 'Protection', check_yearly: true });
  });

  it('says it has not been checked, and Checked today records the household day', async () => {
    const { reload } = renderNotes([{ ...NOTE, check_yearly: true, checked_on: null }]);
    const line = screen.getByText('Checked once a year · not checked yet');
    expect(line.className).toBe('ov-warn');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Checked today' })));
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].row).toEqual({ checked_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), updated_by: 'm1' });
    expect(calls.updates[0].id).toBe('n1');
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('says when it was last checked and when it is next due', () => {
    const lastYear = new Date().getFullYear() - 1;
    renderNotes([{ ...NOTE, check_yearly: true, checked_on: `${lastYear}-01-01` }]);
    expect(screen.getByText(`Checked once a year · last checked 1 Jan ${lastYear} · due now`).className).toBe('ov-warn');
  });

  it('shows nothing of the kind on an ordinary note', () => {
    renderNotes();
    expect(screen.queryByRole('button', { name: 'Checked today' })).toBeNull();
  });
});

