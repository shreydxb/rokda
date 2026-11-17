import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup, within } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderScreen } from '../../test/renderScreen';
import { householdToday } from '../../lib/day';
import { addDays } from '../../lib/dividendHistory';
import { shortDate } from '../../lib/dividends';
import { couldntLoad } from '../../lib/loadState';

// The dividend functions, answered per name, every call recorded.
const calls = [];
let answers = {};
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name, args) => {
      calls.push({ name, args });
      const answer = answers[name];
      return { data: (typeof answer === 'function' ? answer(args) : answer) ?? null, error: null };
    },
  },
}));

const { default: Dividends } = await import('./Dividends');

const TODAY = householdToday();
const ago = (n) => addDays(TODAY, -n);
const ahead = (n) => addDays(TODAY, n);
const US = { id: 'h-us', name: 'ABC', asset_class: 'us_equity', currency: 'USD', price_symbol: 'ABC', price_provider: 'twelvedata', quantity: 10,
  is_shared: true, owner_member_id: null, funds_account_id: 'f-usd', sector: 'technology', dividend_tax_pct: 30, dividend_fee_per_share: 0, current_price: 50, avg_price: 40 };
const IN = { id: 'h-in', name: 'XYZ', asset_class: 'india_equity', currency: 'INR', price_symbol: 'XYZ.NS', price_provider: 'yahoo', quantity: 100,
  is_shared: true, owner_member_id: null, funds_account_id: 'f-inr', sector: null, dividend_tax_pct: 20.8, dividend_fee_per_share: 0, current_price: 500, avg_price: 400 };
const ACCOUNTS = [
  { id: 'f-usd', name: 'Dollar broker funds', type: 'broker_funds', currency: 'USD', dividends_into_account_id: null, archived_at: null, balance_as_of: null },
  { id: 'f-inr', name: 'Rupee broker funds', type: 'broker_funds', currency: 'INR', dividends_into_account_id: 'a-inr', archived_at: null },
  { id: 'a-inr', name: 'Rupee bank', type: 'checking', currency: 'INR', archived_at: null },
];
const div = (id, holding, extra) => ({ id, holding_id: holding.id, currency: holding.currency, review_reason: null, review_event_id: null, event_id: null, ex_date: null,
  pay_date: null, credited_on: null, units: 10, per_share: 1, tax_pct: 30, expected_gross: 10, expected_tax: 3, expected_fees: 0, expected_net: 7, received_net: null, version: 1, ...extra });
const event = (id, symbol, ex_date, amount, extra = {}) => ({ id, symbol, ex_date, amount, pay_date: null, superseded_by: null, missed_checks: 0, currency: 'USD', ...extra });

