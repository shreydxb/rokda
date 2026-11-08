import { describe, it, expect } from 'vitest';
import {
  basisWords, checkWords, comparisonWords, eventLine, returnLines, revisionLabel, shareLines, stageWords, unassignedWords,
} from './dividendTaxText';
import { shortDate } from './dividends';

const fmt = (n) => `INR ${n}`;
const cmp = (label, difference = 0, reasons = []) => ({ label, difference, reasons });
const share = (income, tax, extra = {}) => ({
  key: 'ABC.NS', name: 'ABC', rokda: { confirmed: { count: 1, gross: 1000, tax: 208 }, presumed: { count: 0, gross: 0, tax: 0 }, count: 1 },
  ais: null, f26as: null, income, tax, ...extra,
});
const info = { revision: 1, asOf: '2026-06-15', importedAt: '2026-11-01', lineCount: 1, gross: 1000, tds: 208 };
const year = (extra = {}) => ({
  year: 2025, statements: { ais: info, f26as: info }, shares: [], refund: { stage: 'not_filed' }, surplus: { amount: null, missing: ['return'] },
  estimate: null, basisReference: null, ...extra,
});

describe('basis and revision', () => {
  it('names the basis with its rate', () => {
    expect(basisWords('treaty', 10)).toBe('the treaty rate of 10%');
    expect(basisWords('domestic', 20.8)).toBe('the domestic rate of 20.8%');
    expect(basisWords('manual', 15)).toBe('a rate of 15%');
  });

  it('names each revision', () => {
    expect([0, 1, 2, 3].map(revisionLabel)).toEqual(['Not filed', 'Original return', 'Revised return', 'Revised return 2']);
  });
});

describe('the statement check in words', () => {
  it('counts differences, not rounding', () => {
    const shares = [share(cmp('differs', 10), cmp('agrees')), share(cmp('within_rounding', 0.4), cmp('unexplained', -5)), share(cmp('agrees'), cmp('within_rounding', 1))];
    expect(checkWords(year({ shares }))).toBe('2 differences');
    expect(checkWords(year({ shares: [share(cmp('only_in_rokda', -1000), cmp('agrees'))] }))).toBe('1 difference');
  });

  it('says which statement is missing', () => {
    expect(checkWords(year({ statements: { ais: null, f26as: null } }))).toBe('AIS and 26AS not added');
    expect(checkWords(year({ statements: { ais: null, f26as: info }, shares: [share(cmp('not_imported', null), cmp('agrees'))] }))).toBe('agrees with 26AS; AIS not added');
    expect(checkWords(year({ statements: { ais: info, f26as: null }, shares: [share(cmp('agrees'), cmp('not_imported', null))] }))).toBe('agrees with AIS; 26AS not added');
    expect(checkWords(year({ statements: { ais: null, f26as: info }, shares: [share(cmp('not_imported', null), cmp('differs', 5))] })))
      .toBe('1 difference; AIS not added');
    expect(checkWords(year({ shares: [share(cmp('agrees'), cmp('agrees'))] }))).toBe('agrees with AIS and 26AS');
  });
});

