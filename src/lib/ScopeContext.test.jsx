import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ScopeProvider, ScopeFromLink, useScope } from './ScopeContext';

function Probe() {
  const { scope, setScope } = useScope();
  const location = useLocation();
  return (
    <>
      <span data-testid="scope">{scope}</span>
      <span data-testid="search">{location.search}</span>
      <button type="button" onClick={() => setScope('me')}>Me</button>
    </>
  );
}

const mount = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ScopeProvider>
        <ScopeFromLink />
        <Probe />
      </ScopeProvider>
    </MemoryRouter>,
  );

describe('household scope', () => {
  it('starts at Both and remembers a choice across a reload', () => {
    const first = mount();
    expect(screen.getByTestId('scope').textContent).toBe('both');
    fireEvent.click(screen.getByText('Me'));
    first.unmount();
    mount();
    expect(screen.getByTestId('scope').textContent).toBe('me');
  });

  it("ignores a stored value it doesn't know", () => {
    window.localStorage.setItem('rokda.scope', 'everyone');
    mount();
    expect(screen.getByTestId('scope').textContent).toBe('both');
  });

  it("applies a link's who and takes it out of the address", async () => {
    window.localStorage.setItem('rokda.scope', 'me');
    await act(async () => {
      mount('/money?tab=activity&who=both');
    });
    expect(screen.getByTestId('scope').textContent).toBe('both');
    expect(screen.getByTestId('search').textContent).toBe('?tab=activity');
    expect(window.localStorage.getItem('rokda.scope')).toBe('both');
  });
});
