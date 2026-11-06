import { describe, it, expect } from 'vitest';
import {
  dividendTaxSurplus, dividendTaxYear, financialYearOf, lineKey, refundEstimate, refundState, rokdaShareYears, shareKey, statementCheck, taxRefusalMessage,
  taxYearLabel, taxYears,
} from './dividendTax';

const IN_A = { id: 'h-a', name: 'ABC', asset_class: 'india_equity', price_symbol: 'ABC.NS', owner_member_id: 'm1', is_shared: false, quantity: 10 };
const IN_A2 = { ...IN_A, id: 'h-a2', name: 'ABC (second account)' };
const IN_S = { id: 'h-s', name: 'Shared Co', asset_class: 'india_equity', price_symbol: 'SHR.NS', owner_member_id: null, is_shared: true, quantity: 10 };
const US = { id: 'h-us', name: 'XYZ', asset_class: 'us_equity', price_symbol: 'XYZ', owner_member_id: 'm1', is_shared: false, quantity: 10 };

let n = 0;
const div = (holding, extra) => ({
  id: `d${++n}`, holding_id: holding.id, status: 'received', credited_on: '2025-08-01', credited_on_estimated: false,
  expected_gross: 0, expected_tax: 0, received_gross: null, received_tax: null, tax_financial_year: null, tax_year_basis: null, ...extra,
});
const rec = (holding, gross, tax, extra) => div(holding, { received_gross: gross, received_tax: tax, expected_gross: gross, expected_tax: tax, ...extra });
const pre = (holding, gross, tax, extra) => div(holding, { status: 'presumed', expected_gross: gross, expected_tax: tax, credited_on_estimated: true, ...extra });

const statement = (id, source, year, member = 'm1') => ({ id, member_id: member, financial_year: year, source, as_of: `${year + 1}-06-15`, revision: 1, imported_at: '2026-11-01T00:00:00Z' });
const line = (statementId, symbol, gross, tds, payer = symbol ?? 'Payer') => ({ statement_id: statementId, symbol, payer, gross, tds });

function check({ holdings = [IN_A], dividends, statements = [], lines = [] }) {
  const { rows } = rokdaShareYears(holdings, dividends);
  return statementCheck({ shareYears: rows, statements, lines });
}
const find = (checks, year, key = 'ABC.NS') => checks.find((c) => c.year === year && c.key === key);

describe('tax years and labels', () => {
  it('a financial year runs from 1 April', () => {
    expect(financialYearOf('2026-03-31')).toBe(2025);
    expect(financialYearOf('2026-04-01')).toBe(2026);
  });

  it('labels follow the Act that governs the year', () => {
    expect(taxYearLabel(2025)).toBe('FY 2025-26 (AY 2026-27)');
    expect(taxYearLabel(2026)).toBe('tax year 2026-27');
    expect(taxYearLabel(2099)).toBe('tax year 2099-00');
  });

  it("a dividend's year is its own when set, else its credit date's", () => {
    // A final declared on 30 March and paid on 10 April.
    expect(dividendTaxYear({ credited_on: '2026-04-10', credited_on_estimated: false })).toEqual({ year: 2026, provisional: false, basis: 'credit' });
    expect(dividendTaxYear({ credited_on: '2026-04-10', tax_financial_year: 2025, tax_year_basis: 'declared' })).toEqual({ year: 2025, provisional: false, basis: 'declared' });
    // A presumed dividend near 31 March.
    expect(dividendTaxYear({ credited_on: '2026-03-30', credited_on_estimated: true })).toEqual({ year: 2025, provisional: true, basis: 'credit' });
    expect(dividendTaxYear({ credited_on: null })).toEqual({ year: null, provisional: false, basis: 'credit' });
  });

  it('a share is its symbol, or its holding; a payer Rokda does not hold is its name', () => {
    expect(shareKey(IN_A)).toBe('ABC.NS');
    expect(shareKey({ id: 'h-x', price_symbol: null })).toBe('holding:h-x');
    expect(lineKey({ symbol: null, payer: ' Old Co Limited ' })).toBe('payer:old co limited');
    expect(lineKey({ symbol: 'ABC.NS', payer: 'ABC Limited' })).toBe('ABC.NS');
  });
});

