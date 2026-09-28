import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import Notes from './Notes';

const calls = vi.hoisted(() => ({ inserts: [], updates: [], deletes: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.inserts.push({ table, row });
        return { error: null };
      },
      update: (row) => ({
        eq: async (col, id) => {
          calls.updates.push({ table, row, id });
          return { error: null };
        },
      }),
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
});

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];
const NOTE = { id: 'n1', title: 'Who pays what', body: '# Split\nShared costs by income.\n\n- **Rent** is shared\n- <b>not markup</b>', position: 1, updated_by: 'm1', updated_at: '2026-09-28T10:00:00Z' };

function renderNotes(notes = [NOTE]) {
  const reload = vi.fn().mockResolvedValue(undefined);
  renderScreen(<Notes household={{ id: 'h' }} me={{ id: 'm1' }} members={MEMBERS} data={{ notes, reload }} loading={false} />);
  return { reload };
}

describe('Notes', () => {
  it('renders headings, bullets and bold, and shows markup as text', () => {
    renderNotes();
    const card = screen.getByLabelText('Who pays what');
    expect(card.querySelector('h3').textContent).toBe('Split');
    expect(card.querySelector('strong').textContent).toBe('Rent');
    expect(card.querySelector('b')).toBeNull();
    expect(card.textContent).toContain('<b>not markup</b>');
    expect(card.textContent).toMatch(/by Shreyash/);
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
    expect(calls.updates[0].id).toBe('n1');
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText('Delete this note?')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(calls.deletes).toEqual([{ table: 'household_notes', id: 'n1' }]));
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
