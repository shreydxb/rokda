import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

// Wealth -> Net worth as the prototype lays it out (the revamp, phase 5a;
// design/prototype screens-wealth.js heroCard, grownCard, assetsCard,
// liabilitiesCard). Its figures are lib/netWorthLedger.js's and the shared
// basis's; these check what the page shows of them and where it leads.
const writes = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      update: (payload) => ({
        eq: (column, value) => {
          writes.push({ table, payload, value });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  },
}));

const { default: NetWorth } = await import('./NetWorth');

const MEMBERS = [
  { id: 'm1', display_name: 'Alex' },
  { id: 'm2', display_name: 'Sam' },
];
const RECENT = '2026-11-02T09:00:00Z';
const account = (id, type, extra = {}) => ({ id, name: id, type, currency: 'AED', balance: 1000, is_shared: true, owner_member_id: null, archived_at: null, balance_as_of: RECENT, ...extra });
const holding = (id, asset_class, value_aed) => ({ id, name: id, asset_class, value_aed, is_shared: true, archived_at: null, priced_at: '2026-11-10T00:00:00Z', last_refreshed: '2026-11-10T00:00:00Z' });

function Where() {
  const location = useLocation();
  return (
    <>
      <output data-testid="where">{location.pathname + location.search}</output>
      <output data-testid="state">{JSON.stringify(location.state ?? null)}</output>
    </>
  );
}

function open(data, { me = MEMBERS[0], scope } = {}) {
  if (scope) window.localStorage.setItem('rokda.scope', scope);
  const reload = vi.fn().mockResolvedValue(undefined);
  const view = renderScreen(
    <MemoryRouter initialEntries={['/wealth']}>
      <Where />
      <NetWorth household={{ id: 'hh' }} me={me} members={MEMBERS} loading={false} data={{ accounts: [], netWorthSnapshots: [], holdings: [], transactions: [], reload, ...data }} />
    </MemoryRouter>,
  );
  return { ...view, reload };
}
const where = () => screen.getByTestId('where').textContent;
const region = (name) => screen.getByRole('region', { name });
async function click(el) {
  await act(async () => {
    fireEvent.click(el);
  });
}

beforeEach(() => {
  writes.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T12:00:00'));
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.removeItem('rokda.scope');
  window.localStorage.removeItem('rokda:currency');
});

describe('Net worth: the hero', () => {
  // QA-08: the hero passed a signed figure to the magnitude formatter, so
  // −100 rendered as 100.
  it('keeps the figure’s sign', () => {
    open({ accounts: [account('Car loan', 'loan', { balance: 100 })] });
    expect(region('Net worth').querySelector('.nw-fig').textContent).toContain('−100');
    document.body.innerHTML = '';
    open({ accounts: [account('Savings', 'savings', { balance: 100 })] });
    const fig = region('Net worth').querySelector('.nw-fig').textContent;
    expect(fig).toContain('100');
    expect(fig).not.toMatch(/[−+]/);
  });

  it('says it is provisional while a balance isn’t confirmed, naming it with a way to confirm it', async () => {
    open({ accounts: [account('Savings', 'savings'), account('Wallet', 'cash', { balance_as_of: null })] });
    const hero = region('Net worth');
    expect(within(hero).getByText('Provisional')).toBeTruthy();
    expect(within(hero).getByText('Wallet · balance not confirmed')).toBeTruthy();
    await click(within(hero).getByRole('button', { name: 'Confirm' }));
    expect(where()).toBe('/wealth?account=Wallet');
  });

  it('gives the change this month and in 12 months, and the assets, liabilities and runway', () => {
    open({
      accounts: [account('Current', 'checking', { balance: 6000 }), account('Card', 'credit_card', { balance: 1000 })],
      netWorthSnapshots: [
        { snapshot_date: '2025-11-01', assets: 4000, liabilities: 0 },
        { snapshot_date: '2026-10-01', assets: 4500, liabilities: 0 },
      ],
      transactions: [
        { id: 't9', account_id: 'Current', amount: -1000, kind: 'expense', occurred_at: '2026-09-10', is_shared: true },
        { id: 't10', account_id: 'Current', amount: -1000, kind: 'expense', occurred_at: '2026-10-10', is_shared: true },
      ],
    });
    const hero = region('Net worth');
    expect(hero.textContent).toMatch(/▲ 500 this month · \+25% in 12 months/);
    const fig = (label) => within(hero).getByText(label, { selector: 'dt' }).closest('div').textContent;
    expect(fig('Assets')).toMatch(/6,000/);
    expect(fig('Liabilities')).toMatch(/−1,000/);
    expect(fig('Runway')).toMatch(/6 months/);
  });
});