describe("Rokda's side of a year", () => {
  it('two holdings of the same share are one share', () => {
    const { rows } = rokdaShareYears([IN_A, IN_A2], [rec(IN_A, 500, 104), rec(IN_A2, 500, 104)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: 'm1', year: 2025, key: 'ABC.NS', name: 'ABC', confirmed: { count: 2, gross: 1000, tax: 208 } });
  });

  it('presumed figures are kept apart', () => {
    const { rows } = rokdaShareYears([IN_A], [rec(IN_A, 1000, 208), pre(IN_A, 500, 104)]);
    expect(rows[0].confirmed).toEqual({ count: 1, gross: 1000, tax: 208 });
    expect(rows[0].presumed).toEqual({ count: 1, gross: 500, tax: 104 });
    expect(rows[0].provisional).toBe(true);
  });

  it('only Indian dividends counted as received', () => {
    const { rows } = rokdaShareYears([IN_A, US], [
      div(IN_A, { status: 'earned', credited_on: null, expected_gross: 100, expected_tax: 20 }),
      div(IN_A, { status: 'skipped', credited_on: null }),
      rec(US, 100, 30),
    ]);
    expect(rows).toEqual([]);
  });

  it('a shared holding is listed apart', () => {
    const { rows, unassigned } = rokdaShareYears([IN_S], [rec(IN_S, 1000, 208)]);
    expect(rows).toEqual([]);
    expect(unassigned).toEqual([{ holdingId: 'h-s', name: 'Shared Co', count: 1 }]);
  });

  it('a holding that became shared takes its past dividends along', () => {
    const nowShared = { ...IN_A, is_shared: true };
    const { rows, unassigned } = rokdaShareYears([nowShared], [rec(nowShared, 1000, 208)]);
    expect(rows).toEqual([]);
    expect(unassigned).toEqual([{ holdingId: 'h-a', name: 'ABC', count: 1 }]);
  });

  it('a sold holding still makes a year', () => {
    const sold = { ...IN_A, quantity: 0 };
    expect(rokdaShareYears([sold], [rec(sold, 1000, 208)]).rows).toHaveLength(1);
  });
});

