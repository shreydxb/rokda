import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup, within } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';
import { shortDate } from '../../lib/dividends';
import { ScopeProvider } from '../../lib/ScopeContext';
import { CurrencyProvider } from '../../lib/CurrencyContext';

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

const { default: TaxYears } = await import('./TaxYears');

const MEMBERS = [{ id: 'm1', display_name: 'One' }, { id: 'm2', display_name: 'Two' }];
const IN_A = { id: 'h-a', name: 'ABC', asset_class: 'india_equity', currency: 'INR', price_symbol: 'ABC.NS', owner_member_id: 'm1', is_shared: false, quantity: 10 };
const IN_S = { id: 'h-s', name: 'Shared Co', asset_class: 'india_equity', currency: 'INR', price_symbol: 'SHR.NS', owner_member_id: null, is_shared: true, quantity: 10 };
const US = { id: 'h-us', name: 'XYZ', asset_class: 'us_equity', currency: 'USD', price_symbol: 'XYZ', owner_member_id: 'm1', is_shared: false, quantity: 10 };
const rec = (id, holding, credited, extra = {}) => ({ id, holding_id: holding.id, status: 'received', credited_on: credited, credited_on_estimated: false,
  expected_gross: 1000, expected_tax: 208, received_gross: 1000, received_tax: 208, tax_financial_year: null, tax_year_basis: null, version: 1, ...extra });
const statement = (id, source, year = 2025) => ({ id, member_id: 'm1', financial_year: year, source, as_of: `${year + 1}-06-15`, revision: 1, imported_at: '2026-11-01T00:00:00Z' });
const RETURN = { id: 'r-25', member_id: 'm1', financial_year: 2025, claim_basis: 'treaty', claim_rate_pct: 10, revision: 1, filed_on: '2026-07-20',
  dividend_income: 1000, dividend_tax: 100, dividend_tds_claimed: 208, tds_claimed_total: 5000, note: null, version: 4 };
const EVENTS = [
  { id: 'e1', return_id: 'r-25', revision: 1, kind: 'processed', happened_on: '2026-09-01', refund_determined: 5000, refund_interest: 0, tds_allowed_total: 5000,
    amount: null, created_at: '2026-09-01T00:00:00Z' },
  { id: 'e2', return_id: 'r-25', revision: 1, kind: 'refund_credited', happened_on: '2026-10-05', refund_determined: null, refund_interest: null, tds_allowed_total: null,
    amount: 5000, created_at: '2026-10-05T00:00:00Z', version: 2 },
];

function data(over = {}) {
  return {
    holdings: [IN_A, US],
    holdingDividends: [rec('d1', IN_A, '2025-08-01')],
    taxStatements: [statement('s-ais', 'ais'), statement('s-26', '26as')],
    taxStatementLines: [
      { statement_id: 's-ais', symbol: 'ABC.NS', payer: 'ABC Limited', gross: 1000, tds: 200 },
      { statement_id: 's-26', symbol: 'ABC.NS', payer: 'ABC Limited', gross: 1000, tds: 208 },
    ],
    taxReturns: [RETURN],
    taxReturnEvents: EVENTS,
    errors: {},
    loaded: {},
    reload: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  answers = { set_dividend_tax_year: { ok: true, version: 2 }, remove_tax_return_event: { ok: true } };
  cleanup();
});

function open(d = data(), scopeMemberId = null) {
  renderScreen(<TaxYears members={MEMBERS} scopeMemberId={scopeMemberId} data={d} />);
  return d;
}
// The revamp, phase 5c (design/prototype taxView): one table, a year a row,
// its drawer holding everything the app shows of the year (decision 3).
const region = () => screen.getByRole('region', { name: 'Indian dividends by tax year' });
const cells = (label) => [...within(region()).getByRole('button', { name: label }).closest('tr').querySelectorAll('td')].map((td) => td.textContent);
const openYear = (label) => {
  fireEvent.click(within(region()).getByRole('button', { name: label }));
  return screen.getByRole('dialog', { name: label });
};
const FY25 = 'FY 2025-26 (AY 2026-27)';

