// The display currency covers every figure on Overview. Picking USD used to
// convert the net worth and leave income, spend and the chart in AED, so
// 18,000 of income read as 18,000 dollars next to a converted net worth.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));

vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({
    household: { id: 'hh', name: 'Test' },
    members: [{ id: 'm1', display_name: 'Partner A' }],
    me: { id: 'm1', display_name: 'Partner A' },
    loading: false,
    error: null,
    reload: () => {},
  }),
}));

const NOW = new Date();
const TODAY = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}-${String(NOW.getDate()).padStart(2, '0')}`;

// Overview also reads Planning's records, for its Plan strip.
vi.mock('./usePlanningData', async () => {
  const { emptyPlanning } = await import('../test/planningStub');
  return { usePlanningData: () => emptyPlanning() };
});
vi.mock('./useOverviewData', async (importOriginal) => ({
  ...(await importOriginal()),
  useOverviewData: () => ({
    loading: false,
    accounts: [{ id: 'a1', name: 'Current account', type: 'current', currency: 'AED', balance: 36725, balance_aed: 36725, balance_as_of: TODAY, is_shared: true, owner_member_id: null, archived_at: null }],
    transactions: [
      { id: 't1', amount: 18362.5, kind: 'income', occurred_at: TODAY, is_shared: true, merchant: 'Salary' },
      { id: 't2', amount: -3672.5, kind: 'expense', occurred_at: TODAY, is_shared: true, merchant: 'Rent' },
    ],
    categories: [],
    recurring: [],
    netWorthSnapshots: [],
    holdings: [],
    backupRecords: [],
    errors: {},
    loadedAt: new Date(),
    reload: () => {},
  }),
}));

afterEach(() => localStorage.clear());

async function renderOverview() {
  const { default: Overview } = await import('./Overview');
  return renderScreen(
    <MemoryRouter>
      <Overview />
    </MemoryRouter>,
  );
}

function kpis(container) {
  return Object.fromEntries([...container.querySelectorAll('.ov-month .ds-kpi')].map((k) => [k.querySelector('dt').textContent, k.querySelector('.ds-fig').textContent]));
}

describe('Overview display currency', () => {
  it('shows income, spent and saved in AED by default', async () => {
    const { container } = await renderOverview();
    expect(kpis(container)).toMatchObject({ Income: '18,363', Spent: '3,673', Saved: '+14,690' });
    expect(container.querySelector('.ov-nw .ds-code').textContent).toBe('AED');
  });

  it('converts income, spent, saved and the chart along with the net worth', async () => {
    localStorage.setItem('rokda:currency', 'USD');
    const { container } = await renderOverview();
    expect(container.querySelector('.ov-nw .ds-code').textContent).toBe('USD');
    expect(kpis(container)).toMatchObject({ Income: '5,000', Spent: '1,000', Saved: '+4,000' });
    // The rate it converts at is said beside the month's figures.
    expect(container.querySelector('.ov-month').textContent).toMatch(/3\.6725/);
    expect(container.querySelector('.ov-chart-readout').textContent).toMatch(/Income 5,000/);
  });
});

// The revamp (phase 3): the cockpit, as the prototype lays it out.
describe('Overview layout', () => {
  it('leads with net worth and the month, then To do beside the next 30 days, then the chart, the plan and recent', async () => {
    const { container } = await renderOverview();
    const order = [...container.querySelectorAll('.ds-card')].map((c) => c.className.split(' ').find((n) => n.startsWith('ov-')));
    expect(order).toEqual(['ov-nw', 'ov-month', 'ov-todo', 'ov-next30', 'ov-flow', 'ov-where', 'ov-plan', 'ov-recent']);
    expect(container.querySelector('.ov-nw').textContent).toMatch(/36,725/);
    // Data quality is one chip beside the date, opening its checks in place.
    const chip = container.querySelector('.ov-quality-chip');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(chip.textContent).toMatch(/^Data: /);
  });

  it('titles the chart by its grouping and marks the running month', async () => {
    const { container } = await renderOverview();
    expect(container.textContent).toContain('Income and spending · 6 months');
    expect(container.querySelector('.ch-tick-active').textContent).toMatch(/so far/);
    // Months before the first record say so rather than drawing a zero.
    expect(container.querySelectorAll('.ds-col-empty').length).toBeGreaterThan(0);
  });
});
