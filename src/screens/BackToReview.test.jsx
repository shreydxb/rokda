import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BackToReview from './BackToReview';

// A page the review opened offers the way back to it; any other doesn't.
const last = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
const month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
const name = last.toLocaleDateString('en-GB', { month: 'long' });

function renderAt(entry) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <BackToReview />
    </MemoryRouter>,
  );
}

describe('BackToReview', () => {
  it('links back to the month the review was on', () => {
    renderAt(`/wealth?tab=accounts&reviewing=${month}`);
    expect(screen.getByRole('link', { name: `← Back to the ${name} review` }).getAttribute('href')).toBe(`/money?tab=review&month=${month}`);
  });

  it('shows nothing on a page opened any other way', () => {
    const { container } = renderAt('/wealth?tab=accounts');
    expect(container.textContent).toBe('');
  });
});
