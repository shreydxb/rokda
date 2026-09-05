import { describe, it, expect } from 'vitest';
import { dataQuality, buildChartColumns, periodSummary, runwaySummary } from './overviewMath';
import { closedMonths, forecastInputs } from '../lib/forecast';

// QA-06 / SHR-247. The three reproductions in the published QA document are
// reproduced verbatim below, plus the boundary cases the review asked for.
describe('QA-06: month-to-date windows', () => {
  it('excludes tomorrow at midday today', () => {
    const now = new Date(2026, 8, 5, 12);
    expect(periodSummary([{ occurred_at: '2026-09-06', amount: -100 }], 'mtd', null, now).spend).toBe(0);
  });

  it('includes a record dated today', () => {
    const now = new Date(2026, 8, 5, 12);
    expect(periodSummary([{ occurred_at: '2026-09-05', amount: -100 }], 'mtd', null, now).spend).toBe(100);
  });

  it('includes the first of the month and excludes the last day of the previous one', () => {
    const now = new Date(2026, 8, 15, 12);
    const rows = [
      { occurred_at: '2026-08-31', amount: -10 },
      { occurred_at: '2026-09-01', amount: -100 },
    ];
    expect(periodSummary(rows, 'mtd', null, now).spend).toBe(100);
  });

  it('holds at a Dubai midnight boundary', () => {
    // 00:00 on the 1st: the month has one day in it so far, and yesterday —
    // last month's final day — is out.
    const now = new Date(2026, 8, 1, 0, 0, 0);
    const rows = [
      { occurred_at: '2026-08-31', amount: -10 },
      { occurred_at: '2026-09-01', amount: -100 },
      { occurred_at: '2026-09-02', amount: -1000 },
    ];
    expect(periodSummary(rows, 'mtd', null, now).spend).toBe(100);
  });

  it('does not let a year boundary leak into year to date', () => {
    const now = new Date(2026, 0, 5, 12);
    const rows = [
      { occurred_at: '2025-12-31', amount: -10 },
      { occurred_at: '2026-01-02', amount: -100 },
    ];
    expect(periodSummary(rows, 'ytd', null, now).spend).toBe(100);
  });
});

describe('QA-06: runway averages the newest completed months', () => {
  it('uses the newest six months for descending API input', () => {
    // Verbatim from the QA reproductions: newest six months spend 100 each,
    // the two older ones spend 1,000. The average is 100, not 400.
    const tx = Array.from({ length: 8 }, (_, i) => ({
      occurred_at: `2026-${String(8 - i).padStart(2, '0')}-15`,
      amount: i < 6 ? -100 : -1000,
    }));
    const summary = runwaySummary(tx, [{ type: 'checking', balance: 600, is_shared: true }], null, new Date(2026, 8, 5));
    expect(summary.avgMonthlySpend).toBe(100);
  });

  it('gives the same answer whatever order the rows arrive in', () => {
    const tx = Array.from({ length: 8 }, (_, i) => ({
      occurred_at: `2026-${String(8 - i).padStart(2, '0')}-15`,
      amount: i < 6 ? -100 : -1000,
    }));
    const ascending = [...tx].reverse();
    const now = new Date(2026, 8, 5);
    const accounts = [{ type: 'checking', balance: 600, is_shared: true }];
    expect(runwaySummary(ascending, accounts, null, now).avgMonthlySpend).toBe(
      runwaySummary(tx, accounts, null, now).avgMonthlySpend,
    );
  });

  it('sorts month keys chronologically across a year boundary', () => {
    // Lexical order on unpadded "2026-9" style keys put October before
    // February. These are the ten months before Sep 2026.
    const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    const tx = months.map((m, i) => ({ occurred_at: `${m}-15`, amount: i < 4 ? -1000 : -100 }));
    const summary = runwaySummary(tx, [{ type: 'checking', balance: 600, is_shared: true }], null, new Date(2026, 8, 5));
    // The newest six are 2026-03 … 2026-08, all 100.
    expect(summary.avgMonthlySpend).toBe(100);
  });

  it('excludes the current, still-open month and anything after it', () => {
    const tx = [
      { occurred_at: '2026-07-15', amount: -100 },
      { occurred_at: '2026-08-15', amount: -100 },
      { occurred_at: '2026-09-15', amount: -9000 },
      { occurred_at: '2026-10-15', amount: -9000 },
    ];
    const summary = runwaySummary(tx, [{ type: 'checking', balance: 600, is_shared: true }], null, new Date(2026, 8, 5));
    expect(summary.avgMonthlySpend).toBe(100);
  });

  it('reports sparse history honestly rather than averaging one month', () => {
    const summary = runwaySummary(
      [{ occurred_at: '2026-08-15', amount: -100 }],
      [{ type: 'checking', balance: 600, is_shared: true }],
      null,
      new Date(2026, 8, 5),
    );
    expect(summary.available).toBe(false);
    expect(summary.monthsOfHistory).toBe(1);
  });
});

describe('QA-06: forecast history', () => {
  it('does not count a future month as closed', () => {
    expect(closedMonths([{ occurred_at: '2026-10-01', amount: -100 }], new Date(2026, 8, 5)).size).toBe(0);
  });

  it('does not count the current month as closed', () => {
    expect(closedMonths([{ occurred_at: '2026-09-30', amount: -100 }], new Date(2026, 8, 5)).size).toBe(0);
  });

  it('averages the newest twelve closed months, not the first twelve seen', () => {
    // Fourteen closed months, newest first as the API returns them. The
    // newest twelve spend 100; the two oldest spend 5,000.
    const tx = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(2026, 7 - i, 15);
      return {
        occurred_at: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`,
        amount: i < 12 ? -100 : -5000,
      };
    });
    const inputs = forecastInputs(tx, 1000, new Date(2026, 8, 5));
    expect(inputs.ready).toBe(true);
    expect(inputs.monthCount).toBe(12);
    expect(inputs.avgMonthlySpend).toBe(100);
  });
});

describe('QA-06: planned versus posted', () => {
  const now = new Date(2026, 8, 5, 12);

  it('never reports a negative age for the last record', () => {
    const quality = dataQuality([], [{ occurred_at: '2026-09-06', amount: -100 }], now);
    expect(quality.daysSinceLastTx).toBeNull();
    expect(quality.plannedTx).toBe(1);
  });

  it('counts the newest posted record, ignoring a future-dated one', () => {
    const quality = dataQuality(
      [],
      [
        { occurred_at: '2026-09-06', amount: -100 },
        { occurred_at: '2026-09-04', amount: -100 },
      ],
      now,
    );
    expect(quality.daysSinceLastTx).toBe(1);
    expect(quality.plannedTx).toBe(1);
    expect(quality.totalTx).toBe(2);
  });

  it('keeps a planned record out of the running month column', () => {
    const columns = buildChartColumns([{ occurred_at: '2026-09-30', amount: -100 }], 'mtd', null, now);
    const current = columns[columns.length - 1];
    expect(current.spend).toBe(0);
    expect(current.hasData).toBe(false);
  });
});
