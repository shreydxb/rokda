import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

const upserts = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      upsert: (rows) => {
        upserts.push(rows);
        return Promise.resolve({ error: null });
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  },
}));

const { default: BudgetEditor } = await import('./BudgetEditor');

const CATEGORIES = [{ id: 'c1', name: 'Groceries', kind: 'expense', parent_id: null }];

beforeEach(() => {
  upserts.length = 0;
});

describe('BudgetEditor: alerts toggle', () => {
  it('defaults to alerts on for a new budget', async () => {
    renderScreen(<BudgetEditor item={null} householdId="hh" categories={CATEGORIES} year={2026} month={9} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Groceries' }));
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(upserts[0][0]).toMatchObject({ category_id: 'c1', amount: 500, alerts_enabled: true });
    cleanup();
  });

  it('persists alerts_enabled=false once toggled off', async () => {
    const item = { id: 'b1', category_id: 'c1', amount: 500, alerts_enabled: true };
    renderScreen(<BudgetEditor item={item} householdId="hh" categories={CATEGORIES} year={2026} month={9} onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Budget alerts/i }));
    await act(async () => {
      fireEvent.submit(document.querySelector('form'));
    });
    expect(upserts[0][0]).toMatchObject({ alerts_enabled: false });
    cleanup();
  });

  it('respects an existing muted budget on open', () => {
    const item = { id: 'b1', category_id: 'c1', amount: 500, alerts_enabled: false };
    renderScreen(<BudgetEditor item={item} householdId="hh" categories={CATEGORIES} year={2026} month={9} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.getByText('Off')).toBeTruthy();
    cleanup();
  });
});

describe('BudgetEditor: no more Projected close field', () => {
  it('does not show a Projected close field when editing', () => {
    const item = { id: 'b1', category_id: 'c1', amount: 500, spentSoFar: 200 };
    renderScreen(<BudgetEditor item={item} householdId="hh" categories={CATEGORIES} year={2026} month={9} onClose={() => {}} onSaved={async () => {}} />);
    expect(screen.queryByText('Projected close')).toBeNull();
    expect(screen.getByText('Spent so far')).toBeTruthy();
    cleanup();
  });
});
