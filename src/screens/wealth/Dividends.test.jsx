import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup, within } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';
import { householdToday } from '../../lib/day';
import { addDays } from '../../lib/dividendHistory';
import { monthLabel, shortDate } from '../../lib/dividends';
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

function open(d = data(), { loading = false } = {}) {
  renderScreen(<Dividends household={HOUSEHOLD} members={MEMBERS} me={ME} data={d} loading={loading} />);
  return d;
}
const section = (name) => screen.getByRole('region', { name });

describe('Dividends: the headline', () => {
  it('says what came in, how much was presumed, what is expected, and against spending', () => {
    open();
    const head = section('Dividends at a glance');
    expect(within(head).getByText('Received in the last 12 months')).toBeTruthy();
    expect(within(head).getByText(/^of which AED \S+ presumed, not checked$/)).toBeTruthy();
    expect(within(head).getByText('Expected in the next 12 months')).toBeTruthy();
    expect(within(head).getByText(/^about AED \S+ a month$/)).toBeTruthy();
    expect(within(head).getByText(/^Expected to equal [\d.]+% of recorded spending$/)).toBeTruthy();
    expect(within(head).getByText(/^India: /)).toBeTruthy();
    expect(within(head).getByText(/^US: /)).toBeTruthy();
    expect(within(head).getByText(`Indian dividends are counted from ${shortDate(ago(430))}, US from ${shortDate(ago(60))}.`)).toBeTruthy();
  });
});

