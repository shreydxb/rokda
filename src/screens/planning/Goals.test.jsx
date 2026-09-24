import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import Goals from './Goals';
import PlanSummary from './PlanSummary';

vi.mock('../../lib/supabaseClient', () => ({ supabase: {} }));

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
const GOAL = { id: 'g1', name: 'Emergency fund', target_amount: 100000, target_date: '2027-12-31', is_shared: true, owner_member_id: null, note: '', funding_source: '' };
const ACCOUNTS = [{ id: 'a1', currency: 'AED', balance: 40000, balance_aed: 40000, archived_at: null }];
const DATA = {
  goals: [GOAL],
  goalContributions: [{ id: 'c1', goal_id: 'g1', amount: 5000, occurred_at: '2026-09-01' }],
  goalAllocations: [{ id: 'l1', goal_id: 'g1', account_id: 'a1', holding_id: null, share_pct: 50 }],
  debts: [],
  assumptions: null,
  reload: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 24, 12));
});
afterEach(() => vi.useRealTimers());

describe('Goals: the monthly figure a target date needs', () => {
  it('spreads what is left over the months to the target date', () => {
    renderScreen(<Goals household={{ id: 'h' }} members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} holdings={[]} data={DATA} loading={false} />);
    // 100,000 − (5,000 logged + 20,000 linked) = 75,000 over Oct 2026..Dec 2027.
    expect(screen.getByText(/to reach it by Dec 2027/)).toBeTruthy();
    expect(screen.getAllByText('5,000').length).toBeGreaterThan(0);
    expect(screen.getByText(/15 months left/)).toBeTruthy();
  });
});

describe('Plan summary agrees with the Goals tab', () => {
  it('counts linked accounts in saved, as the Goals tab does', () => {
    renderScreen(
      <PlanSummary members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} transactions={[]} holdings={[]} data={DATA} loading={false} onOpenTab={() => {}} />,
    );
    // 5,000 logged + half of a 40,000 account. It used to read 5,000.
    expect(screen.getByText('25,000')).toBeTruthy();
  });
});