describe('Net worth: how it has grown', () => {
  it('says no month has been closed yet rather than promising history', () => {
    open({});
    expect(within(region('How it has grown')).getByText(/No month has been closed yet/)).toBeTruthy();
  });

  it('lists the months as a table, today first, each with its change', () => {
    open({
      accounts: [account('Current', 'checking', { balance: 62000 })],
      netWorthSnapshots: [
        { snapshot_date: '2026-07-01', assets: 90000, liabilities: 50000 },
        { snapshot_date: '2026-08-01', assets: 95000, liabilities: 48000 },
      ],
    });
    const grown = region('How it has grown');
    const rows = [...within(grown).getByText('History as a table').closest('details').querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => c.textContent));
    expect(rows).toEqual([
      ['Today · live', '62,000', '+15,000'],
      ['Aug 26', '47,000', '+7,000'],
      ['Jul 26', '40,000', ''],
    ]);
  });

  it('offers to close the month just ended in Month end, and nothing once it is closed', () => {
    open({ accounts: [account('Current', 'checking')], netWorthSnapshots: [{ snapshot_date: '2026-09-01', assets: 1, liabilities: 0 }] });
    expect(within(region('How it has grown')).getByRole('link', { name: 'Close October' }).getAttribute('href')).toBe('/money?tab=monthend&month=2026-10');
    document.body.innerHTML = '';
    open({ accounts: [account('Current', 'checking')], netWorthSnapshots: [{ snapshot_date: '2026-10-01', assets: 1, liabilities: 0 }] });
    expect(screen.queryByRole('link', { name: /^Close / })).toBeNull();
  });

  it('keeps the household’s history for the household view', () => {
    open({ accounts: [account('Current', 'checking')], netWorthSnapshots: [{ snapshot_date: '2026-10-01', assets: 1, liabilities: 0 }] }, { scope: 'me' });
    expect(within(region('How it has grown')).getByText(/switch to Both/)).toBeTruthy();
  });
});

describe('Net worth: the ledger', () => {
  const ledger = () => ({
    accounts: [
      account('Current', 'checking', { balance: 30000 }),
      account('Savings', 'savings', { balance: 20000, is_shared: false, owner_member_id: 'm1' }),
      account('Wallet', 'cash', { balance_as_of: null }),
      account('Card', 'credit_card', { balance: 400, statement_day: 10, due_day: 25, credit_limit: 1000 }),
      account('Old', 'checking', { archived_at: '2026-06-01T00:00:00Z' }),
    ],
    holdings: [holding('Index fund', 'us_equity', 60000), holding('Gold', 'commodity', 10000)],
    transactions: [{ id: 't', account_id: 'Card', amount: -250, kind: 'expense', occurred_at: '2026-11-12', is_shared: true }],
  });

  it('lists the assets by type with each group’s total, the investments as one row, and the total', () => {
    open(ledger());
    const assets = region('Assets');
    const rows = [...assets.querySelectorAll('tbody tr')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    expect(rows[0]).toMatch(/^Current accounts.*30,000$/);
    expect(rows.some((r) => /^Investments.*2 holdings.*70,000/.test(r))).toBe(true);
    expect(rows.at(-1)).toMatch(/^Total assets.*121,000$/);
    expect(within(assets).queryByText('Index fund')).toBeNull();
  });

  it('opens an account from its row, and the investments from theirs', async () => {
    open(ledger());
    await click(within(region('Assets')).getByRole('button', { name: 'Savings' }));
    expect(where()).toBe('/wealth?account=Savings');
    await click(within(region('Assets')).getByRole('button', { name: /^Investments/ }));
    expect(where()).toBe('/wealth?tab=investments');
  });

  // As the total counts it, so the ledger adds up to the figure above.
  it('marks a balance nobody confirmed, with Confirm, counting it as it stands', async () => {
    open(ledger());
    const row = within(region('Assets')).getByRole('button', { name: 'Wallet' }).closest('tr');
    expect(within(row).getByText('Not confirmed')).toBeTruthy();
    expect(row.textContent).toMatch(/1,000$/);
    await click(within(row).getByRole('button', { name: 'Confirm' }));
    expect(where()).toBe('/wealth?account=Wallet');
  });

  it('groups by owner from the header, shared first', async () => {
    open(ledger());
    await click(screen.getByRole('button', { name: 'By owner' }));
    const groups = [...region('Assets').querySelectorAll('tr.nw-group')].map((r) => r.cells[0].textContent);
    expect(groups).toEqual(['Shared', 'Alex', 'Invested']);
  });

  it('gives a card its cycle and the limit it has used, and the total owed', () => {
    open(ledger());
    const liabilities = region('Liabilities');
    const card = within(liabilities).getByRole('button', { name: 'Card' }).closest('tr');
    expect(card.textContent).toMatch(/250 this cycle · closes in 24d/);
    expect(card.textContent).toMatch(/25% of 1,000/);
    expect(card.textContent).toMatch(/−400/);
    expect([...liabilities.querySelectorAll('tbody tr')].at(-1).textContent).toMatch(/Total liabilities.*−400/);
  });

  it('folds the closed accounts away, each with Reopen', async () => {
    const { reload } = open(ledger());
    const fold = within(region('Liabilities')).getByText('Closed (1)').closest('details');
    await click(within(fold).getByRole('button', { name: 'Reopen' }));
    expect(writes).toEqual([{ table: 'accounts', payload: expect.objectContaining({ archived_at: null }), value: 'Old' }]);
    expect(reload).toHaveBeenCalled();
  });

  it('says what the assets are, in shares', () => {
    open(ledger());
    const legend = region('What the assets are').textContent;
    expect(legend).toMatch(/Cash 42%/);
    expect(legend).toMatch(/US equity 50%/);
    expect(legend).toMatch(/Commodity 8%/);
    expect(region('What the assets are').textContent).toMatch(/121,000 in all/);
  });

  it('adds an account from the header', async () => {
    open({});
    await click(screen.getByRole('button', { name: '+ Account' }));
    expect(where()).toBe('/wealth?account=new');
  });
});

// The outside review, E-03: a net worth worked out without the holdings (or
// accounts) that failed to load is not the household's.
describe('Net worth: a read that failed', () => {
  it('shows no total without its accounts and holdings', () => {
    open({ accounts: [account('Bank', 'checking')], errors: { holdings: 'timeout' }, loaded: { accounts: true } });
    expect(screen.getByText('Couldn’t load investments.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Net worth' })).toBeNull();
  });
});

