import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import { act, useState } from 'react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';

// The account drawer (the revamp, phase 5a; design/prototype openAccount,
// cycleBody, cardStatements): an account opened through the address,
// `?account=`, from Net worth's ledger or a link on another page. A card
// opens on its running cycle, with its statements and details a tab away.
const writes = [];
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      insert: (row) => {
        writes.push({ table, insert: row });
        return Promise.resolve({ error: null });
      },
      update: (payload) => ({
        eq: (column, value) => {
          writes.push({ table, update: payload, value });
          const result = Promise.resolve({ data: [{ id: value }], error: null });
          result.select = () => Promise.resolve({ data: [{ id: value }], error: null });
          return result;
        },
      }),
    }),
  },
}));

const { default: AccountDrawer } = await import('./AccountDrawer');

const MEMBERS = [{ id: 'm1', display_name: 'Alex' }];
const RECENT = '2026-11-02T09:00:00Z';
const account = (id, type, extra = {}) => ({ id, name: id, type, currency: 'AED', balance: 1000, is_shared: true, owner_member_id: null, archived_at: null, balance_as_of: RECENT, credit_limit: null, statement_day: null, due_day: null, principal: null, interest_rate_pct: null, compounding: null, opened_date: null, maturity_date: null, ...extra });
const CARD = account('Card', 'credit_card', { balance: 400, statement_day: 10, due_day: 25, credit_limit: 1000 });
const tx = (id, amount, occurred_at, extra = {}) => ({ id, account_id: 'Card', amount, occurred_at, kind: amount < 0 ? 'expense' : 'refund', merchant: id, category_id: null, is_shared: true, ...extra });

function Where() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <>
      <output data-testid="where">{location.pathname + location.search}</output>
      <output data-testid="type">{type}</output>
    </>
  );
}

function open(entry, data = {}) {
  const reload = vi.fn().mockResolvedValue(undefined);
  renderScreen(
    <MemoryRouter initialEntries={[entry]}>
      <Where />
      <AccountDrawer household={{ id: 'hh' }} me={MEMBERS[0]} members={MEMBERS} data={{ accounts: [account('Current', 'checking'), CARD], transactions: [], statementReconciliations: [], categories: [], reload, ...data }} />
    </MemoryRouter>,
  );
  return { reload };
}
const where = () => screen.getByTestId('where').textContent;
const dialog = () => screen.getByRole('dialog');
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

