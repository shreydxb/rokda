import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup, within } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';
import { shortDate } from '../../lib/dividends';

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
    amount: 5000, created_at: '2026-10-05T00:00:00Z' },
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
const region = () => screen.getByRole('region', { name: 'Tax years' });
const row = (name) => within(region()).getByRole('button', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) });

describe('Tax years', () => {
  it('a year reads as one row', () => {
    open();
    const r = row('FY 2025-26 (AY 2026-27) · One');
    expect(r.getAttribute('aria-expanded')).toBe('false');
    expect(r.textContent).toContain('dividends INR 1,000.00, tax withheld INR 208.00');
    expect(r.textContent).toContain('agrees with AIS and 26AS');
    expect(r.textContent).toContain('dividend tax surplus INR 108.00');
    expect(r.textContent).toContain(`refund INR 5,000.00 credited ${shortDate('2026-10-05')}`);
    expect(within(region()).getByText(/^Indian dividends by tax year, checked against the AIS \(income\) and Form 26AS \(tax credit\)\. In rupees\.$/)).toBeTruthy();
  });

  it('opening a year shows shares, return and events', () => {
    open();
    fireEvent.click(row('FY 2025-26 (AY 2026-27)'));
    const r = region();
    expect(within(r).getByText('Income: Rokda INR 1,000.00 · AIS INR 1,000.00 · agrees with AIS')).toBeTruthy();
    expect(within(r).getByText('Tax: Rokda INR 208.00 · 26AS INR 208.00 · AIS INR 200.00 · agrees with 26AS')).toBeTruthy();
    expect(within(r).getByText(`Original return, filed ${shortDate('2026-07-20')}`)).toBeTruthy();
    expect(within(r).getByText(`${shortDate('2026-10-05')} · Refund credited INR 5,000.00`)).toBeTruthy();
    expect(within(r).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(r).getByRole('button', { name: 'Add' })).toBeTruthy();
  });

  it("one member's scope", () => {
    open(data({ holdings: [IN_A, IN_S], holdingDividends: [rec('d1', IN_A, '2025-08-01'), rec('d9', IN_S, '2025-08-01')] }), 'm2');
    expect(within(region()).queryByRole('button', { name: /^FY 2025-26/ })).toBeNull();
    expect(within(region()).getByText("Shared Co is shared, so its dividends aren't in anyone's tax year. Give it an owner under Investments to count them.")).toBeTruthy();
  });

  it('the tax records failing to load', () => {
    open(data({ errors: { taxReturns: new Error('x') }, loaded: {} }));
    expect(within(region()).getByRole('alert').textContent).toMatch(/tax returns.*Refresh the page to try again\.$/);
  });

  it('all Indian holdings sold', () => {
    open(data({ holdings: [{ ...IN_A, quantity: 0 }] }));
    expect(row('FY 2025-26 (AY 2026-27)')).toBeTruthy();
  });

  it("setting a dividend's tax year", async () => {
    const d = open();
    fireEvent.click(row('FY 2025-26 (AY 2026-27)'));
    fireEvent.click(within(region()).getByText('Dividends (1)'));
    fireEvent.click(within(region()).getByRole('button', { name: 'Set tax year' }));
    fireEvent.change(within(region()).getByLabelText('Tax year'), { target: { value: '2024' } });
    fireEvent.change(within(region()).getByLabelText('Why'), { target: { value: 'declared' } });
    expect(within(region()).getByRole('option', { name: 'FY 2024-25 (AY 2025-26)' })).toBeTruthy();
    await act(async () => fireEvent.click(within(region()).getByRole('button', { name: 'Save tax year' })));
    expect(calls).toEqual([{ name: 'set_dividend_tax_year', args: { p_dividend_id: 'd1', p_financial_year: 2024, p_basis: 'declared', p_expected_version: 1 } }]);
    expect(d.reload).toHaveBeenCalled();
  });

  it('removing a refund record asks first', async () => {
    const d = open();
    fireEvent.click(row('FY 2025-26 (AY 2026-27)'));
    const credit = within(region()).getByText(`${shortDate('2026-10-05')} · Refund credited INR 5,000.00`).closest('li');
    fireEvent.click(within(credit).getByRole('button', { name: 'Remove' }));
    expect(within(credit).getByText('Remove this record?')).toBeTruthy();
    fireEvent.click(within(credit).getByRole('button', { name: 'Keep it' }));
    expect(calls).toEqual([]);
    fireEvent.click(within(credit).getByRole('button', { name: 'Remove' }));
    await act(async () => fireEvent.click(within(credit).getByRole('button', { name: 'Remove' })));
    expect(calls).toEqual([{ name: 'remove_tax_return_event', args: { p_member_id: 'm1', p_event_id: 'e2' } }]);
    expect(d.reload).toHaveBeenCalled();
  });

  it("no estimate without this year's basis", () => {
    open(data({ holdingDividends: [rec('d1', IN_A, '2025-08-01'), rec('d2', IN_A, '2026-05-01')] }));
    expect(row('tax year 2026-27').textContent).toContain('no claim basis set (last year: the treaty rate of 10%)');
  });

  it('no tax history, no section', () => {
    open(data({ holdings: [US], holdingDividends: [], taxStatements: [], taxStatementLines: [], taxReturns: [], taxReturnEvents: [] }));
    expect(screen.queryByRole('region', { name: 'Tax years' })).toBeNull();
  });
});

describe('focus after a form', () => {
  it('returns to the button that opened it', async () => {
    open();
    fireEvent.click(row('FY 2025-26 (AY 2026-27)'));
    fireEvent.click(within(region()).getByRole('button', { name: 'Edit' }));
    await act(async () => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    expect(document.activeElement).toBe(within(region()).getByRole('button', { name: 'Edit' }));

    fireEvent.click(within(region()).getByRole('button', { name: 'Add' }));
    await act(async () => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    expect(document.activeElement).toBe(within(region()).getByRole('button', { name: 'Add' }));

    const credit = within(region()).getByText(`${shortDate('2026-10-05')} · Refund credited INR 5,000.00`).closest('li');
    fireEvent.click(within(credit).getByRole('button', { name: 'Remove' }));
    expect(document.activeElement).toBe(within(credit).getByRole('button', { name: 'Keep it' }));
    await act(async () => fireEvent.click(within(credit).getByRole('button', { name: 'Keep it' })));
    expect(document.activeElement).toBe(within(credit).getByRole('button', { name: 'Remove' }));

    fireEvent.click(within(region()).getByText('Dividends (1)'));
    fireEvent.click(within(region()).getByRole('button', { name: 'Set tax year' }));
    expect(document.activeElement).toBe(within(region()).getByLabelText('Tax year'));
    await act(async () => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    expect(document.activeElement).toBe(within(region()).getByRole('button', { name: 'Set tax year' }));
  });
});

