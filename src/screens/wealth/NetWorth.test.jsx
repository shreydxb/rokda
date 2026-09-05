import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const { default: NetWorth } = await import('./NetWorth');

const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];

// QA-08 at the call site the review named: NetWorth.jsx's hero passed a signed
// figure to the magnitude formatter, so −100 rendered as 100.
describe('QA-08: the net worth hero keeps its sign', () => {
  it('renders a negative net worth with a minus', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 'l1', name: 'Car loan', type: 'loan', balance: 100, is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [],
        }}
      />,
    );
    const hero = document.querySelector('.ov-hero');
    expect(hero.textContent).toContain('−100');
  });

  it('renders a positive net worth without decoration', () => {
    renderScreen(
      <NetWorth
        household={{ id: 'h1' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{
          accounts: [{ id: 's1', name: 'Savings', type: 'savings', balance: 100, is_shared: true, archived_at: null }],
          netWorthSnapshots: [],
          holdings: [],
        }}
      />,
    );
    const hero = document.querySelector('.ov-hero');
    expect(hero.textContent).toContain('100');
    expect(hero.textContent).not.toMatch(/[−+]/);
    expect(screen.getByText('Net worth')).toBeTruthy();
  });
});
