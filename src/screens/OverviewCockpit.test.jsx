// Overview, the cockpit (the revamp, phase 3): what each part does when used,
// and what the fresh review of it found.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderScreen } from '../test/renderScreen';

vi.mock('../lib/supabaseClient', () => ({ supabase: {} }));
vi.mock('../lib/useHousehold', () => ({
  useHousehold: () => ({
    household: { id: 'hh', name: 'Test' },
    members: [
      { id: 'm1', display_name: 'Partner A' },
      { id: 'm2', display_name: 'Partner B' },
    ],
    me: { id: 'm1', display_name: 'Partner A' },
    loading: false,
    error: null,
    reload: () => {},
  }),
}));
const planningOver = {};
vi.mock('./usePlanningData', async () => {
  const { emptyPlanning } = await import('../test/planningStub');
  return { usePlanningData: () => emptyPlanning(planningOver) };
});
// The dividend questions, stubbed: their own tests are in lib/.
const questions = { list: [] };
vi.mock('../lib/dividendSummary', async (importOriginal) => ({ ...(await importOriginal()), needsYou: () => questions.list }));
// The editor, stubbed: it says what it saved, as the real one does.
vi.mock('./money/RecordEditor', () => ({
  default: ({ editing, onSaved }) => (
    <div role="dialog" aria-label="Editor">
      <span data-testid="editing">{JSON.stringify(editing)}</span>
      <button type="button" onClick={() => onSaved({ notice: { text: 'Saved, and remembered a merchant rule.' } })}>
        Save
      </button>
    </div>
  ),
}));

const CHECKING = { id: 'a1', name: 'Current account', type: 'checking', currency: 'AED', balance: 20000, balance_aed: 20000, balance_as_of: '2026-11-14', is_shared: true, owner_member_id: null, archived_at: null };
// Partner B's own card, with statements to check.
const CARD_B = { id: 'c2', name: 'Travel card', type: 'credit_card', currency: 'AED', balance: 0, balance_aed: 0, balance_as_of: '2026-11-14', statement_day: 10, due_day: 25, is_shared: false, owner_member_id: 'm2', archived_at: null, created_at: '2026-01-01' };
const CATEGORIES = [
  { id: 'g', name: 'Groceries', kind: 'expense', parent_id: null },
  { id: 'd', name: 'Dining out', kind: 'expense', parent_id: null },
];
const tx = (id, occurred_at, amount, category_id, over = {}) => ({ id, amount, kind: amount > 0 ? 'income' : 'expense', category_id, account_id: 'a1', occurred_at, is_shared: true, merchant: `Shop ${id}`, ...over });
// Groceries at 300 a month, and 400 by the 15th of this one: running high.
const HISTORY = [tx('h1', '2026-08-10', -300, 'g'), tx('h2', '2026-09-10', -300, 'g'), tx('h3', '2026-10-10', -300, 'g')];
const THIS_MONTH = [tx('t1', '2026-11-10', -400, 'g'), tx('t2', '2026-11-11', -100, 'd')];
// A bill due on the 5th that has not posted: To do offers Mark paid.
const BILL = { id: 'r1', name: 'Gym', amount: -250, cadence: 'monthly', interval_count: 1, next_due_date: '2026-11-05', active: true, autopay: false, is_shared: true, account_id: 'a1', category_id: 'd' };

const state = {};
function reset() {
  Object.assign(state, {
    accounts: [CHECKING],
    transactions: [...HISTORY, ...THIS_MONTH],
    recurring: [BILL],
    budgets: [{ category_id: 'g', year: 2026, month: 11, amount: 1000 }],
    statementReconciliations: [],
    errors: {},
  });
  questions.list = [];
  for (const k of Object.keys(planningOver)) delete planningOver[k];
}

