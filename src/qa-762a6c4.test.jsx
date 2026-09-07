// Ported QA recheck probes for 762a6c4 (SHR-241 handoff). Synthetic data and
// mocked writes only — see the linked reproduction document for the original
// source: https://linear.app/shrey0/document/rokda-qa-recheck-762a6c4-remaining-corrections-207207b35101
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import { act } from 'react';
import { monthIncome, monthSpendBreakdown } from './lib/budget';
import { closedMonths } from './lib/forecast';
import { periodSummary } from './screens/overviewMath';
import { normalise } from '../scripts/compare-migrations.mjs';

// A minimal, realistic simulation of the `holdings` table: upsert on `id`
// always commits (a real write either lands or it doesn't reach the table at
// all — there's no such thing as a write that both "happens" and "doesn't
// happen"), independent of whether the caller's response is lost.
const state = vi.hoisted(() => ({ holdings: new Map(), histories: [], loseResponse: false }));
vi.mock('./lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: async (row) => {
        if (table === 'holding_value_history') {
          state.histories.push(row);
          return { error: state.histories.length === 1 ? { message: 'History unavailable' } : null };
        }
        state.holdings.set(row.id, { ...state.holdings.get(row.id), ...row });
        return { error: state.loseResponse ? { message: 'Response lost after commit' } : null };
      },
    }),
  },
}));

const { default: HoldingEditor } = await import('./screens/wealth/HoldingEditor');

beforeEach(() => {
  state.holdings.clear();
  state.histories.length = 0;
  state.loseResponse = false;
});
afterEach(cleanup);

const rows = [
  { amount: -100, kind: 'expense', occurred_at: '2026-08-05', is_shared: true, category_id: 'c' },
  { amount: 100, kind: 'refund', occurred_at: '2026-08-06', is_shared: true, category_id: 'c' },
];

it('Budget agrees with Overview on refunded spending and income', () => {
  const now = new Date(2026, 7, 31);
  expect(periodSummary(rows, 'mtd', null, now)).toMatchObject({ income: 0, spend: 0 });
  expect({
    income: monthIncome(rows, 2026, 8, null, now),
    spend: monthSpendBreakdown(rows, ['c'], 2026, 8, null, now).total,
  }).toEqual({ income: 0, spend: 0 });
});

it('Forecast treats refunds the same as Overview', () => {
  expect([...closedMonths(rows, new Date(2026, 8, 6)).values()][0]).toEqual({ income: 0, spend: 0 });
});

async function createHolding() {
  render(<HoldingEditor holding={null} householdId="hh" members={[]} onClose={() => {}} onSaved={async () => {}} />);
  fireEvent.change(screen.getByPlaceholderText('e.g. VWRA'), { target: { value: 'Synthetic QA' } });
  fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '100' } });
  await act(async () => {
    fireEvent.submit(document.querySelector('form'));
  });
}

it('changing value after a partial save keeps holding and history consistent', async () => {
  await createHolding();
  fireEvent.change(document.querySelector('.te-hero-input'), { target: { value: '200' } });
  await act(async () => {
    fireEvent.submit(document.querySelector('form'));
  });
  expect(state.holdings.size).toBe(1);
  expect(state.histories.at(-1).value_aed).toBe(200);
  expect([...state.holdings.values()][0].value_aed).toBe(200);
});

it('lost insert response followed by retry creates one holding', async () => {
  state.loseResponse = true;
  await createHolding();
  state.loseResponse = false;
  await act(async () => {
    fireEvent.submit(document.querySelector('form'));
  });
  expect(state.holdings.size).toBe(1);
});

it('migration comparison distinguishes dollar-quoted SQL literal case', () => {
  expect(normalise('SELECT $$A$$;')).not.toBe(normalise('SELECT $$a$$;'));
});
