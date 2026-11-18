import { beforeEach, describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { act, render as plainRender } from '@testing-library/react';
import { screen, fireEvent, waitFor, within } from '@testing-library/dom';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { ScopeProvider } from '../../lib/ScopeContext';
import { CurrencyProvider } from '../../lib/CurrencyContext';
import Notes from './Notes';

// Planning -> Notes, like the prototype (the revamp, phase 6c): the list
// beside the chosen note, and a note written in a drawer. What kept writing
// safe stays: a save goes only over the version opened, a note deleted
// elsewhere keeps its draft, and leaving with unsaved text asks first.

// `stored` is the note's updated_at in the database: an update filtered on an
// older one matches no row, as PostgREST's would after a partner's save.
const calls = vi.hoisted(() => ({ inserts: [], updates: [], deletes: [], stored: null }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      // An insert reads back the new row's id, as the screen shows the note
      // it has just added.
      insert: (row) => {
        calls.inserts.push({ table, row });
        return { select: () => ({ single: async () => ({ data: { id: 'new1' }, error: null }) }) };
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
const OTHER = { ...NOTE, id: 'n2', title: 'What is still open', body: 'The car.', position: 2 };

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}
const where = () => screen.getByTestId('where').textContent;

function renderNotes(notes = [NOTE], { sources, at = '/planning?tab=notes', reload = vi.fn().mockResolvedValue(undefined) } = {}) {
  const onRetry = vi.fn();
  renderScreen(
    <MemoryRouter initialEntries={[at]}>
      <Notes household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} data={{ notes, reload }} sources={sources} onRetry={onRetry} loading={false} />
      <Where />
    </MemoryRouter>,
  );
  return { reload, onRetry };
}
// A page whose reload brings in `after(notes)`: what the database holds once
// the save or check has landed.
function renderReloading(notes, after) {
  function Page() {
    const [list, setList] = useState(notes);
    return <Notes household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} data={{ notes: list, reload: async () => setList(after) }} loading={false} />;
  }
  renderScreen(
    <MemoryRouter initialEntries={['/planning?tab=notes']}>
      <Page />
      <Where />
    </MemoryRouter>,
  );
}
// The chosen note, and the list's rows.
const shown = () => document.querySelector('.nt-note');
const listed = () => [...document.querySelectorAll('.nt-row')].map((r) => r.querySelector('.nt-row-title').textContent);
const drawer = () => screen.getByRole('dialog');
const titleField = () => within(drawer()).getByPlaceholderText('e.g. Who pays what');
// The page header's + Note (with no notes, the empty state has one too).
const newNote = () => fireEvent.click(screen.getAllByRole('button', { name: '+ Note' })[0]);

describe('Notes: the list and the note', () => {
  it('lists the notes beside the first, drawn from its markup', () => {
    renderNotes([NOTE, OTHER]);
    expect(listed()).toEqual(['Who pays what', 'What is still open']);
    const note = screen.getByRole('region', { name: 'Who pays what' });
    expect(note.querySelector('h3').textContent).toBe('Split');
    expect(note.querySelector('strong').textContent).toBe('Rent');
    expect(note.querySelector('b')).toBeNull();
    expect(note.textContent).toContain('<b>not markup</b>');
    expect(note.textContent).toMatch(/Updated 28 Sept? 2026 by Alex/);
  });

  it('puts a yearly check that is due first, and shows it first', () => {
    const due = { ...OTHER, id: 'n3', title: 'Protection', check_yearly: true, checked_on: null, position: 3 };
    renderNotes([NOTE, OTHER, due]);
    expect(listed()).toEqual(['Protection', 'Who pays what', 'What is still open']);
    expect(within(document.querySelector('.nt-list')).getByText('Due')).toBeTruthy();
    expect(shown().getAttribute('aria-label')).toBe('Protection');
  });

  it('opens a note from the list through its address, and from the address', () => {
    renderNotes([NOTE, OTHER]);
    fireEvent.click(screen.getByRole('button', { name: /^What is still open/ }));
    expect(where()).toBe('/planning?tab=notes&note=n2');
    expect(shown().getAttribute('aria-label')).toBe('What is still open');
    document.body.innerHTML = '';
    renderNotes([NOTE, OTHER], { at: '/planning?tab=notes&note=n2' });
    expect(shown().getAttribute('aria-label')).toBe('What is still open');
  });

  it('shows the first note for one that isn\'t there', () => {
    renderNotes([NOTE, OTHER], { at: '/planning?tab=notes&note=gone' });
    expect(shown().getAttribute('aria-label')).toBe('Who pays what');
  });

  it('says the notes are private to the household, and offers the first one when there are none', () => {
    renderNotes([]);
    expect(screen.getByText('Private to your household')).toBeTruthy();
    const empty = screen.getByText('No notes yet').closest('section');
    fireEvent.click(within(empty).getByRole('button', { name: '+ Note' }));
    expect(screen.getByRole('dialog', { name: 'Add a note' })).toBeTruthy();
  });

  it('says the notes did not load, rather than that there are none', () => {
    const { onRetry } = renderNotes([], { sources: { errors: { notes: { message: 'timeout' } }, loaded: {} } });
    expect(screen.queryByText('No notes yet')).toBeNull();
    expect(screen.getByText('Couldn’t load household notes.')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('Notes: writing a note', () => {
  it('adds a note with who wrote it', async () => {
    const { reload } = renderNotes([]);
    newNote();
    fireEvent.change(titleField(), { target: { value: 'Open items' } });
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(calls.inserts[0]).toMatchObject({ table: 'household_notes', row: { title: 'Open items', household_id: 'h', updated_by: 'm1' } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // The fresh review of 6c: the new note sat at the end of the list, and the
  // note before it stayed on screen.
  it('shows the note it has just added', async () => {
    const added = { ...OTHER, id: 'new1', title: 'Gamma', body: 'The new one.', position: 3 };
    renderReloading([NOTE, OTHER], [NOTE, OTHER, added]);
    newNote();
    fireEvent.change(titleField(), { target: { value: 'Gamma' } });
    await act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: 'Add note' })));
    await waitFor(() => expect(where()).toBe('/planning?tab=notes&note=new1'));
    expect(shown().getAttribute('aria-label')).toBe('Gamma');
  });

  it('will not save without a title', async () => {
    renderNotes([]);
    newNote();
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Add note' }));
    expect((await within(drawer()).findByRole('alert')).textContent).toBe('Give it a title.');
    expect(calls.inserts).toHaveLength(0);
  });

  it('edits, and deletes on the second press', async () => {
    const { reload } = renderNotes();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Who pays what' })).toBeTruthy();
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.updates).toHaveLength(1));
    expect(calls.updates[0]).toMatchObject({ id: 'n1', updatedAt: NOTE.updated_at });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Delete' }));
    expect(calls.deletes).toEqual([]);
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Confirm delete?' }));
    await waitFor(() => expect(calls.deletes).toEqual([{ table: 'household_notes', id: 'n1' }]));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('asks before Cancel throws away a changed note, and not when nothing changed', () => {
    renderNotes();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(titleField(), { target: { value: 'Who pays what, and why' } });
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    fireEvent.click(screen.getByText('Keep editing'));
    expect(titleField().value).toBe('Who pays what, and why');
  });

  it('will not save over a note changed since it was opened', async () => {
    const { reload } = renderNotes();
    calls.stored = '2026-09-29T08:00:00Z';
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(titleField(), { target: { value: 'Mine' } });
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save' }));
    expect(await within(drawer()).findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/^This note was changed after you opened it/));
    expect(reload).not.toHaveBeenCalled();
    expect(titleField().value).toBe('Mine');
  });

  it('saves only over the version it was opened from, though the note is read again while it is open', async () => {
    // The page reads the notes again every few minutes; here that brings in
    // the partner's save while this edit is still open.
    const theirs = { ...NOTE, body: 'Their text', updated_at: '2026-09-29T08:00:00Z' };
    function Page() {
      const [notes, set] = useState([NOTE]);
      return (
        <>
          <button type="button" onClick={() => set([theirs])}>
            Read again
          </button>
          <Notes household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} data={{ notes, reload: vi.fn() }} loading={false} />
        </>
      );
    }
    renderScreen(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(titleField(), { target: { value: 'Mine' } });
    calls.stored = theirs.updated_at;
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save' }));
    expect(await within(drawer()).findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/^This note was changed after you opened it/));
    expect(calls.updates[0].updatedAt).toBe(NOTE.updated_at);
  });

  it('opens a note again only once the read after its save has landed', async () => {
    let finishReload;
    const reload = vi.fn(() => new Promise((resolve) => (finishReload = resolve)));
    renderNotes([NOTE], { reload });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(drawer()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Edit' }).disabled).toBe(true);
    await act(async () => finishReload());
    expect(screen.getByRole('button', { name: 'Edit' }).disabled).toBe(false);
  });
});

// A note checked once a year (Planning audit, 4.18): the editor marks it, and
// the note says where it stands and takes Checked today.
describe('Notes: a yearly check', () => {
  it('is set in the drawer and saved with the note', async () => {
    renderNotes([]);
    newNote();
    fireEvent.change(titleField(), { target: { value: 'Protection' } });
    const toggle = within(drawer()).getByRole('switch', { name: 'Check once a year' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: 'Add note' })));
    expect(calls.inserts[0].row).toMatchObject({ title: 'Protection', check_yearly: true });
  });

  it('says it has not been checked, and Checked today records the household day', async () => {
    const { reload } = renderNotes([{ ...NOTE, check_yearly: true, checked_on: null }]);
    const row = shown().querySelector('.nt-check');
    expect(row.textContent).toMatch(/^Checked once a year · not checked yet/);
    expect(row.getAttribute('data-due')).toBe('true');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Checked today' })));
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].row).toEqual({ checked_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), updated_by: 'm1' });
    expect(calls.updates[0].id).toBe('n1');
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('says when it was last checked and when it is due', () => {
    const lastYear = new Date().getFullYear() - 1;
    renderNotes([{ ...NOTE, check_yearly: true, checked_on: `${lastYear}-01-01` }]);
    expect(shown().querySelector('.nt-check').textContent).toMatch(new RegExp(`^Checked once a year · last checked 1 Jan ${lastYear} · due now`));
  });

  // The fresh review of 6c: checking a note moves it down the list, and the
  // next due note took its place under the same Checked today.
  it('keeps the note it checked on screen, though checking it moves it down the list', async () => {
    const insurance = { ...NOTE, id: 'n3', title: 'Insurance', check_yearly: true, checked_on: null, position: 1 };
    const wills = { ...NOTE, id: 'n4', title: 'Wills', check_yearly: true, checked_on: null, position: 2 };
    const today = new Date().toISOString().slice(0, 10);
    renderReloading([insurance, wills], [{ ...insurance, checked_on: today }, wills]);
    expect(shown().getAttribute('aria-label')).toBe('Insurance');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Checked today' })));
    await waitFor(() => expect(listed()).toEqual(['Wills', 'Insurance']));
    expect(shown().getAttribute('aria-label')).toBe('Insurance');
    expect(where()).toBe('/planning?tab=notes&note=n3');
  });

  // The fresh review of 6c: the note shown first, by default, moves down the
  // list when an edit turns its yearly check off, and the pane kept to the
  // list's first.
  it('keeps the note it saved on screen, though the save moves it down the list', async () => {
    const yearly = { ...OTHER, check_yearly: true, checked_on: null };
    renderReloading([NOTE, yearly], [NOTE, OTHER]);
    expect(shown().getAttribute('aria-label')).toBe('What is still open');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(drawer()).getByRole('switch', { name: 'Check once a year' }));
    await act(async () => fireEvent.click(within(drawer()).getByRole('button', { name: 'Save' })));
    await waitFor(() => expect(listed()).toEqual(['Who pays what', 'What is still open']));
    expect(shown().getAttribute('aria-label')).toBe('What is still open');
  });

  // The prototype: Checked today only while the check is due; checked this
  // year, the row is quiet.
  it('takes Checked today only while it is due', () => {
    const recently = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    renderNotes([{ ...NOTE, check_yearly: true, checked_on: recently }]);
    const row = shown().querySelector('.nt-check');
    expect(row.getAttribute('data-due')).toBe('false');
    expect(row.textContent).toMatch(/^Checked once a year · last checked .* · next from /);
    expect(screen.queryByRole('button', { name: 'Checked today' })).toBeNull();
  });

  it('shows nothing of the kind on an ordinary note', () => {
    renderNotes();
    expect(screen.queryByRole('button', { name: 'Checked today' })).toBeNull();
    expect(shown().querySelector('.nt-check')).toBeNull();
  });
});

// The outside review, E-06: a note deleted elsewhere while it is open keeps
// its draft on screen, says what happened, and Cancel unlocks the page.
// Plain render: a rerender must update this tree, not mount a new one.
describe('Notes: the open note deleted elsewhere', () => {
  it('keeps the draft, says it was deleted, and unlocks on Cancel', () => {
    const props = { household: { id: 'h' }, me: { id: 'm1' }, members: MEMBERS, onRetry: vi.fn(), loading: false };
    const reload = vi.fn();
    const page = (notes) => (
      <MemoryRouter>
        <ScopeProvider>
          <CurrencyProvider>
            <Notes {...props} data={{ notes, reload }} />
          </CurrencyProvider>
        </ScopeProvider>
      </MemoryRouter>
    );
    const { rerender } = plainRender(page([NOTE, OTHER]));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(drawer()).getByLabelText('Note'), { target: { value: 'My long draft' } });

    // A refresh: the other partner deleted it meanwhile.
    rerender(page([OTHER]));
    expect(within(drawer()).getByLabelText('Note').value).toBe('My long draft');
    // Said aloud too, as the old editor's notice was: the draft is in the
    // way of reading it.
    expect(within(drawer()).getAllByRole('alert').map((a) => a.textContent)).toContain('This note was deleted elsewhere. Copy what you need from your draft, then Cancel.');

    fireEvent.click(within(drawer()).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: '+ Note' }).disabled).toBe(false);
  });
});
