import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import BasisLine from './BasisLine';

// Every upsert the drawer sends, and a way to make it fail.
const calls = vi.hoisted(() => ({ upserts: [], fail: null }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: async (row, opts) => {
        calls.upserts.push({ table, row, opts });
        return { error: calls.fail };
      },
    }),
  },
}));

beforeEach(() => {
  calls.upserts.length = 0;
  calls.fail = null;
});

const AED = { code: 'AED', fmt: (v) => Math.round(v).toLocaleString('en-US') };
const RECORDED = { ready: true, source: 'actual', monthCount: 3, avgMonthlySpend: 4000, monthlySaving: 6000, basis: null, recordsFrom: null, why: 'not-chosen', recordedMonths: ['2026-06', '2026-07', '2026-08'] };
const BUDGET = { ready: true, source: 'budget', monthCount: 3, budgetMonths: 4, avgMonthlySpend: 8000, monthlySaving: 1500, basis: 'budget', recordsFrom: null, why: 'chosen', recordedMonths: ['2026-06', '2026-07', '2026-08'] };

function renderLine(inputs, assumptions = null) {
  const onSaved = vi.fn();
  renderScreen(<BasisLine inputs={inputs} householdId="h" assumptions={assumptions} onSaved={onSaved} money={AED} />);
  return { onSaved };
}
const line = () => screen.getByRole('note', { name: 'Planning basis' }).textContent;

// Planning audit, 2.9: one always-on line, and the household's choice.
describe('BasisLine: what the plan rests on', () => {
  it('says the records, why, and from when', () => {
    renderLine(RECORDED);
    expect(line()).toMatch(/^Recorded months\. The average of the last 3 ended months: spending AED 4,000 and saving AED 6,000 a month\. No basis is chosen/);
    document.body.innerHTML = '';
    renderLine({ ...RECORDED, basis: 'recorded', why: 'chosen', recordsFrom: '2026-06' });
    expect(line()).toMatch(/^Recorded months, as you chose\. The average of the last 3 ended months since Jun 2026: /);
  });

  it('says the budget, as chosen or standing in, and the records standing in for a missing budget', () => {
    renderLine(BUDGET);
    expect(line()).toMatch(/^Your budget, as you chose\. Spending AED 8,000 and saving AED 1,500 a month, from your spending budget and savings target over 4 budgeted months\.Change basis$/);
    document.body.innerHTML = '';
    renderLine({ ...BUDGET, basis: 'recorded', why: 'few-months', monthCount: 1, recordsFrom: '2026-08' });
    expect(line()).toMatch(/You chose recorded months; they take over once three have ended since Aug 2026 · 1 so far\./);
    document.body.innerHTML = '';
    renderLine({ ...RECORDED, basis: 'budget', why: 'no-budget' });
    expect(line()).toMatch(/^Recorded months, for now\. You chose your budget, but no month has a spending budget, so the last 3 ended months stand in/);
  });

  it('says nothing before there is anything to go on, unless a basis was chosen', () => {
    renderLine({ ready: false, source: null, monthCount: 1, basis: null, why: null });
    expect(screen.queryByRole('note')).toBeNull();
    renderLine({ ready: false, source: null, monthCount: 1, basis: 'budget', why: 'no-budget' });
    expect(line()).toMatch(/^No basis yet\. You chose your budget, but no month has a spending budget/);
  });
});

describe('BasisLine: changing the basis', () => {
  it('saves the basis and the month records count from', async () => {
    const { onSaved } = renderLine(RECORDED);
    fireEvent.click(screen.getByRole('button', { name: 'Change basis' }));
    expect(screen.getByRole('dialog', { name: 'Planning basis' })).toBeTruthy();
    // Nothing chosen yet: neither is pressed, and the old rule is said.
    expect(screen.getByRole('button', { name: 'Your budget' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/^Not chosen: your budget until three months have ended/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Your budget' }));
    const from = screen.getByLabelText('Records count from');
    // Every month from the first recorded to this one, newest first.
    expect([...from.options].map((o) => o.textContent).slice(0, 1)).toEqual(['Every recorded month']);
    expect([...from.options].at(-1).textContent).toBe('Jun 2026');
    fireEvent.change(from, { target: { value: '2026-07' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.upserts[0]).toMatchObject({ table: 'planning_assumptions', row: { household_id: 'h', planning_basis: 'budget', records_from: '2026-07-01' }, opts: { onConflict: 'household_id' } });
  });

  it('opens on the saved choice, and counts every month again when that is picked', async () => {
    const { onSaved } = renderLine(BUDGET, { planning_basis: 'budget', records_from: '2026-07-01' });
    fireEvent.click(screen.getByRole('button', { name: 'Change basis' }));
    expect(screen.getByRole('button', { name: 'Your budget' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Records count from').value).toBe('2026-07');
    fireEvent.change(screen.getByLabelText('Records count from'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls.upserts[0].row).toMatchObject({ planning_basis: 'budget', records_from: null });
  });

  it('says so when the save fails, and keeps the drawer open', async () => {
    calls.fail = { message: 'permission denied' };
    const { onSaved } = renderLine(RECORDED);
    fireEvent.click(screen.getByRole('button', { name: 'Change basis' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recorded months' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe("The basis wasn't saved: permission denied");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Planning basis' })).toBeTruthy();
  });
});