// The fresh review of 5a.
describe('Net worth: after the fresh review', () => {
  const card = (id, extra = {}) => account(id, 'credit_card', { statement_day: 10, due_day: 25, credit_limit: 1000, ...extra });

  it('shows a card in credit as money held, so the liabilities add up to their total', () => {
    open({ accounts: [card('Owing', { balance: 1000 }), card('In credit', { balance: -500 })] });
    const liabilities = region('Liabilities');
    const owed = (name) => within(liabilities).getByRole('button', { name }).closest('tr').cells[3].textContent;
    expect(owed('Owing')).toBe('−1,000');
    expect(owed('In credit')).toBe('500');
    expect([...liabilities.querySelectorAll('tbody tr')].at(-1).textContent).toMatch(/Total liabilities.*−500$/);
    expect(within(region('Net worth')).getByText('Liabilities', { selector: 'dt' }).closest('div').textContent).toMatch(/−500$/);
  });

  it('owes nothing without a sign, and says a cycle of refunds is money back, closing today on the statement day', () => {
    vi.setSystemTime(new Date('2026-12-10T12:00:00'));
    open({ accounts: [card('Card', { balance: 0 })], transactions: [{ id: 'r', account_id: 'Card', amount: 120, kind: 'refund', occurred_at: '2026-12-01', is_shared: true }] });
    const row = within(region('Liabilities')).getByRole('button', { name: 'Card' }).closest('tr');
    expect(row.cells[3].textContent).toBe('0');
    expect(row.textContent).toMatch(/−120 this cycle · closes today/);
    expect(row.textContent).toMatch(/0% of 1,000/);
  });

  it('leaves sold holdings out of the investments row', () => {
    const sold = { ...holding('Sold fund', 'us_equity', 0), trades_version: 2, quantity: 0, priced_at: '2026-01-01T00:00:00Z', last_refreshed: '2026-01-01T00:00:00Z' };
    open({ holdings: [holding('Index fund', 'us_equity', 60000), sold] });
    const row = within(region('Assets')).getByRole('button', { name: /^Investments/ }).closest('tr');
    expect(row.textContent).toMatch(/1 holding/);
    expect(row.textContent).not.toMatch(/stale/);
  });

  it('confirms an unconfirmed card on its details', async () => {
    open({ accounts: [card('Card', { balance_as_of: null })] });
    await click(within(region('Net worth')).getByRole('button', { name: 'Confirm' }));
    expect(where()).toBe('/wealth?account=Card&view=details');
  });

  it('gives a card’s limit in the display currency', () => {
    window.localStorage.setItem('rokda:currency', 'USD');
    open({ accounts: [card('Card', { credit_limit: 3672.5 })], transactions: [{ id: 't', account_id: 'Card', amount: -367.25, kind: 'expense', occurred_at: '2026-11-12', is_shared: true }] });
    const row = within(region('Liabilities')).getByRole('button', { name: 'Card' }).closest('tr');
    expect(row.textContent).toMatch(/10% of 1,000/);
  });

  it('says a limit in another currency can’t be compared with AED spending', () => {
    open({ accounts: [card('Dollars', { currency: 'USD', balance: 100, balance_aed: 367 })] });
    const row = within(region('Liabilities')).getByRole('button', { name: 'Dollars' }).closest('tr');
    expect(row.textContent).toMatch(/USD 1,000 limit · not comparable with AED spending/);
  });

  // Opened from the page, so closing it goes back rather than leaving an
  // entry behind for Back to land on.
  it('opens an account as a step Back can undo', async () => {
    open({ accounts: [account('Current', 'checking')] });
    await click(within(region('Assets')).getByRole('button', { name: 'Current' }));
    expect(JSON.parse(screen.getByTestId('state').textContent)).toEqual({ drawer: true });
  });
});