describe('the statement check', () => {
  it('AIS income and 26AS gross are compared apart, never added', () => {
    const c = find(check({
      dividends: [rec(IN_A, 1000, 208)],
      statements: [statement('s-ais', 'ais', 2025), statement('s-26', '26as', 2025)],
      lines: [line('s-ais', 'ABC.NS', 1000, 200), line('s-26', 'ABC.NS', 1000, 208)],
    }), 2025);
    expect(c.income).toEqual({ difference: 0, label: 'agrees', reasons: [] });
    expect(c.tax).toEqual({ difference: 0, label: 'agrees', reasons: [] });
    expect(c.ais).toEqual({ gross: 1000, tds: 200 });
    expect(c.f26as).toEqual({ gross: 1000, tds: 208 });
  });

  it('within rounding over three dividends', () => {
    const c = find(check({
      dividends: [rec(IN_A, 500, 100), rec(IN_A, 500, 100), rec(IN_A, 500, 100)],
      statements: [statement('s-26', '26as', 2025)],
      lines: [line('s-26', 'ABC.NS', 1500, 300.4)],
    }), 2025);
    expect(c.tax).toEqual({ difference: 0.4, label: 'within_rounding', reasons: [] });
  });

  it('small amounts add up exactly', () => {
    const c = find(check({
      dividends: [rec(IN_A, 1, 0.1), rec(IN_A, 1, 0.2), rec(IN_A, 1, 0.3)],
      statements: [statement('s-26', '26as', 2025)],
      lines: [line('s-26', 'ABC.NS', 3, 0.6)],
    }), 2025);
    expect(c.tax).toEqual({ difference: 0, label: 'agrees', reasons: [] });
  });

  it('tax higher with gross equal is a possible extra deduction', () => {
    const c = find(check({ dividends: [rec(IN_A, 1000, 208)], statements: [statement('s-26', '26as', 2025)], lines: [line('s-26', 'ABC.NS', 1000, 250)] }), 2025);
    expect(c.tax).toEqual({ difference: 42, label: 'differs', reasons: [{ code: 'extra_deduction' }] });
  });

  it('counted in the neighbouring year', () => {
    const checks = check({
      dividends: [rec(IN_A, 1000, 208, { credited_on: '2026-04-10' })],
      statements: [statement('s-25', 'ais', 2025), statement('s-26', 'ais', 2026)],
      lines: [line('s-25', 'ABC.NS', 1000, null)],
    });
    expect(find(checks, 2025).income).toEqual({ difference: 1000, label: 'only_in_statement', reasons: [{ code: 'neighbouring_year', year: 2026 }] });
    expect(find(checks, 2026).income).toEqual({ difference: -1000, label: 'only_in_rokda', reasons: [{ code: 'neighbouring_year', year: 2025 }] });
    expect(find(checks, 2025).tax).toEqual({ difference: null, label: 'not_imported', reasons: [] });
  });

  it('a share sold before our records is only in the statement', () => {
    const c = find(check({
      dividends: [], statements: [statement('s-26', '26as', 2025)], lines: [line('s-26', null, 500, 104, 'Old Co Limited')],
    }), 2025, 'payer:old co limited');
    expect(c.name).toBe('Old Co Limited');
    expect(c.memberId).toBe('m1');
    expect(c.tax).toEqual({ difference: 104, label: 'only_in_statement', reasons: [] });
  });

  it('an empty statement is imported, not missing', () => {
    const imported = find(check({ dividends: [rec(IN_A, 1000, 208)], statements: [statement('s-26', '26as', 2025)] }), 2025);
    expect(imported.tax).toEqual({ difference: -208, label: 'only_in_rokda', reasons: [] });
    expect(imported.f26as).toBeNull();
    const missing = find(check({ dividends: [rec(IN_A, 1000, 208)] }), 2025);
    expect(missing.tax).toEqual({ difference: null, label: 'not_imported', reasons: [] });
  });

  it('a difference with no explanation says so', () => {
    const c = find(check({ dividends: [rec(IN_A, 1000, 208)], statements: [statement('s-26', '26as', 2025)], lines: [line('s-26', 'ABC.NS', 1000, 150)] }), 2025);
    expect(c.tax).toEqual({ difference: -58, label: 'unexplained', reasons: [] });
  });

  it('presumed figures are offered as the possible cause', () => {
    const c = find(check({ dividends: [pre(IN_A, 1000, 208)], statements: [statement('s-26', '26as', 2025)], lines: [line('s-26', 'ABC.NS', 900, 187.2)] }), 2025);
    expect(c.tax).toEqual({ difference: -20.8, label: 'differs', reasons: [{ code: 'presumed' }] });
    expect(c.rokda.presumed).toEqual({ count: 1, gross: 1000, tax: 208 });
  });

  it('two payer lines for one share are added together', () => {
    const c = find(check({
      dividends: [rec(IN_A, 1000, 208)], statements: [statement('s-26', '26as', 2025)],
      lines: [line('s-26', 'ABC.NS', 600, 124.8, 'ABC Limited'), line('s-26', 'ABC.NS', 400, 83.2, 'ABC Old Name Limited')],
    }), 2025);
    expect(c.tax).toEqual({ difference: 0, label: 'agrees', reasons: [] });
    expect(c.f26as).toEqual({ gross: 1000, tds: 208 });
  });

  it('a share on neither side of a statement is not said to agree', () => {
    const c = find(check({
      dividends: [], statements: [statement('s-ais', 'ais', 2025), statement('s-26', '26as', 2025)], lines: [line('s-ais', 'ABC.NS', 1000, null)],
    }), 2025);
    expect(c.income.label).toBe('only_in_statement');
    expect(c.tax).toEqual({ difference: null, label: 'neither', reasons: [] });
  });

  it("one member's statement never checks another's dividends", () => {
    const checks = check({
      dividends: [rec(IN_A, 1000, 208)], statements: [statement('s-26', '26as', 2025, 'm2')], lines: [line('s-26', 'ABC.NS', 1000, 208)],
    });
    expect(checks.find((c) => c.memberId === 'm1').tax.label).toBe('not_imported');
    expect(checks.find((c) => c.memberId === 'm2').tax.label).toBe('only_in_statement');
  });
});

const filed = (extra) => ({ id: 'r-25', member_id: 'm1', financial_year: 2025, revision: 1, filed_on: '2026-07-20', claim_basis: null, claim_rate_pct: null,
  dividend_income: 10000, dividend_tax: 1000, dividend_tds_claimed: 2080, tds_claimed_total: 5000, ...extra });
let e = 0;
const event = (kind, extra) => ({ id: `e${++e}`, return_id: 'r-25', revision: 1, kind, happened_on: '2026-09-01', created_at: `2026-09-01T00:00:0${e % 10}Z`,
  refund_determined: null, refund_interest: null, tds_allowed_total: null, amount: null, ...extra });
