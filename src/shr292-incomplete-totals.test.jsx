// SHR-292, first slice: one multicurrency household run through every surface
// that prints a net-worth or cover total, app and bot alike.
//
// The household has AED 100 in cash, a rupee credit card nobody has converted
// to AED, one valued holding and one holding that has never been valued. Two
// of its four balance-sheet lines are therefore unknown, and every surface
// must say so rather than print a total that looks complete: the card is not
// a zero liability and the unvalued holding is not a zero asset.
//
// Each surface already had its own test for the first gap (QA #4). What was
// missing was one fixture proving they all agree, which is how the second gap
// -- a never-valued holding counted as 0 in net worth -- got through: the
// Investments screen and the P&L figure were fixed, the net-worth total that
// five other surfaces read was not.
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderScreen } from './test/renderScreen';
import { incompleteNote, netWorthSummary, startingNetWorth } from './screens/overviewMath';
import * as botMath from '../supabase/functions/_shared/applib/overviewMath.js';
import { cashCoverStatus, formatCashCoverLine } from './lib/cashCover';
import * as botCashCover from '../supabase/functions/_shared/applib/cashCover.js';

vi.mock('./lib/supabaseClient', () => ({ supabase: {} }));

// Overview loads its own data; hand it the fixture instead.
vi.mock('./lib/useHousehold', () => ({
  useHousehold: () => ({
    household: { id: 'hh', name: 'Test' },
    members: [{ id: 'm1', display_name: 'Shreyash' }],
    me: { id: 'm1', display_name: 'Shreyash' },
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
vi.mock('./screens/useOverviewData', async (importOriginal) => ({
  ...(await importOriginal()),
  useOverviewData: () => ({
    loading: false,
    accounts: ACCOUNTS,
    transactions: [],
    categories: [],
    recurring: [],
    netWorthSnapshots: [],
    holdings: HOLDINGS,
    errors: {},
    loadedAt: new Date(),
    reload: () => {},
  }),
}));

const NOW = new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const PRICED = new Date(NOW.getTime() - 86400000).toISOString();

const ACCOUNTS = [
  { id: 'a1', name: 'Wallet', type: 'cash', currency: 'AED', balance: 100, balance_aed: 100, balance_as_of: TODAY, is_shared: true, owner_member_id: null, archived_at: null },
  // Owed, in rupees, with no AED conversion recorded.
  { id: 'c1', name: 'HDFC card', type: 'credit_card', currency: 'INR', balance: 50_000, balance_aed: null, balance_as_of: TODAY, due_day: NOW.getDate(), is_shared: true, owner_member_id: null, archived_at: null },
];
const HOLDINGS = [
  { id: 'h1', name: 'VWRA', asset_class: 'intl_equity', quantity: 100, value_aed: 20_000, priced_at: PRICED, is_shared: true, owner_member_id: null },
  // value_aed is `not null default 0`: this 0 is a placeholder, not a price.
  { id: 'h2', name: 'New fund', asset_class: 'india_mf', quantity: 10, value_aed: 0, priced_at: null, is_shared: true, owner_member_id: null },
];

const NOTE = 'excludes 1 account in another currency that has no AED conversion yet, and 1 holding that has never been valued';
const MEMBERS = [{ id: 'm1', display_name: 'Shreyash' }];

function closedMonthTransactions() {
  return [1, 2, 3].map((back, i) => {
    const d = new Date(NOW.getFullYear(), NOW.getMonth() - back, 15);
    return { id: `t${i}`, amount: -1000, kind: 'expense', occurred_at: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`, is_shared: true };
  });
}

describe('SHR-292: the shared net-worth basis', () => {
  it('counts only what is known, and counts what is not', () => {
    expect(netWorthSummary(ACCOUNTS, null, HOLDINGS)).toEqual({
      assets: 20_100,
      liabilities: 0,
      netWorth: 20_100,
      unvalued: 1,
      unpricedHoldings: 1,
    });
  });

  it('the bot computes exactly what the app does', () => {
    expect(botMath.netWorthSummary(ACCOUNTS, null, HOLDINGS)).toEqual(netWorthSummary(ACCOUNTS, null, HOLDINGS));
    const s = netWorthSummary(ACCOUNTS, null, HOLDINGS);
    const gaps = { accounts: s.unvalued, holdings: s.unpricedHoldings };
    expect(botMath.incompleteNote(gaps)).toBe(incompleteNote(gaps));
  });

  it('names both gaps in one sentence, and only the ones that exist', () => {
    expect(incompleteNote({ accounts: 1, holdings: 1 }, { capitalised: false, sentence: false })).toBe(NOTE);
    expect(incompleteNote({ accounts: 2 })).toBe('Excludes 2 accounts in another currency that have no AED conversion yet.');
    expect(incompleteNote({ holdings: 1 })).toBe('Excludes 1 holding that has never been valued.');
    expect(incompleteNote({})).toBeNull();
  });

  it('a genuine zero or negative is still a value, not a gap', () => {
    const zeroCash = { ...ACCOUNTS[0], balance: 0, balance_aed: 0 };
    const owed = { id: 'l1', name: 'Car loan', type: 'loan', currency: 'AED', balance: 5000, balance_aed: 5000, balance_as_of: TODAY, is_shared: true, archived_at: null };
    const s = netWorthSummary([zeroCash, owed], null, []);
    expect(s).toMatchObject({ netWorth: -5000, unvalued: 0, unpricedHoldings: 0 });
  });

  it('a never-valued holding is no basis to project from', () => {
    // Before: any holding at all counted as a basis, so this household
    // projected from its placeholder 0.
    expect(startingNetWorth([ACCOUNTS[1]], [HOLDINGS[1]])).toBeNull();
    expect(startingNetWorth(ACCOUNTS, HOLDINGS)).toBe(20_100);
  });
});

describe('SHR-292: cash cover with an unconverted card due', () => {
  const bills = { recurring: [], credit_cards: [{ name: 'HDFC card', amount_owed_aed: null, due_date: TODAY }] };

  it('never reports the unknown bill as covered, in the app or the bot', () => {
    const app = formatCashCoverLine(cashCoverStatus(ACCOUNTS, bills, { days: 7, today: NOW }));
    const bot = botCashCover.formatCashCoverLine(botCashCover.cashCoverStatus(ACCOUNTS, bills, { days: 7, today: NOW }));
    expect(bot).toBe(app);
    expect(app).not.toMatch(/all bills covered/i);
    expect(app).toMatch(/no AED|not known|unknown|AED amount/i);
  });
});

describe('SHR-292: every screen that prints the total says what it leaves out', () => {
  it('Overview', async () => {
    const { default: Overview } = await import('./screens/Overview');
    const { container } = renderScreen(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain(`Incomplete — ${NOTE}.`);
  });

  it('Wealth › Net worth', async () => {
    const { default: NetWorth } = await import('./screens/wealth/NetWorth');
    const { container } = renderScreen(
      <NetWorth
        household={{ id: 'hh' }}
        me={MEMBERS[0]}
        members={MEMBERS}
        loading={false}
        data={{ accounts: ACCOUNTS, netWorthSnapshots: [], holdings: HOLDINGS }}
      />,
    );
    expect(container.textContent).toContain(`Incomplete — ${NOTE}. (HDFC card, New fund)`);
  });

  it('Planning › Forecast', async () => {
    const { default: Forecast } = await import('./screens/planning/Forecast');
    const { container } = renderScreen(
      <MemoryRouter>
        <Forecast
          household={{ id: 'hh' }}
          accounts={ACCOUNTS}
          holdings={HOLDINGS}
          transactions={closedMonthTransactions()}
          data={{ assumptions: null }}
          loading={false}
        />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain(`20,100 today · incomplete, ${NOTE}`);
  });

  it('Planning › Summary', async () => {
    const { default: PlanSummary } = await import('./screens/planning/PlanSummary');
    const { container } = renderScreen(
      <MemoryRouter>
        <PlanSummary
          members={MEMBERS}
          me={MEMBERS[0]}
          accounts={ACCOUNTS}
          holdings={HOLDINGS}
          transactions={closedMonthTransactions()}
          data={{ goals: [], goalContributions: [], debts: [], assumptions: null }}
          loading={false}
          onOpenTab={() => {}}
        />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain(`incomplete, ${NOTE}`);
  });

  // Only the unconverted card and the never-valued holding: nothing on this
  // balance sheet is actually known. Both planning screens used to disagree
  // here -- Forecast refused, the summary card projected from the holding's
  // placeholder 0 -- and now both come from startingNetWorth.
  it('with nothing valued, neither planning screen projects', async () => {
    const { default: PlanSummary } = await import('./screens/planning/PlanSummary');
    const { default: Forecast } = await import('./screens/planning/Forecast');
    const unknownOnly = { accounts: [ACCOUNTS[1]], holdings: [HOLDINGS[1]], transactions: closedMonthTransactions() };
    const summary = renderScreen(
      <MemoryRouter>
        <PlanSummary members={MEMBERS} me={MEMBERS[0]} {...unknownOnly} data={{ goals: [], goalContributions: [], debts: [], assumptions: null }} loading={false} onOpenTab={() => {}} />
      </MemoryRouter>,
    );
    expect(summary.container.textContent).not.toContain('of the way to');
    expect(summary.container.textContent).toContain('Nothing to plan yet');
    summary.unmount();
    const forecast = renderScreen(
      <MemoryRouter>
        <Forecast household={{ id: 'hh' }} {...unknownOnly} data={{ assumptions: null }} loading={false} />
      </MemoryRouter>,
    );
    expect(forecast.container.textContent).toContain('needs one account valuation');
  });
});