describe('where the year stands', () => {
  it('before filing: the estimate, at this year own basis', () => {
    expect(stageWords(year({ estimate: { amount: 1080, presumedPart: 216, claimBasis: 'treaty', ratePct: 10, from: 'rokda' } }), fmt))
      .toBe('could come back: about INR 1080 at the treaty rate of 10%, INR 216 of it on presumed dividends');
    expect(stageWords(year({ estimate: { amount: 1080, presumedPart: null, claimBasis: 'treaty', ratePct: 10, from: '26as' } }), fmt))
      .toBe('could come back: about INR 1080 at the treaty rate of 10%');
    expect(stageWords(year({ basisReference: { year: 2024, claimBasis: 'treaty', ratePct: 10 } }), fmt))
      .toBe('no claim basis set (last year: the treaty rate of 10%)');
    expect(stageWords(year(), fmt)).toBe('no claim basis set');
  });

  it('after filing: surplus or shortfall, then the refund', () => {
    const settled = { stage: 'settled', determined: 5000, interest: 0, credited: 5000, offset: 0, unexplained: 0, lastCreditedOn: '2026-10-05' };
    expect(stageWords(year({ surplus: { amount: 1080, missing: [] }, refund: settled }), fmt))
      .toBe(`dividend tax surplus INR 1080; refund INR 5000 credited ${shortDate('2026-10-05')}`);
    expect(stageWords(year({ surplus: { amount: -200, missing: [] }, refund: { stage: 'filed' } }), fmt)).toBe('dividend tax shortfall INR 200; not processed yet');
    expect(stageWords(year({ surplus: { amount: 0, missing: [] }, refund: { stage: 'no_refund' } }), fmt)).toBe('no dividend tax surplus; no refund');
    expect(stageWords(year({ surplus: { amount: null, missing: ['26as'] }, refund: { stage: 'demand', determined: -500 } }), fmt))
      .toBe('surplus needs 26AS; demand INR 500');
    expect(stageWords(year({ surplus: { amount: null, missing: ['return'] }, refund: { stage: 'refund_due', determined: 5000, interest: 150 } }), fmt))
      .toBe("surplus needs the return's dividend tax; refund INR 5150 due");
    expect(stageWords(year({ surplus: { amount: 1, missing: [] }, refund: { stage: 'partly_settled', determined: 10000, interest: 300, unexplained: 300 } }), fmt))
      .toBe('dividend tax surplus INR 1; refund INR 10300, INR 300 unexplained');
  });

  it('a settled refund names offsets and any surplus credit', () => {
    const base = { stage: 'settled', determined: 5000, interest: 0, lastCreditedOn: '2026-10-05' };
    expect(stageWords(year({ surplus: { amount: 1, missing: [] }, refund: { ...base, credited: 3000, offset: 2000, unexplained: 0 } }), fmt))
      .toBe(`dividend tax surplus INR 1; refund INR 3000 credited ${shortDate('2026-10-05')}, INR 2000 set against a demand`);
    expect(stageWords(year({ surplus: { amount: 1, missing: [] }, refund: { ...base, credited: 5100, offset: 0, unexplained: -100 } }), fmt))
      .toBe(`dividend tax surplus INR 1; refund INR 5100 credited ${shortDate('2026-10-05')}, INR 100 more than determined`);
    expect(stageWords(year({ surplus: { amount: 1, missing: [] }, refund: { ...base, credited: 0, offset: 5000, unexplained: 0, lastCreditedOn: null } }), fmt))
      .toBe('dividend tax surplus INR 1; refund INR 5000 set against a demand');
  });
});

describe('a share against a statement', () => {
  it('each label in words', () => {
    expect(comparisonWords(cmp('not_imported', null), 'AIS', fmt)).toBe('AIS not added');
    expect(comparisonWords(cmp('neither', null), '26AS', fmt)).toBe('not in Rokda or 26AS');
    expect(comparisonWords(cmp('agrees'), 'AIS', fmt)).toBe('agrees with AIS');
    expect(comparisonWords(cmp('within_rounding', -0.4), '26AS', fmt)).toBe('within rounding of 26AS (INR 0.4)');
    expect(comparisonWords(cmp('only_in_rokda', -1000), 'AIS', fmt)).toBe('not in AIS');
    expect(comparisonWords(cmp('unexplained', -58), '26AS', fmt)).toBe('26AS INR 58 less, unexplained');
  });

  it('possible causes follow, each a possibility', () => {
    expect(comparisonWords(cmp('only_in_statement', 1000, [{ code: 'neighbouring_year', year: 2026 }]), 'AIS', fmt))
      .toBe('only in AIS (INR 1000): possibly counted in tax year 2026-27');
    expect(comparisonWords(cmp('differs', 42, [{ code: 'extra_deduction' }]), '26AS', fmt))
      .toBe("26AS INR 42 more: possibly an additional deduction or a correction: check the company's intimation or Form 16A");
    expect(comparisonWords(cmp('differs', -20.8, [{ code: 'presumed' }]), '26AS', fmt)).toBe('26AS INR 20.8 less: presumed, not confirmed');
  });

  it('a share as two lines', () => {
    const lines = shareLines(share(cmp('agrees'), cmp('agrees'), {
      rokda: { confirmed: { count: 1, gross: 800, tax: 166.4 }, presumed: { count: 1, gross: 200, tax: 41.6 }, count: 2 },
      ais: { gross: 1000, tds: 200 }, f26as: { gross: 1000, tds: 208 },
    }), fmt);
    expect(lines.income).toBe('Income: Rokda INR 1000 (INR 200 presumed) · AIS INR 1000 · agrees with AIS');
    expect(lines.tax).toBe('Tax: Rokda INR 208 (INR 41.6 presumed) · 26AS INR 208 · AIS INR 200 · agrees with 26AS');
    const bare = shareLines(share(cmp('not_imported', null), cmp('not_imported', null)), fmt);
    expect(bare).toEqual({ income: 'Income: Rokda INR 1000 · AIS not added', tax: 'Tax: Rokda INR 208 · 26AS not added' });
  });
});

