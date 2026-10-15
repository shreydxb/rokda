import { describe, it, expect, afterEach } from 'vitest';
import { renderScreen } from '../test/renderScreen';
import AedNote from './AedNote';

afterEach(() => localStorage.clear());

describe('AedNote', () => {
  it('says nothing while the display currency is AED', () => {
    const { container } = renderScreen(<AedNote household={{ id: 'h' }} />);
    expect(container.textContent).toBe('');
  });

  it('says the screen is in AED when another display currency is picked', () => {
    localStorage.setItem('rokda:currency', 'USD');
    const { getByRole } = renderScreen(<AedNote household={{ id: 'h' }} />);
    expect(getByRole('note').textContent).toMatch(/in AED, as recorded\. The USD display applies to Overview/);
  });
});
