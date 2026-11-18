import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import GoalDrawer from './GoalDrawer';

// A goal opened through its address (the revamp, phase 6b). The fresh review
// of 6b: closing it while a save was in flight went back twice, leaving the
// page the drawer was opened from.

const pending = vi.hoisted(() => ({ finish: null }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: () => ({
      update: () => ({ eq: () => new Promise((resolve) => (pending.finish = () => resolve({ error: null }))) }),
    }),
  },
}));

const GOAL = { id: 'g1', name: 'Car', target_amount: 30000, target_date: '2029-06-30', is_shared: true, owner_member_id: null, note: '', funding_source: '', priority: null };

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

describe('GoalDrawer: closing', () => {
  it('goes back once, however it is closed while a save is in flight', async () => {
    const reload = vi.fn();
    renderScreen(
      <MemoryRouter initialEntries={['/elsewhere', '/planning?tab=goals', { pathname: '/planning', search: '?tab=goals&goal=g1', state: { drawer: true } }]} initialIndex={2}>
        <GoalDrawer household={{ id: 'h' }} members={[]} data={{ goals: [GOAL], goalContributions: [], goalAllocations: [], reload }} />
        <Where />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New car' } });
    fireEvent.click(screen.getByText('Save changes'));
    // While it saves, closed and its changes discarded.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/planning?tab=goals'));
    await act(async () => pending.finish());
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(screen.getByTestId('where').textContent).toBe('/planning?tab=goals');
  });
});
