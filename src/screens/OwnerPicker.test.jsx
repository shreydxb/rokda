import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OwnerPicker from './OwnerPicker';

const MEMBERS = [
  { id: 'm1', display_name: 'Partner A' },
  { id: 'm2', display_name: 'Partner B' },
];

// Whose a record is: Shared, or one member. One picker for every editor that
// asks (the round 2 cleanup, SHR-383), each saying which is chosen.
describe('OwnerPicker', () => {
  it('offers Shared and each member, and says which is chosen', () => {
    render(<OwnerPicker value="m2" members={MEMBERS} onChange={vi.fn()} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Shared', 'Partner A', 'Partner B']);
    expect(screen.getByRole('button', { name: 'Partner B' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Shared' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Partner B' }).dataset.active).toBe('true');
  });

  it('reports the choice', () => {
    const onChange = vi.fn();
    render(<OwnerPicker value="shared" members={MEMBERS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Partner A' }));
    expect(onChange).toHaveBeenCalledWith('m1');
    fireEvent.click(screen.getByRole('button', { name: 'Shared' }));
    expect(onChange).toHaveBeenCalledWith('shared');
  });

  it('is a group named by its label when given one', () => {
    render(
      <>
        <span id="owner-label">Owner</span>
        <OwnerPicker value="shared" members={MEMBERS} onChange={vi.fn()} labelledBy="owner-label" />
      </>,
    );
    expect(screen.getByRole('group', { name: 'Owner' })).toBeTruthy();
  });
});