vi.mock('./useOverviewData', async (importOriginal) => ({
  ...(await importOriginal()),
  useOverviewData: () => ({
    loading: false,
    categories: CATEGORIES,
    netWorthSnapshots: [{ id: 's1', snapshot_date: '2026-10-01', assets: 20000, liabilities: 0 }],
    holdings: [],
    backupRecords: [{ id: 'b1', kind: 'export', result: 'passed', done_on: '2026-11-14', created_at: '2026-11-14T10:00:00Z' }],
    loaded: {},
    loadedAt: new Date(),
    reload: async () => {},
    ...state,
  }),
}));

beforeEach(() => {
  reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 15, 12));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

async function open() {
  const { default: Overview } = await import('./Overview');
  return renderScreen(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const asMe = () => localStorage.setItem('rokda.scope', 'me');

describe('Overview cockpit', () => {
  it('opens a new transaction in place from the header', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '+ Transaction' }));
    expect(screen.getByRole('dialog', { name: 'Editor' })).toBeTruthy();
  });

  // The fresh review: dated today, a payment more than a few days after the
  // due date did not settle the bill, and the row stayed "Late".
  it('opens Mark paid filled from the bill, dated the day it was due', async () => {
    await open();
    const todo = screen.getByRole('region', { name: 'To do' });
    fireEvent.click(within(todo).getByRole('button', { name: 'Mark paid' }));
    const editing = JSON.parse(screen.getByTestId('editing').textContent);
    expect(editing.initial).toMatchObject({ merchant: 'Gym', amount: '250', occurred_at: '2026-11-05', account_id: 'a1' });
  });

  // The fresh review: the editor's own notice ("Saved, and remembered…")
  // was dropped on Overview.
  it("says what the editor says after a save", async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '+ Transaction' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByRole('status').textContent).toContain('Saved, and remembered a merchant rule.');
  });

  it('opens the data checks in place from the chip beside the date', async () => {
    await open();
    const chip = screen.getByRole('button', { name: /^Data: / });
    expect(chip.getAttribute('aria-controls')).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.getAttribute('aria-controls')).toBe('ov-quality-panel');
    expect(screen.getByRole('region', { name: 'Data quality' })).toBeTruthy();
  });

  it("opens a category's transactions for the month from Where it went", async () => {
    await open();
    const where = screen.getByRole('region', { name: 'Where it went' });
    fireEvent.click(within(where).getByRole('button', { name: /Groceries/ }));
    const at = screen.getByTestId('where').textContent;
    expect(at).toMatch(/^\/money\?/);
    expect(at).toContain('cat=g');
    expect(at).toContain('from=2026-11-01');
  });

  // The fresh review: What changed used a full month's average against a
  // month to date. It shows Needs attention's own pace check, as decided.
  it('says under What changed a category running ahead of its usual pace', async () => {
    await open();
    const where = screen.getByRole('region', { name: 'Where it went' });
    const changed = within(where).getByRole('link', { name: /Groceries/ });
    expect(changed.textContent).toMatch(/^\+\d+% vs usual pace/);
    expect(within(where).queryByText(/Dining out ·/)).toBeNull();
  });

  it('opens each plan tile on its page', async () => {
    await open();
    const plan = screen.getByRole('region', { name: 'Plan' });
    const hrefs = within(plan)
      .getAllByRole('link')
      .map((l) => l.getAttribute('href'));
    expect(hrefs).toEqual(['/planning?tab=life', '/planning?tab=goals', '/planning?tab=debt', '/planning?tab=plan']);
  });

  it('counts To do in the title, all of it', async () => {
    questions.list = Array.from({ length: 8 }, (_, i) => ({ kind: 'one_off', holdingId: 'x', eventId: `e${i}` }));
    await open();
    const n = Number(screen.getByRole('region', { name: 'To do' }).textContent.match(/(\d+) open/)[1]);
    expect(n).toBeGreaterThan(6);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`${n} things need a decision`);
  });

  it('says All clear with nothing to do', async () => {
    state.recurring = [];
    state.accounts = [];
    state.transactions = [tx('t9', '2026-11-14', -10, 'd')];
    await open();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('All clear');
  });
});

