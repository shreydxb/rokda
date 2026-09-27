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

describe('Plan summary uses the same independence target as Forecast and Drawdown', () => {
  it('takes lasting other income off the target', () => {
    const now = new Date();
    const txns = [1, 2, 3].map((back, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 10);
      return { id: `s${i}`, amount: -4000, kind: 'expense', occurred_at: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10`, is_shared: true };
    });
    const rent = { id: 'r1', kind: 'yearly', amount: 24000, starts_after_years: 0, lasts_years: null };
    renderScreen(
      <PlanSummary
        members={MEMBERS}
        me={{ id: 'm1' }}
        accounts={ACCOUNTS}
        transactions={txns}
        holdings={[]}
        data={{ ...DATA, independenceIncome: [rent] }}
        loading={false}
        onOpenTab={() => {}}
      />,
    );
    // 48,000 − 24,000 = 24,000 a year at 4%: 600,000.
    expect(screen.getByText(/of the way to 600,000/)).toBeTruthy();
  });
});

describe('Goals: today\'s costs and funding in priority order', () => {
  const VILLA = { id: 'g2', name: 'Villa', target_amount: 1000000, target_date: '2044-09-01', is_shared: true, owner_member_id: null, note: '', funding_source: '', cost_today: true, inflation_pct: 8, priority: 1 };

  it('shows what a today\'s cost comes to on its date', () => {
    renderScreen(<Goals household={{ id: 'h' }} members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} holdings={[]} data={{ ...DATA, goals: [GOAL, VILLA] }} loading={false} />);
    // 1,000,000 at 8% for the 18 years to Sep 2044.
    expect(screen.getByText(/1,000,000 today, rising 8% a year · about 3,996,019 by 2044/)).toBeTruthy();
  });

  it('covers goals in priority order from what is set aside, then the rest of net worth', () => {
    renderScreen(<Goals household={{ id: 'h' }} members={MEMBERS} me={{ id: 'm1' }} accounts={ACCOUNTS} holdings={[]} data={{ ...DATA, goals: [GOAL, VILLA] }} loading={false} />);
    expect(screen.getByText('Funding in priority order')).toBeTruthy();
    const rows = [...document.querySelectorAll('.ch-table tbody tr')].map((r) => r.textContent);
    // The villa is priority 1, so it comes first and takes the 15,000 not set aside for the emergency fund.
    expect(rows[0]).toMatch(/^1Villa · 2044/);
    expect(rows[1]).toMatch(/^—Emergency fund · 2027/);
  });
});