const processed = (determined, interest = 0, extra) => event('processed', { refund_determined: determined, refund_interest: interest, ...extra });

describe('surplus or shortfall', () => {
  it('is signed and needs both sides', () => {
    expect(dividendTaxSurplus({ taxReturn: filed(), f26asTds: 2080 })).toEqual({ amount: 1080, missing: [] });
    expect(dividendTaxSurplus({ taxReturn: filed(), f26asTds: 800 })).toEqual({ amount: -200, missing: [] });
    expect(dividendTaxSurplus({ taxReturn: filed(), f26asTds: null })).toEqual({ amount: null, missing: ['26as'] });
    expect(dividendTaxSurplus({ taxReturn: filed({ revision: 0, filed_on: null, dividend_tax: null }), f26asTds: 2080 })).toEqual({ amount: null, missing: ['return'] });
    expect(dividendTaxSurplus({ taxReturn: null, f26asTds: null })).toEqual({ amount: null, missing: ['return', '26as'] });
  });

  it('a surplus larger than the whole refund stays whole', () => {
    const { years } = taxYears({
      holdings: [], dividends: [], returns: [filed()], events: [processed(3000), event('refund_credited', { amount: 3000 })],
      statements: [statement('s-26', '26as', 2025)], lines: [line('s-26', null, 30000, 6000, 'ABC Limited')],
    });
    expect(years[0].surplus.amount).toBe(5000);
    expect(years[0].refund).toMatchObject({ stage: 'settled', determined: 3000, unexplained: 0 });
  });
});

describe("what happened to a return's refund", () => {
  it('a zero refund is no refund', () => {
    expect(refundState(filed(), [processed(0)])).toMatchObject({ stage: 'no_refund', unexplained: null });
  });

  it('before processing', () => {
    expect(refundState(null, []).stage).toBe('not_filed');
    expect(refundState(filed({ revision: 0, filed_on: null }), []).stage).toBe('not_filed');
    expect(refundState(filed(), []).stage).toBe('filed');
  });

  it('interest and an offset', () => {
    const due = [processed(10000, 300), event('offset_against_demand', { amount: 2000 })];
    expect(refundState(filed(), [...due, event('refund_credited', { amount: 8000 })])).toEqual(
      { stage: 'partly_settled', determined: 10000, interest: 300, credited: 8000, offset: 2000, unexplained: 300 });
    expect(refundState(filed(), [...due, event('refund_credited', { amount: 8300 })])).toMatchObject({ stage: 'settled', unexplained: 0 });
    expect(refundState(filed(), [processed(10000, 300)]).stage).toBe('refund_due');
  });

  it('a revised return keeps the earlier credit', () => {
    const state = refundState(filed({ revision: 2 }), [
      processed(5000), event('refund_credited', { amount: 5000, happened_on: '2026-09-20' }),
      processed(5500, 0, { revision: 2, happened_on: '2026-10-15' }),
    ]);
    expect(state).toMatchObject({ stage: 'partly_settled', determined: 5500, credited: 5000, unexplained: 500 });
  });

  it('a failed refund counts as nothing', () => {
    expect(refundState(filed(), [processed(5000), event('refund_failed', { happened_on: '2026-09-10' }), event('refund_credited', { amount: 5000 })]))
      .toMatchObject({ stage: 'settled', credited: 5000, unexplained: 0 });
  });

  it('a demand', () => {
    expect(refundState(filed(), [processed(-500)])).toMatchObject({ stage: 'demand', determined: -500, unexplained: null });
  });
});