describe('The account drawer', () => {
  it('opens nothing for an address that names no account', () => {
    open('/wealth?account=missing');
    expect(screen.queryByRole('dialog')).toBeNull();
    document.body.innerHTML = '';
    open('/wealth');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds an account, its type chosen in the drawer', async () => {
    const { reload } = open('/wealth?account=new');
    expect(screen.getByRole('dialog', { name: 'Add an account' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Travel card' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'credit_card' } });
    await click(screen.getByRole('button', { name: 'Add account' }));
    expect(writes[0]).toMatchObject({ table: 'accounts', insert: { name: 'Travel card', type: 'credit_card' } });
    expect(reload).toHaveBeenCalled();
    expect(where()).toBe('/wealth');
  });

  it('opens an account’s details, and closing it leaves the page it was on', async () => {
    open('/wealth?tab=networth&account=Current');
    expect(screen.getByRole('dialog', { name: 'Current' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByLabelText('Name').value).toBe('Current');
    await click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(where()).toBe('/wealth?tab=networth');
  });

  it('opens a card on This cycle: owed, spent, limit used, the cycle, the payment due and its transactions', () => {
    open('/wealth?account=Card', {
      transactions: [tx('Grocer', -250, '2026-11-12'), tx('Cafe', -40, '2026-11-14'), tx('Earlier', -999, '2026-11-09')],
      statementReconciliations: [{ id: 'r', account_id: 'Card', statement_date: '2026-11-10', period_start: '2026-10-11', due_date: '2026-11-25', status: 'waiting', statement_balance: 700 }],
    });
    const drawer = screen.getByRole('dialog', { name: 'Card' });
    expect(within(drawer).getByRole('tab', { name: 'This cycle' }).getAttribute('aria-selected')).toBe('true');
    const kpi = (label) => within(drawer).getByText(label, { selector: 'dt' }).closest('.ds-kpi').textContent;
    expect(kpi('Owed')).toMatch(/400.*checked 2 Nov/);
    expect(kpi('Spent this cycle')).toMatch(/290.*2 transactions/);
    expect(kpi('Limit used')).toMatch(/29%.*of 1,000/);
    expect(drawer.textContent).toMatch(/11 Nov – 10 Dec · closes in 24d/);
    expect(drawer.textContent).toMatch(/25 Nov · 700\.00 for the statement to 10 Nov/);
    const rows = [...within(drawer).getByRole('table').querySelectorAll('tbody tr')].map((r) => r.cells[1].textContent);
    expect(rows).toEqual(['Cafe', 'Grocer']);
    expect(within(drawer).getByRole('link', { name: 'All transactions on this card' }).getAttribute('href')).toBe('/money?tab=activity&who=both&acct=Card&range=all');
  });

  it('lists the card’s statements a tab away, with the way to check them in Month end', async () => {
    open('/wealth?account=Card', { statementReconciliations: [{ id: 'r', account_id: 'Card', statement_date: '2026-10-10', period_start: '2026-09-11', status: 'confirmed' }] });
    await click(screen.getByRole('tab', { name: 'Statements' }));
    expect(where()).toBe('/wealth?account=Card&view=statements');
    const drawer = dialog();
    expect(within(drawer).getByText('Closes on the 10th · due on the 25th')).toBeTruthy();
    expect(within(drawer).getByText('11 Oct – 10 Nov').closest('tr').textContent).toMatch(/To check/);
    expect(within(drawer).getByText('11 Sep – 10 Oct').closest('tr').textContent).toMatch(/Checked/);
    expect(within(drawer).getByRole('link', { name: 'Check statements in Month end' }).getAttribute('href')).toBe('/money?tab=monthend');
  });

  it('asks before leaving a card’s details with changes in them', async () => {
    open('/wealth?account=Card&view=details');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    await click(screen.getByRole('tab', { name: 'This cycle' }));
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    expect(screen.getByLabelText('Name').value).toBe('Renamed');
    await click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('tab', { name: 'This cycle' }).getAttribute('aria-selected')).toBe('true');
  });

  it('saves an account’s details and closes, reading the records again', async () => {
    const { reload } = open('/wealth?account=Current');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main current' } });
    await click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes[0]).toMatchObject({ table: 'accounts', update: { name: 'Main current' }, value: 'Current' });
    expect(reload).toHaveBeenCalled();
    expect(where()).toBe('/wealth');
  });
});

// The fresh review of 5a.
describe('The account drawer: after the fresh review', () => {
  // SHR-367: a trade moves a broker fund's balance while its editor may be
  // open, and a refresh brings the new balance in; saving a rename must not
  // send the balance the drawer opened with.
  it('saves a rename without the balance it opened with, after the balance moved underneath it', async () => {
    const fund = account('Fund', 'broker_funds', { balance: 5000 });
    function Host() {
      const [accounts, setAccounts] = useState([fund]);
      return (
        <>
          <button type="button" onClick={() => setAccounts([{ ...fund, balance: 3000 }])}>
            Refresh
          </button>
          <AccountDrawer household={{ id: 'hh' }} me={MEMBERS[0]} members={MEMBERS} data={{ accounts, transactions: [], statementReconciliations: [], categories: [], reload: vi.fn().mockResolvedValue(undefined) }} />
        </>
      );
    }
    renderScreen(
      <MemoryRouter initialEntries={['/wealth?account=Fund']}>
        <Host />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Broker cash' } });
    await click(screen.getByRole('button', { name: 'Refresh' }));
    await click(screen.getByRole('button', { name: 'Save changes' }));
    expect(writes[0].update.name).toBe('Broker cash');
    expect(writes[0].update).not.toHaveProperty('balance');
  });

  // The fresh review of 5b: reading the records again before closing left
  // Save live for that second; pressed again it saved twice and the second
  // close went back past the page. The drawer closes at once.
  it('closes at once on a save, before the records are read again', async () => {
    let finish;
    const reload = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    renderScreen(
      <MemoryRouter initialEntries={['/wealth', { pathname: '/wealth', search: '?account=Current', state: { drawer: true } }]} initialIndex={1}>
        <Where />
        <AccountDrawer household={{ id: 'hh' }} me={MEMBERS[0]} members={MEMBERS} data={{ accounts: [account('Current', 'checking')], transactions: [], statementReconciliations: [], categories: [], reload }} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main current' } });
    await click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe('/wealth');
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(where()).toBe('/wealth');
    expect(writes.filter((w) => w.update)).toHaveLength(1);
  });

  it('closes back to the page that opened it, and replaces a link’s address', async () => {
    renderScreen(
      <MemoryRouter initialEntries={['/wealth', { pathname: '/wealth', search: '?account=Current', state: { drawer: true } }]} initialIndex={1}>
        <Where />
        <AccountDrawer household={{ id: 'hh' }} me={MEMBERS[0]} members={MEMBERS} data={{ accounts: [account('Current', 'checking')], transactions: [], statementReconciliations: [], categories: [], reload: vi.fn() }} />
      </MemoryRouter>,
    );
    await click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect([where(), screen.getByTestId('type').textContent]).toEqual(['/wealth', 'POP']);
    document.body.innerHTML = '';
    open('/wealth?account=Current');
    await click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect([where(), screen.getByTestId('type').textContent]).toEqual(['/wealth', 'REPLACE']);
  });

  it('says a card’s limit in another currency can’t be compared, and gives what it owes in that currency', () => {
    const dollars = account('Dollars', 'credit_card', { currency: 'USD', balance: 100, balance_aed: 367.25, statement_day: 10, due_day: 25, credit_limit: 1000 });
    open('/wealth?account=Dollars', { accounts: [dollars] });
    const kpi = (label) => within(dialog()).getByText(label, { selector: 'dt' }).closest('.ds-kpi').textContent;
    expect(kpi('Limit used')).toMatch(/USD 1,000 limit · not comparable with AED spending/);
    expect(kpi('Owed')).toMatch(/USD 100/);
  });

  it('gives the payment due in the display currency', () => {
    window.localStorage.setItem('rokda:currency', 'USD');
    open('/wealth?account=Card', { statementReconciliations: [{ id: 'r', account_id: 'Card', statement_date: '2026-11-10', period_start: '2026-10-11', due_date: '2026-11-25', status: 'waiting', statement_balance: 3672.5 }] });
    expect(dialog().textContent).toMatch(/25 Nov · 1,000\.00 for the statement to 10 Nov/);
  });

  it('keeps the keyboard on the tabs when Details is chosen', async () => {
    open('/wealth?account=Card&view=statements');
    const statements = screen.getByRole('tab', { name: 'Statements' });
    statements.focus();
    await act(async () => {
      fireEvent.keyDown(statements, { key: 'ArrowRight' });
    });
    expect(where()).toBe('/wealth?account=Card&view=details');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Details' }));
  });

  it('says it shows the whole card in one person’s view', () => {
    window.localStorage.setItem('rokda.scope', 'me');
    open('/wealth?account=Card');
    expect(within(dialog()).getByText('The whole card, for both of you.')).toBeTruthy();
  });
});