describe('the return and what happened to it', () => {
  it('the return in lines', () => {
    expect(returnLines(null, fmt)).toEqual(['Claim basis: not set', 'Not filed']);
    expect(returnLines({ revision: 2, filed_on: '2026-07-20', claim_basis: 'treaty', claim_rate_pct: 10, dividend_income: 10000, dividend_tax: null,
      dividend_tds_claimed: 2080, tds_claimed_total: 5000 }, fmt)).toEqual([
      'Claim basis: the treaty rate of 10%', `Revised return, filed ${shortDate('2026-07-20')}`, 'Dividend income INR 10000, dividend tax not given',
      'Tax credit claimed: INR 2080 on dividends, INR 5000 in all',
    ]);
  });

  it('each record in a line', () => {
    const r1 = { revision: 1 };
    const on = shortDate('2026-09-20');
    expect(eventLine({ kind: 'processed', happened_on: '2026-09-20', refund_determined: 5000, refund_interest: 150 }, r1, fmt)).toBe(`${on} · Processed: refund INR 5000, interest INR 150`);
    expect(eventLine({ kind: 'processed', happened_on: '2026-09-20', refund_determined: -500, refund_interest: 0 }, r1, fmt)).toBe(`${on} · Processed: demand INR 500`);
    expect(eventLine({ kind: 'refund_credited', happened_on: '2026-09-20', amount: 5150 }, r1, fmt)).toBe(`${on} · Refund credited INR 5150`);
    expect(eventLine({ kind: 'offset_against_demand', happened_on: '2026-09-20', amount: 2000 }, r1, fmt)).toBe(`${on} · INR 2000 set against a demand`);
    expect(eventLine({ kind: 'refund_failed', happened_on: '2026-09-20', amount: null }, r1, fmt)).toBe(`${on} · Refund failed`);
    expect(eventLine({ kind: 'refund_failed', happened_on: '2026-09-20', amount: 100 }, r1, fmt)).toBe(`${on} · Refund failed (INR 100)`);
    expect(eventLine({ kind: 'refund_credited', happened_on: '2026-09-20', amount: 100, revision: 1 }, { revision: 2 }, fmt)).toBe(`${on} · Refund credited INR 100 · original return`);
  });
});

describe('shared holdings', () => {
  it('ask whose dividends they are', () => {
    expect(unassignedWords([])).toBeNull();
    expect(unassignedWords([{ name: 'ABC' }])).toBe("ABC is shared, so its dividends aren't in anyone's tax year. Give it an owner under Investments to count them.");
    expect(unassignedWords([{ name: 'ABC' }, { name: 'XYZ' }, { name: 'PQR' }]))
      .toBe("ABC, XYZ and PQR are shared, so their dividends aren't in anyone's tax year. Give them owners under Investments to count them.");
  });
});