describe('Tax years', () => {
  it('a year reads as one row, each cell in short', () => {
    open();
    const [year, member, ...rest] = cells(FY25);
    expect(year).toBe(FY25);
    // The member's avatar, then their name.
    expect(member).toMatch(/One$/);
    expect(rest).toEqual(['INR 1,000.00', 'INR 208.00', 'Agrees', `Filed ${shortDate('2026-07-20')}`, `INR 5,000.00 credited ${shortDate('2026-10-05')}`]);
    fireEvent.click(within(region()).getByRole('button', { name: 'About Indian dividends by tax year' }));
    expect(screen.getByText('Checked against the AIS (income) and Form 26AS (tax credit). In rupees.')).toBeTruthy();
  });

  it('opening a year shows, in its drawer, where it stands, its shares, return and refund records', () => {
    open();
    const drawer = openYear(FY25);
    expect(drawer.textContent).toContain('Tax year · One');
    expect(within(drawer).getByText('agrees with AIS and 26AS')).toBeTruthy();
    expect(within(drawer).getByText(`dividend tax surplus INR 108.00; refund INR 5,000.00 credited ${shortDate('2026-10-05')}`)).toBeTruthy();
    expect(within(drawer).getByText('Income: Rokda INR 1,000.00 · AIS INR 1,000.00 · agrees with AIS')).toBeTruthy();
    expect(within(drawer).getByText('Tax: Rokda INR 208.00 · 26AS INR 208.00 · AIS INR 200.00 · agrees with 26AS')).toBeTruthy();
    expect(within(drawer).getByText(`Original return, filed ${shortDate('2026-07-20')}`)).toBeTruthy();
    expect(within(drawer).getByText(`${shortDate('2026-10-05')} · Refund credited INR 5,000.00`)).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Add' })).toBeTruthy();
    fireEvent.click(within(drawer.querySelector('.ds-drawer-foot')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("one member's scope", () => {
    open(data({ holdings: [IN_A, IN_S], holdingDividends: [rec('d1', IN_A, '2025-08-01'), rec('d9', IN_S, '2025-08-01')] }), 'm2');
    expect(screen.queryByRole('button', { name: FY25 })).toBeNull();
    expect(screen.getByText("Shared Co is shared, so its dividends aren't in anyone's tax year. Give it an owner under Investments to count them.")).toBeTruthy();
  });

  it('the tax records failing to load', () => {
    open(data({ errors: { taxReturns: new Error('x') }, loaded: {} }));
    expect(screen.getByRole('alert').textContent).toMatch(/tax returns.*Refresh the page to try again\.$/);
  });

  // The review of the whole revamp: the years are built from the holdings
  // and their dividends too. Unread, every statement line read as a
  // difference against no dividends at all.
  it('the holdings or their dividends failing to load', () => {
    open(data({ holdingDividends: [], errors: { holdingDividends: new Error('x') }, loaded: {} }));
    expect(screen.getByRole('alert').textContent).toMatch(/dividends.*Refresh the page to try again\.$/);
    expect(screen.queryByText(/differences?/)).toBeNull();
  });

  it('all Indian holdings sold', () => {
    open(data({ holdings: [{ ...IN_A, quantity: 0 }] }));
    expect(within(region()).getByRole('button', { name: FY25 })).toBeTruthy();
  });

  it("setting a dividend's tax year", async () => {
    const d = open();
    const drawer = openYear(FY25);
    fireEvent.click(within(drawer).getByText('Dividends (1)'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set tax year' }));
    fireEvent.change(within(drawer).getByLabelText('Tax year'), { target: { value: '2024' } });
    fireEvent.change(within(drawer).getByLabelText('Why'), { target: { value: 'declared' } });
    expect(within(drawer).getByRole('option', { name: 'FY 2024-25 (AY 2025-26)' })).toBeTruthy();
    await act(async () => fireEvent.click(within(drawer).getByRole('button', { name: 'Save tax year' })));
    expect(calls).toEqual([{ name: 'set_dividend_tax_year', args: { p_dividend_id: 'd1', p_financial_year: 2024, p_basis: 'declared', p_expected_version: 1 } }]);
    expect(d.reload).toHaveBeenCalled();
  });

  it('removing a refund record asks first', async () => {
    const d = open();
    const drawer = openYear(FY25);
    const credit = within(drawer).getByText(`${shortDate('2026-10-05')} · Refund credited INR 5,000.00`).closest('li');
    fireEvent.click(within(credit).getByRole('button', { name: 'Remove' }));
    expect(within(credit).getByText('Remove this record?')).toBeTruthy();
    fireEvent.click(within(credit).getByRole('button', { name: 'Keep it' }));
    expect(calls).toEqual([]);
    fireEvent.click(within(credit).getByRole('button', { name: 'Remove' }));
    await act(async () => fireEvent.click(within(credit).getByRole('button', { name: 'Remove' })));
    expect(calls).toEqual([{ name: 'remove_tax_return_event', args: { p_member_id: 'm1', p_event_id: 'e2', p_expected_version: 2 } }]);
    expect(d.reload).toHaveBeenCalled();
  });

  it("no estimate without this year's basis", () => {
    open(data({ holdingDividends: [rec('d1', IN_A, '2025-08-01'), rec('d2', IN_A, '2026-05-01')] }));
    const label = 'tax year 2026-27';
    expect(cells(label).at(-1)).toBe('—');
    expect(within(openYear(label)).getByText('no claim basis set (last year: the treaty rate of 10%)')).toBeTruthy();
  });

  // A credit date estimated (not read from a statement) leaves its year provisional.
  it('a provisional year says so', () => {
    open(data({ holdingDividends: [rec('d1', IN_A, '2025-08-01', { credited_on_estimated: true })] }));
    expect(cells(FY25)[0]).toBe(`${FY25}Provisional`);
  });

  it('no tax history says there is none', () => {
    open(data({ holdings: [US], holdingDividends: [], taxStatements: [], taxStatementLines: [], taxReturns: [], taxReturnEvents: [] }));
    expect(screen.getByText('No tax years in this view')).toBeTruthy();
  });
});

// The fresh review of 5c: a form open in a year's drawer is unsaved work.
// Escape in it steps back out of the form only; closing the drawer asks
// first.
describe('a form open in a tax year', () => {
  it('Escape in the return form closes the form, not the year', () => {
    open();
    const drawer = openYear(FY25);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(within(drawer).getByLabelText('Dividend tax', { exact: true }), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: FY25 })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByText('Discard changes?')).toBeNull();
  });

  it('Escape in Set tax year closes that form, not the year', () => {
    open();
    const drawer = openYear(FY25);
    fireEvent.click(within(drawer).getByText('Dividends (1)'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set tax year' }));
    fireEvent.keyDown(within(drawer).getByLabelText('Tax year'), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: FY25 })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Set tax year' })).toBeTruthy();
  });

  it('closing the year with a form open asks first, and Keep editing keeps it', () => {
    open();
    const drawer = openYear(FY25);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(drawer).getByLabelText('Dividend tax', { exact: true }), { target: { value: '1000' } });
    fireEvent.click(within(drawer.querySelector('.ds-drawer-foot')).getByRole('button', { name: 'Close' }));
    expect(within(drawer).getByText('Discard changes?')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Keep editing' }));
    expect(within(drawer).getByLabelText('Dividend tax', { exact: true }).value).toBe('1000');
    fireEvent.keyDown(drawer, { key: 'Escape' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('focus after a form', () => {
  it('returns to the button that opened it', async () => {
    open();
    const drawer = openYear(FY25);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Edit' }));
    await act(async () => fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' })));
    expect(document.activeElement).toBe(within(drawer).getByRole('button', { name: 'Edit' }));

    fireEvent.click(within(drawer).getByRole('button', { name: 'Add' }));
    await act(async () => fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' })));
    expect(document.activeElement).toBe(within(drawer).getByRole('button', { name: 'Add' }));

    const credit = within(drawer).getByText(`${shortDate('2026-10-05')} · Refund credited INR 5,000.00`).closest('li');
    fireEvent.click(within(credit).getByRole('button', { name: 'Remove' }));
    expect(document.activeElement).toBe(within(credit).getByRole('button', { name: 'Keep it' }));
    await act(async () => fireEvent.click(within(credit).getByRole('button', { name: 'Keep it' })));
    expect(document.activeElement).toBe(within(credit).getByRole('button', { name: 'Remove' }));

    fireEvent.click(within(drawer).getByText('Dividends (1)'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set tax year' }));
    expect(document.activeElement).toBe(within(drawer).getByLabelText('Tax year'));
    await act(async () => fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' })));
    expect(document.activeElement).toBe(within(drawer).getByRole('button', { name: 'Set tax year' }));
  });
});


// The fresh review of round 2: a dividend's tax year saved with the version
// in the latest refresh, not the one its form opened on, so a partner's
// change made meanwhile was overwritten (as E2-1 was for refund records).
describe("Tax years: a dividend's tax year after a refresh", () => {
  it('saves at the version it was opened on', async () => {
    const { rerender } = renderScreen(<TaxYears members={MEMBERS} scopeMemberId={null} data={data()} />);
    const drawer = openYear(FY25);
    fireEvent.click(within(drawer).getByText('Dividends (1)'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Set tax year' }));
    // The partner set it meanwhile; a refresh brings their version.
    const refreshed = data({ holdingDividends: [rec('d1', IN_A, '2025-08-01', { version: 2 })] });
    rerender(
      <ScopeProvider>
        <CurrencyProvider>
          <TaxYears members={MEMBERS} scopeMemberId={null} data={refreshed} />
        </CurrencyProvider>
      </ScopeProvider>,
    );
    const again = screen.getByRole('dialog', { name: FY25 });
    fireEvent.change(within(again).getByLabelText('Tax year'), { target: { value: '2024' } });
    await act(async () => fireEvent.click(within(again).getByRole('button', { name: 'Save tax year' })));
    expect(calls.map((c) => c.args.p_expected_version)).toEqual([1]);
  });
});
