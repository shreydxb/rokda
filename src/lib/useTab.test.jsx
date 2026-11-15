import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useTab } from './useTab';

const TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'budget', label: 'Budget' },
];

function Probe({ keep }) {
  const [tab, setTab] = useTab(TABS, 'activity', {}, keep);
  return (
    <>
      <output data-testid="tab">{tab}</output>
      <output data-testid="search">{useLocation().search}</output>
      <button type="button" onClick={() => setTab('budget')}>
        Budget
      </button>
    </>
  );
}

describe('useTab', () => {
  it("drops the last tab's filters on a switch", () => {
    render(
      <MemoryRouter initialEntries={['/money?cat=c1&month=2026-09']}>
        <Probe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Budget'));
    expect(screen.getByTestId('search').textContent).toBe('?tab=budget');
  });

  // Money's tabs share the month (the revamp, phase 4): stepping to September
  // on Budget and opening Activity shows September.
  it('keeps the parameters it is asked to keep', () => {
    render(
      <MemoryRouter initialEntries={['/money?cat=c1&month=2026-09']}>
        <Probe keep={['month']} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Budget'));
    expect(screen.getByTestId('tab').textContent).toBe('budget');
    expect(screen.getByTestId('search').textContent).toBe('?tab=budget&month=2026-09');
  });
});
