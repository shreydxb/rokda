import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import CategoriesRules from './CategoriesRules';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));
afterEach(cleanup);

const CATEGORIES = [
  { id: 'c-groceries', name: 'Groceries', kind: 'expense', parent_id: null, archived: false },
  { id: 'c-dining', name: 'Dining out', kind: 'expense', parent_id: null, archived: false },
];
const RULES = [
  { id: 'r1', pattern: 'corner', match_type: 'contains', category_id: 'c-dining', archived: false },
  { id: 'r2', pattern: 'old shop', match_type: 'starts_with', category_id: 'c-groceries', archived: true },
];

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderAt(url) {
  return renderScreen(
    <MemoryRouter initialEntries={[url]}>
      <LocationProbe />
      <CategoriesRules household={{ id: 'hh' }} members={[]} loading={false} data={{ categories: CATEGORIES, categoryRules: RULES, reload: vi.fn() }} />
    </MemoryRouter>,
  );
}

// "Open that rule in Settings", from a transaction's editor, and "See the rule
// in Settings", from Activity, open Settings at one rule.
describe('A link to one rule', () => {
  it('opens that rule’s editor', () => {
    renderAt('/settings?tab=categories&rule=r1');
    const dialog = screen.getByRole('dialog', { name: 'Edit rule' });
    expect(dialog.querySelector('.te-title').textContent).toBe('"corner"');
    expect(screen.getByDisplayValue('corner')).toBeTruthy();
  });

  it('takes the rule out of the address once closed, keeping the tab', () => {
    renderAt('/settings?tab=categories&rule=r1');
    fireEvent.click(screen.getByText('Cancel', { selector: 'button' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('?tab=categories');
  });

  it('opens an archived rule as it is, still archived', () => {
    renderAt('/settings?tab=categories&rule=r2');
    expect(screen.getByRole('dialog', { name: 'Edit rule' }).textContent).toContain('Archived');
  });

  it('opens nothing for a rule that no longer exists', () => {
    renderAt('/settings?tab=categories&rule=gone');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/Contains "corner" → Dining out/)).toBeTruthy();
  });
});
