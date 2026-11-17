import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import { renderScreen } from '../../test/renderScreen';
import PlanStrip from './PlanStrip';

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

const AED = { code: 'AED', fmt: (v) => Math.round(v).toLocaleString('en-US'), fmtCompact: (v) => `${Math.round(v / 1000)}K` };
const RECORDED = { ready: true, source: 'actual', monthCount: 3, avgMonthlySpend: 4000, monthlySaving: 6000, basis: null, recordsFrom: null, why: 'not-chosen', recordedMonths: ['2026-06', '2026-07', '2026-08'] };
const BUDGET = { ready: true, source: 'budget', monthCount: 3, budgetMonths: 4, avgMonthlySpend: 8000, monthlySaving: 1500, basis: 'budget', recordsFrom: null, why: 'chosen', recordedMonths: ['2026-06', '2026-07', '2026-08'] };

const SCENARIOS = [
  { key: 'baseline', label: 'Baseline' },
  { key: 'conservative', label: 'Conservative' },
  { key: 'optimistic', label: 'Optimistic' },
];

// Plan's strip (the revamp, phase 6): the basis in a few words with its
// figures, Change, and why behind an (i); then the scenario, the spending and
// the rates.
function renderLine(inputs, assumptions = null, props = {}) {
  const onSaved = vi.fn();
  renderScreen(
    <PlanStrip
      inputs={inputs}
      householdId="h"
      assumptions={assumptions}
      onSaved={onSaved}
      money={AED}
      scenarios={SCENARIOS}
      scenario="baseline"
      onScenario={() => {}}
      spendOptions={[{ key: 'today', label: "Today's", value: 48000 }]}
      spendKey="today"
      onSpend={() => {}}
      rates="6.0% return · 2.5% inflation"
      {...props}
    />,
  );
  return { onSaved };
}
// What the strip says of the basis, and what its (i) says.
const basis = () => document.querySelector('.pl-basis').textContent;
function why() {
  fireEvent.click(screen.getByRole('button', { name: 'About the basis' }));
  return screen.getByRole('note').textContent;
}

// Planning audit, 2.9: one always-on line, and the household's choice.
describe('PlanStrip: what the plan rests on', () => {
  it('says the records, and why and from when behind its (i)', () => {
    renderLine(RECORDED);
    expect(basis()).toBe('Basisrecorded months · spending 4,000 · saving 6,000 a month');
    expect(why()).toMatch(/^Recorded months\. The average of the last 3 ended months: spending AED 4,000 and saving AED 6,000 a month\. No basis is chosen/);
    document.body.innerHTML = '';
    renderLine({ ...RECORDED, basis: 'recorded', why: 'chosen', recordsFrom: '2026-06' });
    expect(why()).toMatch(/^Recorded months, as you chose\. The average of the last 3 ended months since Jun 2026: /);
  });

  it('says the budget, as chosen or standing in, and the records standing in for a missing budget', () => {
    renderLine(BUDGET);
    expect(basis()).toBe('Basisyour budget · spending 8,000 · saving 1,500 a month');
    expect(why()).toMatch(/^Your budget, as you chose\. Spending AED 8,000 and saving AED 1,500 a month, from your spending budget and savings target over 4 budgeted months\.$/);
    document.body.innerHTML = '';
    renderLine({ ...BUDGET, basis: 'recorded', why: 'few-months', monthCount: 1, recordsFrom: '2026-08' });
    expect(basis()).toMatch(/^Basisyour budget, for now · /);
    expect(why()).toMatch(/You chose recorded months; they take over once three have ended since Aug 2026 · 1 so far\./);
    document.body.innerHTML = '';
    renderLine({ ...RECORDED, basis: 'budget', why: 'no-budget' });
    expect(basis()).toMatch(/^Basisrecorded months, for now · /);
    expect(why()).toMatch(/^Recorded months, for now\. You chose your budget, but no month has a spending budget, so the last 3 ended months stand in/);
  });

  it('says there is no basis yet when a basis was chosen and nothing stands in', () => {
    renderLine({ ready: false, source: null, monthCount: 1, basis: 'budget', why: 'no-budget' });
    expect(basis()).toBe('Basisnone yet');
    expect(why()).toMatch(/^No basis yet\. You chose your budget, but no month has a spending budget/);
  });
});

describe('PlanStrip: changing the basis', () => {
  it('saves the basis and the month records count from', async () => {
    const { onSaved } = renderLine(RECORDED);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recorded months' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe("The basis wasn't saved: permission denied");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Planning basis' })).toBeTruthy();
  });
});

// The fresh review of the shell: that a choice is not in effect yet is a
// status, so it stays in view, not behind the (i).
describe('PlanStrip: a choice not in effect yet stays in view', () => {
  it('says how many of the three months the recorded months wait for', () => {
    renderLine({ ...BUDGET, basis: 'recorded', why: 'few-months', monthCount: 1, recordsFrom: '2026-08' });
    expect(screen.getByText('Recorded months: 1 of 3 ended')).toBeTruthy();
    document.body.innerHTML = '';
    renderLine(BUDGET);
    expect(screen.queryByText(/of 3 ended/)).toBeNull();
  });
});

describe('PlanStrip: the scenario, the spending and the rates', () => {
  it('lists the scenarios and the spending with its figure, and says the rates', () => {
    const onScenario = vi.fn();
    const onSpend = vi.fn();
    renderLine(RECORDED, null, {
      onScenario,
      onSpend,
      spendOptions: [
        { key: 'planned', label: 'Planned', value: 60000 },
        { key: 'today', label: "Today's", value: 48000 },
      ],
    });
    const scenario = screen.getByRole('combobox', { name: 'Scenario' });
    expect([...scenario.options].map((o) => o.textContent)).toEqual(['Baseline', 'Conservative', 'Optimistic']);
    fireEvent.change(scenario, { target: { value: 'conservative' } });
    expect(onScenario).toHaveBeenCalledWith('conservative');
    const spend = screen.getByRole('combobox', { name: 'Spending after work' });
    expect([...spend.options].map((o) => o.textContent)).toEqual(['Planned · 60K a year', "Today's · 48K a year"]);
    fireEvent.change(spend, { target: { value: 'planned' } });
    expect(onSpend).toHaveBeenCalledWith('planned');
    expect(document.querySelector('.pl-strip').textContent).toMatch(/6\.0% return · 2\.5% inflation/);
  });

  it('says the plan is the household\'s in one person\'s view', () => {
    renderLine(RECORDED, null, { householdOnly: true });
    expect(screen.getByText('Household')).toBeTruthy();
  });
});