function data(over = {}) {
  return {
    holdings: [US, IN],
    holdingDividends: [
      div('d1', US, { status: 'received', ex_date: ago(60), credited_on: ago(40), received_net: 7, paid_into_account_id: 'f-usd' }),
      div('d2', IN, { status: 'presumed', ex_date: ago(90), credited_on: ago(60), expected_net: 500, paid_into_account_id: 'a-inr' }),
      div('d5', US, { status: 'earned', ex_date: ago(5), pay_date: ahead(5), paid_into_account_id: 'f-usd' }),
      div('d7', IN, { status: 'received', ex_date: ago(100), credited_on: ago(80), received_net: 400, review_reason: 'feed_changed', paid_into_account_id: 'a-inr' }),
    ],
    holdingTrades: [
      { holding_id: 'h-us', kind: 'opening', trade_date: ago(60) },
      { holding_id: 'h-in', kind: 'opening', trade_date: ago(430) },
    ],
    dividendEvents: [
      event('e1', 'ABC', ago(300), 1), event('e2', 'ABC', ago(210), 1), event('e3', 'ABC', ago(120), 1), event('e4', 'ABC', ago(30), 5),
      event('e-dec', 'ABC', ahead(10), 1, { pay_date: ahead(20) }),
      event('e-in1', 'XYZ.NS', ago(400), 5, { currency: 'INR' }), event('e-in2', 'XYZ.NS', ago(35), 5, { currency: 'INR' }),
    ],
    dividendSplits: [],
    dividendSpecialParts: [],
    dividendFeedStatus: [
      { symbol: 'ABC', provider: 'alphavantage', kind: 'dividends', last_success_at: `${TODAY}T01:30:00Z`, fail_count: 0, covered_from: '2010-01-01' },
      { symbol: 'XYZ.NS', provider: 'yahoo', kind: 'dividends', last_success_at: `${TODAY}T01:30:00Z`, fail_count: 0, covered_from: '2005-01-01' },
    ],
    accounts: ACCOUNTS,
    fxRateHistory: [{ base: 'AED', quote: 'INR', day: '2020-01-01', rate: 25 }],
    transactions: [1, 2, 3, 4].map((m) => ({ amount: -1000, kind: 'expense', occurred_at: addDays(`${TODAY.slice(0, 7)}-15`, -31 * m), is_shared: true, category_id: 'c' })),
    errors: {},
    loaded: {},
    reload: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const HOUSEHOLD = { id: 'hh', inr_per_aed: 25 };
const ME = { id: 'm1' };
const MEMBERS = [{ id: 'm1', display_name: 'One' }, { id: 'm2', display_name: 'Two' }];

beforeEach(() => {
  calls.length = 0;
  answers = {};
  cleanup();
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}
const where = () => screen.getByTestId('where').textContent;

function open(d = data(), { loading = false } = {}) {
  renderScreen(
    <MemoryRouter initialEntries={['/wealth?tab=dividends']}>
      <Where />
      <Dividends household={HOUSEHOLD} members={MEMBERS} me={ME} data={d} loading={loading} />
    </MemoryRouter>,
  );
  return d;
}
const section = (name) => screen.getByRole('region', { name });
const kpi = (label) => screen.getByText(label, { selector: 'dt' }).closest('.ds-kpi');
const kpiLabels = () => [...document.querySelectorAll('.ds-kpi dt')].map((d) => d.textContent);

// Wealth -> Dividends as the prototype lays it out (the revamp, phase 5c;
// design/prototype needsCard, divKpis, byMonthCard, comingCard,
// byHoldingCard): Income, with Tax years a view away.

describe('Dividends: the strip', () => {
  it('says what came in and how much was presumed, what is expected against the last twelve months, a month, and of spending', () => {
    open();
    expect(kpiLabels()).toEqual(['Received · 12 months', 'Expected · 12 months', 'A month', 'Of spending']);
    expect(kpi('Received · 12 months').textContent).toMatch(/AED \S+ presumed/);
    expect(kpi('Expected · 12 months').textContent).toMatch(/[+−]\d+(\.\d)?% on the last 12/);
    expect(kpi('A month').textContent).toMatch(/^A monthabout AED \S+$/);
    expect(kpi('Of spending').textContent).toMatch(/[\d.]+%expected, of recorded spending/);
  });

  // What the figures leave out, and where each market's record starts, sit
  // behind the Received (i) (they were "How fresh this is" and lines under
  // the headline).
  it('keeps what the figures leave out, and where each market is counted from, behind an (i)', () => {
    open();
    expect(screen.queryByText(/units held then are unknown/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About Received' }));
    expect(screen.getByText(/units held then are unknown/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`Indian dividends are counted from ${shortDate(ago(430))}, US from ${shortDate(ago(60))}\\.`))).toBeTruthy();
  });

  it('a record shorter than twelve months says since when, and sets nothing against it', () => {
    const d = data();
    open(data({ holdings: [US], holdingDividends: d.holdingDividends.filter((x) => x.holding_id === 'h-us'), holdingTrades: [d.holdingTrades[0]] }));
    expect(kpiLabels()[0]).toBe(`Received since ${shortDate(ago(60))}`);
    expect(kpi('Expected · 12 months').textContent).not.toMatch(/on the last 12/);
  });
});

describe('Dividends: what is not recorded or projected', () => {
  it("a market with no opening entry is a warning in By holding, and so is its holding's row", () => {
    const d = data();
    open(data({ holdingTrades: [d.holdingTrades[0]], holdingDividends: d.holdingDividends.filter((x) => x.holding_id === 'h-us') }));
    const byHolding = section('By holding');
    expect(within(byHolding).getByText("Indian dividends aren't recorded until an Indian holding has an opening entry.")).toBeTruthy();
    expect(within(byHolding).getByRole('button', { name: 'XYZ' }).closest('tr').textContent).toMatch(/no opening entry/);
  });

  it("a holding too new to project shows no zero, and Expected says one isn't projected", () => {
    const NEW = { ...US, id: 'h-new', name: 'FRESH', price_symbol: 'FRESH' };
    const d = data();
    open(data({
      holdings: [US, IN, NEW],
      holdingTrades: [...d.holdingTrades, { holding_id: 'h-new', kind: 'opening', trade_date: ago(60) }],
      dividendEvents: [...d.dividendEvents, event('e-new', 'FRESH', ago(30), 1)],
      dividendFeedStatus: [...d.dividendFeedStatus, { symbol: 'FRESH', provider: 'alphavantage', kind: 'dividends', last_success_at: `${TODAY}T01:30:00Z`, fail_count: 0, covered_from: ago(60) }],
    }));
    expect(kpi('Expected · 12 months').textContent).toContain('1 holding not projected');
    const row = within(section('By holding')).getByRole('button', { name: 'FRESH' }).closest('tr');
    expect([...row.querySelectorAll('td')].slice(5, 8).map((td) => td.textContent)).toEqual(['—', '—', '—']);
  });
});

describe('Dividends: needs you', () => {
  it('is the one boxed card, only while something waits', () => {
    open();
    expect(section('Needs you').closest('.ds-card-action')).toBeTruthy();
    cleanup();
    const d = data();
    open(data({ holdingDividends: d.holdingDividends.map((x) => ({ ...x, review_reason: null })), dividendEvents: d.dividendEvents.filter((e) => e.id !== 'e4') }));
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
  });

  it('shows why a row is flagged, opening its holding to review it, and asks about a one-off', async () => {
    const d = open();
    const needs = section('Needs you');
    expect(within(needs).getByText("The feed's amount per share has changed since this was recorded.")).toBeTruthy();
    expect(within(needs).getByText(`ABC paid USD 5.00 a share on ${shortDate(ago(30))}, more than twice its usual. Was part of it a one-off?`)).toBeTruthy();
    answers.set_special_part = { ok: true };
    await act(async () => {
      fireEvent.click(within(needs).getByRole('button', { name: 'Yes, part was a one-off' }));
    });
    expect(calls).toEqual([{ name: 'set_special_part', args: { p_event_id: 'e4', p_special_per_share: 4 } }]);
    expect(d.reload).toHaveBeenCalled();
    fireEvent.click(within(needs).getByRole('button', { name: 'Review' }));
    expect(where()).toBe('/wealth?tab=dividends&holding=h-in&view=dividends');
  });

  it('a one-off answered "all ordinary" is recorded as no special part', async () => {
    open();
    answers.set_special_part = { ok: true };
    await act(async () => {
      fireEvent.click(within(section('Needs you')).getByRole('button', { name: 'No, all ordinary' }));
    });
    expect(calls).toEqual([{ name: 'set_special_part', args: { p_event_id: 'e4', p_special_per_share: 0 } }]);
  });

  it("a split the trades don't show opens the holding's trades, with no Review that can't settle it", () => {
    open(data({ dividendSplits: [{ symbol: 'ABC', effective_date: ago(20), ratio: 2 }] }));
    const row = within(section('Needs you')).getByText(`ABC split 2 for 1 on ${shortDate(ago(20))}, but its trades don't show it.`).closest('li');
    expect(within(row).queryByRole('button', { name: 'Review' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Record the split' }));
    expect(where()).toBe('/wealth?tab=dividends&holding=h-us&view=trades');
  });
});

describe('Dividends: coming up', () => {
  it('lists what is earned or declared with its date, and an earned one into a fund can be recorded', async () => {
    const d = open();
    const rows = within(section('Coming up')).getAllByRole('listitem');
    expect(rows[0].textContent).toContain('ABC');
    expect(rows[0].textContent).toContain('Earned');
    expect(rows[1].textContent).toContain('Declared');
    expect(rows[1].textContent).toContain(shortDate(ahead(20)).replace(/ \d{4}$/, ''));
    expect(rows[1].textContent).toContain('into Dollar broker funds');
    expect(within(rows[1]).queryByRole('button', { name: 'Record' })).toBeNull();

    answers.preview_dividend = { ok: true, dividend: { ...data().holdingDividends[2], status: 'received', received_net: 7 }, movements: [], confirmations: {}, version: 1, asks: null };
    answers.save_dividend = { ok: true };
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Record' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save dividend' }));
    });
    expect(calls.at(-1)).toMatchObject({ name: 'save_dividend', args: { p_dividend_id: 'd5' } });
    expect(d.reload).toHaveBeenCalled();
  });

  // A row's other actions sit under "⋯" (design note).
  it("keeps an earned row's Fix and Skip under ⋯", () => {
    open();
    const [earned] = within(section('Coming up')).getAllByRole('listitem');
    fireEvent.click(within(earned).getByRole('button', { name: 'More for ABC' }));
    fireEvent.click(within(earned).getByRole('button', { name: 'Fix' }));
    expect(within(earned).getByRole('button', { name: 'Check' })).toBeTruthy();
  });
});

describe('Dividends: by month', () => {
  it('draws the last twelve months and the next twelve, with this year so far and next year expected, and an earned view that counts what it cannot place', () => {
    const d = data();
    d.holdingDividends = [...d.holdingDividends, div('d8', US, { status: 'received', ex_date: null, credited_on: ago(20), received_net: 7, paid_into_account_id: 'f-usd' })];
    open(d);
    const months = section('By month');
    expect(within(months).getByRole('group', { name: /^Dividends received by month/ })).toBeTruthy();
    const readout = () => months.querySelector('.dv-readout').textContent;
    expect(readout()).toMatch(new RegExp(`${TODAY.slice(0, 4)} so far AED \\S+`));
    // Next year as far as the twelve months ahead reach, saying which months.
    expect(readout()).toMatch(new RegExp(`${Number(TODAY.slice(0, 4)) + 1} expected( \\(Jan–\\w{3}\\))? AED \\S+`));
    expect(within(months).queryByText("1 receipt with no ex-date isn't shown.")).toBeNull();
    fireEvent.keyDown(within(months).getByRole('group', { name: /^Dividends received by month/ }), { key: 'Home' });
    expect(readout()).toMatch(/^\w{3} \d{4}: /);
    fireEvent.click(within(months).getByRole('button', { name: 'Earned' }));
    expect(within(months).getByText("1 receipt with no ex-date isn't shown.")).toBeTruthy();
  });
});

describe('Dividends: by holding', () => {
  it('groups the holdings by market with its withholding, each row opening the holding on its dividends; the rest folded with why', () => {
    const quiet = { ...US, id: 'h-quiet', name: 'QUIET', price_symbol: 'QUIET' };
    const broken = { ...US, id: 'h-broken', name: 'BROKEN', price_symbol: 'BROKEN' };
    const fresh = { ...US, id: 'h-fresh', name: 'FRESH', price_symbol: 'FRESH' };
    const d = data({ holdings: [US, IN, quiet, broken, fresh] });
    d.dividendFeedStatus = [
      ...d.dividendFeedStatus,
      { symbol: 'QUIET', provider: 'alphavantage', kind: 'dividends', last_success_at: `${TODAY}T01:30:00Z`, fail_count: 0, covered_from: '2016-03-01' },
      { symbol: 'BROKEN', provider: 'alphavantage', kind: 'dividends', last_success_at: null, fail_count: 3, covered_from: null },
    ];
    open(d);
    const byHolding = section('By holding');
    const groups = [...byHolding.querySelectorAll('tr.dv-group')].map((r) => r.textContent);
    expect(groups[0]).toMatch(/^US · 30% withheld/);
    expect(groups[1]).toMatch(/^India · 20.8% withheld/);
    const abc = within(byHolding).getByRole('button', { name: 'ABC' }).closest('tr');
    expect(abc.textContent).toContain('Half-yearly');
    expect(abc.textContent).toContain('Technology');
    // The earned one pays before the declared one.
    expect(abc.textContent).toContain(shortDate(ahead(5)));
    fireEvent.click(within(byHolding).getByRole('button', { name: 'ABC' }));
    expect(where()).toBe('/wealth?tab=dividends&holding=h-us&view=dividends');
    expect(within(byHolding).getByText('Not paying or not checked (3)')).toBeTruthy();
    expect(within(byHolding).getByText(`No dividends found since ${shortDate('2016-03-01')}`)).toBeTruthy();
    expect(within(byHolding).getByText('Checks failing')).toBeTruthy();
    expect(within(byHolding).getByText('Not checked yet')).toBeTruthy();
  });
});

// "Where it comes from" and "How fresh this is" go: the market grouping and
// the Feed chip say them (design note).
describe('Dividends: the Feed chip', () => {
  it('says when the feed last checked, and each market behind it', () => {
    open();
    expect(screen.queryByRole('region', { name: 'Where it comes from' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'How fresh this is' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Feed: checked / }));
    expect(screen.getByText(/^US: checked /)).toBeTruthy();
    expect(screen.getByText(/^India: checked /)).toBeTruthy();
  });

  it('turns amber naming the share whose check fails', () => {
    const d = data();
    d.dividendFeedStatus = [{ ...d.dividendFeedStatus[0], fail_count: 2, last_success_at: '2026-10-30T01:30:00Z' }, d.dividendFeedStatus[1]];
    open(d);
    const chip = screen.getByRole('button', { name: 'Feed: ABC failing' });
    expect(chip.className).toContain('ds-chip-warn');
    fireEvent.click(chip);
    expect(screen.getByText(/^Checks failing for ABC since /)).toBeTruthy();
  });

  it("says when the feed hasn't run yet", () => {
    open(data({ dividendFeedStatus: [] }));
    expect(screen.getByRole('button', { name: 'Feed: not checked yet' })).toBeTruthy();
  });
});

describe('Dividends: states', () => {
  it('shows the frame while loading', () => {
    open(data(), { loading: true });
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('says what did not load', () => {
    open(data({ errors: { dividendEvents: 'timeout' }, loaded: {} }));
    expect(screen.getByRole('alert').textContent).toContain(couldntLoad(['dividendEvents']));
  });

  it('says when no holding pays dividends', () => {
    open(data({ holdings: [{ id: 'h-cash', name: 'Cash fund', asset_class: 'cash', is_shared: true }], holdingDividends: [] }));
    expect(screen.getByText('No holdings that pay dividends')).toBeTruthy();
    expect(screen.getByText("US-listed and Indian shares appear here once they're added under Investments.")).toBeTruthy();
  });
});

describe('Dividends: tax years', () => {
  it('are a view of their own, and a tax load failure never hides Income', () => {
    open(data({ errors: { taxReturns: new Error('x') }, loaded: {} }));
    expect(screen.getByText(/^Received/, { selector: 'dt' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tax years' }));
    expect(screen.getByRole('alert').textContent).toMatch(/tax returns/);
  });
});
