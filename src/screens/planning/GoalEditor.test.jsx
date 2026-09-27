import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import GoalEditor from './GoalEditor';

const calls = vi.hoisted(() => ({ inserts: [] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: async (row) => {
        calls.inserts.push({ table, row });
        return { error: null };
      },
    }),
  },
}));

beforeEach(() => {
  calls.inserts.length = 0;
});

function renderEditor() {
  const onSaved = vi.fn();
  renderScreen(
    <GoalEditor goal={null} contributions={[]} allocations={[]} accounts={[]} holdings={[]} householdId="h" members={[]} inflationPct={2.5} onClose={vi.fn()} onSaved={onSaved} />,
  );
  return { onSaved };
}

const type = (el, value) => fireEvent.change(el, { target: { value } });

describe('GoalEditor: today\'s cost, its rate and a priority', () => {
  it('previews the cost on the date and saves the new fields', async () => {
    const { onSaved } = renderEditor();
    type(screen.getByPlaceholderText('0'), '1000000');
    type(screen.getByPlaceholderText('e.g. Japan trip'), 'Villa');
    type(document.querySelector('input[type="date"]'), '2044-09-01');
    fireEvent.click(screen.getByText('Today’s cost'));
    type(screen.getByLabelText('Rises by, percent a year'), '8');
    expect(screen.getByText(/^About [\d,]+ by 2044/)).toBeTruthy();
    type(screen.getByLabelText('Priority'), '1');
    fireEvent.click(screen.getByText(/^(Add goal|Save)/));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.inserts[0].row).toMatchObject({ name: 'Villa', target_amount: 1000000, cost_today: true, inflation_pct: 8, priority: 1 });
  });

  it('keeps no rate for an amount on the date, and refuses a priority of zero', () => {
    renderEditor();
    type(screen.getByPlaceholderText('0'), '5000');
    type(screen.getByPlaceholderText('e.g. Japan trip'), 'Trip');
    type(screen.getByLabelText('Priority'), '0');
    fireEvent.click(screen.getByText(/^(Add goal|Save)/));
    expect(screen.getByText('Priority is a whole number from 1.')).toBeTruthy();
    expect(calls.inserts).toEqual([]);
  });
});
