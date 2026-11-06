import { describe, it, expect } from 'vitest';
import { dividendTaxYear, financialYearOf, lineKey, rokdaShareYears, shareKey, statementCheck, taxYearLabel } from './dividendTax';

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

  it("one member's statement never checks another's dividends", () => {
    const checks = check({
      dividends: [rec(IN_A, 1000, 208)], statements: [statement('s-26', '26as', 2025, 'm2')], lines: [line('s-26', 'ABC.NS', 1000, 208)],
    });
    expect(checks.find((c) => c.memberId === 'm1').tax.label).toBe('not_imported');
    expect(checks.find((c) => c.memberId === 'm2').tax.label).toBe('only_in_statement');
  });
});