describe('Dividends: what is not recorded or projected', () => {
  it("a market with no opening entry says it isn't recorded, and so does its holding", () => {
    const d = data();
    open(data({ holdingTrades: [d.holdingTrades[0]], holdingDividends: d.holdingDividends.filter((x) => x.holding_id === 'h-us') }));
    const head = section('Dividends at a glance');
    expect(within(head).getByText(/^India: nothing recorded, no opening entry · AED \S+ expected$/)).toBeTruthy();
    expect(within(head).getByText("Indian dividends aren't recorded until an Indian holding has an opening entry.")).toBeTruthy();
    expect(within(section('By holding')).getByText(/no opening entry, so its dividends aren't recorded/)).toBeTruthy();
  });

  it("a holding too new to project shows no zero, and the headline says one isn't projected", () => {
    const NEW = { ...US, id: 'h-new', name: 'FRESH', price_symbol: 'FRESH' };
    const d = data();
    open(data({
      holdings: [US, IN, NEW],
      holdingTrades: [...d.holdingTrades, { holding_id: 'h-new', kind: 'opening', trade_date: ago(60) }],
      dividendEvents: [...d.dividendEvents, event('e-new', 'FRESH', ago(30), 1)],
      dividendFeedStatus: [...d.dividendFeedStatus, { symbol: 'FRESH', provider: 'alphavantage', kind: 'dividends', last_success_at: `${TODAY}T01:30:00Z`, fail_count: 0, covered_from: ago(60) }],
    }));
    expect(within(section('Dividends at a glance')).getByText('1 holding not projected: see By holding.')).toBeTruthy();
    const row = within(section('By holding')).getByText(/^FRESH · /).closest('button');
    expect(row.textContent).not.toMatch(/expected|on value|on cost/);
  });

  it("a split the trades don't show says where to record it, with no Review that can't settle it", () => {
    open(data({ dividendSplits: [{ symbol: 'ABC', effective_date: ago(20), ratio: 2 }] }));
    const text = within(section('Needs you')).getByText(`ABC split 2 for 1 on ${shortDate(ago(20))}, but its trades don't show it.`);
    const row = text.closest('li');
    expect(within(row).getByText('Record the split in its trades, under Investments.')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Review' })).toBeNull();
  });
});

describe('Dividends: coming up', () => {
  it('lists the declared dividend with its date, and an earned one into a fund can be recorded', async () => {
    const d = open();
    const coming = section('Coming up');
    const rows = within(coming).getAllByRole('listitem');
    expect(rows[0].textContent).toContain('ABC');
    expect(rows[0].textContent).toContain('Earned');
    expect(rows[1].textContent).toContain('Declared');
    expect(rows[1].textContent).toContain(shortDate(ahead(20)));
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
});

describe('Dividends: needs you', () => {
  it('shows why a row is flagged, and asks about a one-off', async () => {
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
  });

  it('a one-off answered "all ordinary" is recorded as no special part', async () => {
    open();
    answers.set_special_part = { ok: true };
    await act(async () => {
      fireEvent.click(within(section('Needs you')).getByRole('button', { name: 'No, all ordinary' }));
    });
    expect(calls).toEqual([{ name: 'set_special_part', args: { p_event_id: 'e4', p_special_per_share: 0 } }]);
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
    expect(screen.getByText("No holdings that pay dividends. US-listed and Indian shares appear here once they're added under Investments.")).toBeTruthy();
  });

  it('says when the feed has not run yet', () => {
    open(data({ dividendFeedStatus: [] }));
    expect(screen.getByText("The dividend feed hasn't run yet. It checks each night.")).toBeTruthy();
  });
});

describe('Dividends: by month', () => {
  it('draws received, presumed and expected by month, with a total a year, and an earned view that counts what it cannot place', () => {
    const d = data();
    d.holdingDividends = [...d.holdingDividends, div('d8', US, { status: 'received', ex_date: null, credited_on: ago(20), received_net: 7, paid_into_account_id: 'f-usd' })];
    open(d);
    const months = section('By month');
    expect(within(months).getByTitle(new RegExp(`^${monthLabel(ago(40).slice(0, 7))}: AED \\S+ received`))).toBeTruthy();
    expect(within(months).getByTitle(new RegExp(`^${monthLabel(ago(60).slice(0, 7))}: .*AED \\S+ presumed`))).toBeTruthy();
    expect(within(months).getByText(/^Total /)).toBeTruthy();
    expect(within(months).queryByText("1 receipt with no ex-date isn't shown.")).toBeNull();
    fireEvent.click(within(months).getByRole('button', { name: 'Earned' }));
    expect(within(months).getByText("1 receipt with no ex-date isn't shown.")).toBeTruthy();
  });
});

describe('Dividends: by holding', () => {
  it("each holding's frequency, figures and next date; opening one shows its dividends; the rest folded by why", () => {
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
    const abc = within(byHolding).getByRole('button', { name: /^ABC/ });
    expect(abc.closest('li').textContent).toContain('Half-yearly');
    // The earned one pays before the declared one.
    expect(abc.closest('li').textContent).toContain(`next ${shortDate(ahead(5))}`);
    expect(abc.closest('li').textContent).toMatch(/on value/);
    fireEvent.click(abc);
    expect(within(byHolding).getByRole('button', { name: 'Add a dividend' })).toBeTruthy();
    expect(within(byHolding).getByText(`No dividends found since ${shortDate('2016-03-01')}`)).toBeTruthy();
    expect(within(byHolding).getByText('Checks failing')).toBeTruthy();
    expect(within(byHolding).getByText('Not checked yet')).toBeTruthy();
    expect(within(byHolding).getByText('FRESH')).toBeTruthy();
  });
});

describe('Dividends: where it comes from, and how fresh', () => {
  it('splits the next twelve months by market and by sector, unknown last', () => {
    open();
    const sources = section('Where it comes from');
    expect(within(sources).getByText(/^US · AED \S+ · 30% withheld$/)).toBeTruthy();
    expect(within(sources).getByText(/^India · AED \S+ · 20.8% withheld$/)).toBeTruthy();
    const sectors = within(sources).getAllByText(/^(Technology|Unknown) · /).map((n) => n.textContent.split(' · ')[0]);
    expect(sectors).toEqual(['Technology', 'Unknown']);
    expect(within(sources).getByText(`Indian dividends are counted from ${shortDate(ago(430))}, US from ${shortDate(ago(60))}.`)).toBeTruthy();
  });

  it('says when each market was checked, which shares are failing, and what the figures do not claim', () => {
    const d = data();
    d.dividendFeedStatus = [{ ...d.dividendFeedStatus[0], fail_count: 2, last_success_at: '2026-10-30T01:30:00Z' }, d.dividendFeedStatus[1]];
    open(d);
    const fresh = section('How fresh this is');
    expect(within(fresh).getByText(/^Checks failing for ABC since /)).toBeTruthy();
    for (const sentence of [
      "Dividends from before a holding's opening entry aren't counted: the units held then are unknown.",
      "Expected figures are a projection at today's units and exchange rates.",
      "Dividends earned but not yet received aren't in net worth.",
      'The Life plan already counts dividends in its return, so this tab is cash flow, not a second return.',
    ]) {
      expect(within(fresh).getByText(sentence)).toBeTruthy();
    }
  });
});

describe('Dividends: tax years', () => {
  it('a tax load failure never hides the tab', () => {
    open(data({ errors: { taxReturns: new Error('x') }, loaded: {} }));
    expect(section('Dividends at a glance')).toBeTruthy();
    expect(within(section('Tax years')).getByRole('alert').textContent).toMatch(/tax returns/);
  });

  it('comes last in the tab', () => {
    open();
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-labelledby'));
    expect(regions.at(-1)).toBe('dv-tax');
  });
});

