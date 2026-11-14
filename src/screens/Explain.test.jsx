import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Explain from './Explain';

// Fewer words (docs/decisions.md, "The shell, and fewer words"): how a figure
// is worked out sits behind one small link, closed until asked for.
describe('Explain', () => {
  it('keeps its text behind a closed "How this is worked out"', () => {
    render(<Explain>Paid is spending from each person's own accounts.</Explain>);
    const details = screen.getByText("Paid is spending from each person's own accounts.").closest('details');
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(screen.getByText('How this is worked out').tagName).toBe('SUMMARY');
  });

  it('takes a label of its own', () => {
    render(<Explain label="About members">Text</Explain>);
    expect(screen.getByText('About members').tagName).toBe('SUMMARY');
  });
});