describe('Overview cockpit: one person', () => {
  // The fresh review: the household's closed months joined one person's
  // today, which drew a false drop.
  it('draws no net worth trend for one person', async () => {
    asMe();
    await open();
    expect(screen.queryByRole('group', { name: /Net worth over/ })).toBeNull();
  });

  // The fresh review: one person's share against the household's budget read
  // as well under budget.
  it('leaves the budget track to both of you', async () => {
    await open();
    expect(screen.getByRole('progressbar', { name: 'Budget' })).toBeTruthy();
    document.body.innerHTML = '';
    asMe();
    await open();
    expect(screen.queryByRole('progressbar', { name: 'Budget' })).toBeNull();
  });

  it("leaves the partner's own card statements out of To do", async () => {
    state.accounts = [CHECKING, CARD_B];
    await open();
    expect(screen.getByText('Travel card statement')).toBeTruthy();
    document.body.innerHTML = '';
    asMe();
    await open();
    expect(screen.queryByText('Travel card statement')).toBeNull();
  });

  // The cash to hand is the household's, as the bot's morning check is.
  it("says the cash cover is the household's", async () => {
    asMe();
    await open();
    const next = screen.getByRole('region', { name: 'Next 30 days' });
    expect(next.textContent).toMatch(/household/);
  });
});

describe('Overview cockpit: records that never loaded', () => {
  // The fresh review: with their records unread, every card read "To check"
  // and the title count went up.
  it('raises no statement when the statement records did not load', async () => {
    state.accounts = [CHECKING, CARD_B];
    state.errors = { statementReconciliations: 'network' };
    await open();
    expect(screen.queryByText('Travel card statement')).toBeNull();
  });

  it('asks no dividend question when the dividend records did not load', async () => {
    questions.list = [{ kind: 'one_off', holdingId: 'x', eventId: 'e1' }];
    state.errors = { dividendSpecialParts: 'network' };
    await open();
    expect(screen.queryByText(/dividend$/)).toBeNull();
  });
});

describe('Overview cockpit: Recent', () => {
  // The fresh review: a split record has no category of its own, and was
  // marked Uncategorised though each line is filed.
  it("names a split record's categories, and says when one needs review", async () => {
    state.transactions = [
      tx('s1', '2026-11-14', -150, null, { is_split: true, merchant: 'Hypermarket', transaction_splits: [{ category_id: 'g', amount: -100 }, { category_id: 'd', amount: -50 }] }),
      tx('s2', '2026-11-13', -20, 'd', { merchant: 'Kiosk', needs_review: true }),
    ];
    await open();
    const recent = screen.getByRole('region', { name: 'Recent' });
    const rows = recent.querySelectorAll('.ov-recent-row');
    expect(rows[0].textContent).toContain('Groceries, Dining out');
    expect(rows[0].textContent).not.toContain('Uncategorised');
    expect(rows[1].textContent).toContain('Needs review');
  });
});

describe('Overview cockpit: the Plan strip', () => {
  // The fresh review: Planning's figures are dirhams, and read as the display
  // currency without a label; the warnings Plan shows beside them were gone.
  it('labels its dirham figures, and keeps the provisional warning', async () => {
    localStorage.setItem('rokda:currency', 'USD');
    planningOver.debts = [{ id: 'd1', name: 'Car loan', balance: 40000, apr_pct: 5, minimum_payment: 1000, is_shared: true, owner_member_id: null }];
    state.accounts = [CHECKING, { ...CHECKING, id: 'a9', name: 'Wallet', type: 'cash', balance: null, balance_aed: null, balance_as_of: null }];
    await open();
    const plan = screen.getByRole('region', { name: 'Plan' });
    expect(plan.textContent).toMatch(/AED−40,000/);
    expect(plan.textContent).toContain('Provisional');
  });

  it("says which of its figures are the household's under one person", async () => {
    asMe();
    await open();
    expect(within(screen.getByRole('region', { name: 'Plan' })).getAllByText('Household').length).toBeGreaterThan(0);
  });
});
