import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';

const inserts = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      insert: (rows) => {
        inserts.push(rows);
        const result = { data: rows.map((r, i) => ({ id: `new-${inserts.length}-${i}`, name: r.name })), error: null };
        return { select: () => Promise.resolve(result), then: (ok) => ok({ error: null }) };
      },
    }),
  },
}));

const { default: StarterCategories } = await import('./StarterCategories');

beforeEach(() => {
  inserts.length = 0;
});

describe('Starter categories', () => {
  it('ticks everything for a household with no categories, and adds groups before their categories', async () => {
    const onSaved = vi.fn().mockResolvedValue(undefined);
    renderScreen(<StarterCategories householdId="h" categories={[]} onClose={() => {}} onSaved={onSaved} />);
    const add = screen.getByRole('button', { name: /^Add \d+ categories$/ });
    fireEvent.click(add);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [groups, children] = inserts;
    expect(groups.every((g) => g.parent_id === null)).toBe(true);
    expect(groups.map((g) => g.name)).toContain('Utilities');
    // Each category lands under the id its new group was given.
    const utilitiesIdx = groups.findIndex((g) => g.name === 'Utilities');
    const dewa = children.find((c) => c.name === 'Electricity & water');
    expect(dewa.parent_id).toBe(`new-1-${utilitiesIdx}`);
    // Income stays flat.
    expect(children.find((c) => c.name === 'Salary').parent_id).toBeNull();
  });

  it('shows what a household already has, under its own names, and adds none of it', () => {
    const utilities = { id: 'u', name: 'Utilities', kind: 'expense', parent_id: null };
    const categories = [utilities, { id: 'd', name: 'DEWA', kind: 'expense', parent_id: 'u' }];
    renderScreen(<StarterCategories householdId="h" categories={categories} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.getByText(/as “DEWA”/)).toBeTruthy();
    // Nothing is ticked for a household that built its own set.
    expect(screen.getByRole('button', { name: 'Add' }).disabled).toBe(true);
    fireEvent.click(screen.getByText('Internet'));
    expect(screen.getByRole('button', { name: 'Add 1 category' })).toBeTruthy();
  });
});
