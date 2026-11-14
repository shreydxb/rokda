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
  return Object.fromEntries([...container.querySelectorAll('.ov-kpi-row > div')].map((k) => [k.querySelector('.ov-kpi-label').textContent, k.querySelector('.ov-kpi-fig').textContent]));
}

describe('Overview display currency', () => {
  it('shows income, spend and saved in AED by default', async () => {
    const { container } = await renderOverview();
    expect(kpis(container)).toMatchObject({ Income: '18,363', 'Net spend': '3,673', 'Income less spending': '+14,690' });
    expect(container.querySelector('.ov-period-section').textContent).toMatch(/AED/);
  });

  it('converts income, spend, saved and the chart along with the net worth', async () => {
    localStorage.setItem('rokda:currency', 'USD');
    const { container } = await renderOverview();
    expect(container.querySelector('.ov-hero-currency').textContent).toBe('USD');
    expect(kpis(container)).toMatchObject({ Income: '5,000', 'Net spend': '1,000', 'Income less spending': '+4,000' });
    const period = container.querySelector('.ov-period-section').textContent;
    expect(period).toMatch(/USD/);
    expect(period).toMatch(/3\.6725/);
    expect(container.querySelector('.ov-chart-readout').textContent).toMatch(/Income 5,000/);
    // Nothing last month: the figure is new, said in grey, not a coloured rise
    // (the Overview redesign, November 2026).
    expect(container.querySelector('.ov-kpi-change').textContent).toBe('new');
  });
});

describe('Overview layout', () => {
  // The Overview redesign (November 2026): what needs a decision first, net
  // worth among the figures, data quality as one line under the title.
  it('puts what needs doing beside the next 30 days, net worth among the figures, and data quality up top', async () => {
    const { container } = await renderOverview();
    const order = [...container.querySelectorAll('section')].map((s) => s.className.split(' ')[0]);
    expect(order.indexOf('ov-quality-section')).toBeLessThan(order.indexOf('ov-period-section'));
    expect(order.indexOf('ov-period-section')).toBeLessThan(order.indexOf('ov-split'));
    expect(order).not.toContain('ov-hero-section');
    const split = container.querySelector('.ov-split');
    expect(split.querySelector('.ov-attn-col')).toBeTruthy();
    expect(split.querySelector('.ov-next30')).toBeTruthy();
    expect(kpis(container)['Net worth']).toMatch(/36,725/);
    const quality = container.querySelector('.ov-quality-details');
    expect(quality.open).toBe(false);
    expect(quality.querySelector('summary').textContent).toMatch(/Data quality/);
  });

  it('titles the chart by its grouping and marks the running month', async () => {
    const { container } = await renderOverview();
    expect(container.textContent).toContain('Monthly income and net spend · last 6 months');
    expect(container.querySelector('.ov-col[data-running="true"] .ov-col-label').textContent).toMatch(/so far/);
    // Months before the first record say so rather than drawing a zero.
    expect(container.querySelectorAll('.ov-col-none').length).toBeGreaterThan(0);
  });
});