describe('the estimate before filing', () => {
  const rokda = { confirmed: { gross: 8000, tax: 1664 }, presumed: { gross: 2000, tax: 416 } };
  const planned = { revision: 0, filed_on: null, claim_basis: 'treaty', claim_rate_pct: 10 };

  it('from Rokda shows the presumed part; from 26AS it needs none', () => {
    expect(refundEstimate({ taxReturn: planned, f26as: null, rokda })).toEqual({ amount: 1080, presumedPart: 216, claimBasis: 'treaty', ratePct: 10, from: 'rokda' });
    expect(refundEstimate({ taxReturn: planned, f26as: { gross: 10000, tds: 2080 }, rokda }))
      .toEqual({ amount: 1080, presumedPart: null, claimBasis: 'treaty', ratePct: 10, from: '26as' });
  });

  it("needs this year's own basis, and stops once filed", () => {
    expect(refundEstimate({ taxReturn: null, f26as: null, rokda })).toBeNull();
    expect(refundEstimate({ taxReturn: { ...planned, claim_basis: null, claim_rate_pct: null }, f26as: null, rokda })).toBeNull();
    expect(refundEstimate({ taxReturn: { ...planned, revision: 1, filed_on: '2026-07-20' }, f26as: null, rokda })).toBeNull();
  });

  it("no estimate without this year's basis; last year's is shown as reference", () => {
    const { years } = taxYears({
      holdings: [IN_A], dividends: [rec(IN_A, 1000, 208, { credited_on: '2026-05-01' })],
      returns: [filed({ claim_basis: 'treaty', claim_rate_pct: 10 })], events: [], statements: [], lines: [],
    });
    const y2026 = years.find((y) => y.year === 2026);
    expect(y2026.estimate).toBeNull();
    expect(y2026.basisReference).toEqual({ year: 2025, claimBasis: 'treaty', ratePct: 10 });
    expect(years.find((y) => y.year === 2025).basisReference).toBeNull();
  });
});

describe("each member's tax years", () => {
  it('a year appears for a return alone', () => {
    const { years } = taxYears({ holdings: [], dividends: [], returns: [filed({ id: 'r-24', financial_year: 2024 })], events: [], statements: [], lines: [] });
    expect(years).toHaveLength(1);
    expect(years[0]).toMatchObject({ memberId: 'm1', year: 2024, label: 'FY 2024-25 (AY 2025-26)', shares: [], statements: { ais: null, f26as: null } });
  });

  it('years are newest first, and say they are provisional', () => {
    const { years } = taxYears({
      holdings: [IN_A], dividends: [pre(IN_A, 1000, 208, { credited_on: '2026-03-30' }), rec(IN_A, 1000, 208, { credited_on: '2026-06-01' })],
      returns: [], events: [], statements: [], lines: [],
    });
    expect(years.map((y) => y.year)).toEqual([2026, 2025]);
    expect(years[1].provisional).toBe(true);
    expect(years[0].provisional).toBe(false);
    expect(years[1].rokda.presumed).toEqual({ count: 1, gross: 1000, tax: 208 });
  });

  it('a statement is summed, and an empty one is imported', () => {
    const { years } = taxYears({
      holdings: [IN_A], dividends: [rec(IN_A, 1000, 208)], returns: [], events: [],
      statements: [statement('s-ais', 'ais', 2025), statement('s-26', '26as', 2025)],
      lines: [line('s-26', 'ABC.NS', 1000, 208), line('s-26', null, 500, 104, 'Old Co Limited')],
    });
    expect(years[0].statements.f26as).toEqual({ revision: 1, asOf: '2026-06-15', importedAt: '2026-11-01T00:00:00Z', lineCount: 2, gross: 1500, tds: 312 });
    expect(years[0].statements.ais).toMatchObject({ lineCount: 0, gross: 0, tds: 0 });
    expect(years[0].shares.map((c) => c.name)).toEqual(['ABC', 'Old Co Limited']);
  });

  it('shared holdings are listed apart', () => {
    expect(taxYears({ holdings: [IN_S], dividends: [rec(IN_S, 1000, 208)], returns: [], events: [], statements: [], lines: [] }))
      .toEqual({ years: [], unassigned: [{ holdingId: 'h-s', name: 'Shared Co', count: 1 }] });
  });
});

describe('refusals', () => {
  it('every error code has a sentence', () => {
    const fallback = taxRefusalMessage('nope');
    expect(fallback).toBe('That could not be saved. Nothing was changed.');
    for (const code of ['not_member', 'bad_input', 'bad_figures', 'stale', 'basis_needs_rate', 'filed_on_needed', 'not_filed', 'filed_before_year_end',
      'in_future', 'identifier_in_text', 'events_on_later_revision', 'event_not_found', 'dividend_not_found', 'not_indian', 'year_too_far',
      'unknown_share', 'duplicate_payer', 'older_than_held']) {
      expect(taxRefusalMessage(code)).not.toBe(fallback);
    }
    expect(taxRefusalMessage('identifier_in_text')).toBe('Leave out PAN, account and acknowledgement numbers.');
  });
});
