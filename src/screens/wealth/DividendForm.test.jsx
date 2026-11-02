import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// The dividend functions, answered per name. Each test sets what the
// database says; every call is recorded so a test can check what was sent.
const calls = [];
let answers = {};
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name, args) => {
      calls.push({ name, args });
      const answer = answers[name];
      const data = typeof answer === 'function' ? answer(args, calls.filter((c) => c.name === name).length) : answer;
      return { data: data ?? null, error: null };
    },
  },
}));

const { default: DividendForm } = await import('./DividendForm');
const { shortDate } = await import('../../lib/dividends');

const ABC = { id: 'h-abc', name: 'ABC', currency: 'USD', asset_class: 'us_equity', dividend_tax_pct: 30 };
const ACCOUNTS = [
  { id: 'f-usd', name: 'Dollar funds', type: 'broker_funds', currency: 'USD', balance: 100, balance_as_of: '2026-10-20T00:00:00+04:00', archived_at: null },
  { id: 'a-bank', name: 'Bank', type: 'checking', currency: 'USD', balance: 0, balance_as_of: null, archived_at: null },
  { id: 'f-inr', name: 'Rupee funds', type: 'broker_funds', currency: 'INR', balance: 0, balance_as_of: null, archived_at: null },
];
const EARNED = {
  id: 'd-1', holding_id: 'h-abc', currency: 'USD', status: 'earned', ex_date: '2026-10-15', pay_date: '2026-10-20', credited_on: null, units: 40, per_share: 0.25,
  tax_pct: 30, expected_gross: 10, expected_tax: 3, expected_fees: 0, expected_net: 7, version: 2, paid_into_account_id: 'f-usd', event_id: 'e-1',
};
const CONFIRMATIONS = { 'f-usd': '2026-10-19 20:00:00+00' };
const preview = (over = {}) => ({
  ok: true, dividend: { ...EARNED, status: 'received', received_net: 7, credited_on: '2026-10-20' },
  movements: [{ account_id: 'f-usd', account_name: 'Dollar funds', currency: 'USD', delta: 7, balance_after: 107 }],
  confirmations: CONFIRMATIONS, version: 2, asks: null, warnings: [], ...over,
});

beforeEach(() => {
  calls.length = 0;
  answers = {};
  cleanup();
});

function open({ dividend = EARNED, action = 'record', onSaved = vi.fn().mockResolvedValue(undefined), onCancel = vi.fn() } = {}) {
  renderScreen(<DividendForm holding={ABC} dividend={dividend} action={action} accounts={ACCOUNTS} onCancel={onCancel} onSaved={onSaved} />);
  return { onSaved, onCancel };
}
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = async (name) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};
const saveButton = () => screen.getByRole('button', { name: 'Save dividend' });

describe('DividendForm: recording one that arrived', () => {
  it('checks the change with the database and says what it does to the fund', async () => {
    answers.preview_dividend = preview();
    open();
    expect(saveButton().disabled).toBe(true);
    await press('Check');
    expect(calls).toEqual([{ name: 'preview_dividend', args: { p_dividend_id: 'd-1', p_change: { action: 'record' } } }]);
    expect(screen.getByText('Net USD 7.00')).toBeTruthy();
    expect(screen.getByText('Adds USD 7.00 to Dollar funds')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it('saves what was checked, on the version and confirmations it was checked against', async () => {
    answers.preview_dividend = preview();
    answers.save_dividend = { ok: true };
    const { onSaved } = open();
    await press('Check');
    await press('Save dividend');
    expect(calls.at(-1)).toEqual({
      name: 'save_dividend',
      args: { p_dividend_id: 'd-1', p_change: { action: 'record' }, p_expected_version: 2, p_expected_confirmations: CONFIRMATIONS },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('sends a credit date or received figures only when they were given', async () => {
    answers.preview_dividend = preview();
    open();
    expect(screen.getByLabelText('Credited on').value).toBe('2026-10-20');
    type('Credited on', '2026-10-22');
    type('Tax withheld (USD)', '2.5');
    await press('Check');
    expect(calls[0].args.p_change).toEqual({ action: 'record', credited_on: '2026-10-22', received_tax: 2.5 });
  });

  it('asks whether it was already in a balance confirmed on or after it, and saves only with an answer', async () => {
    answers.preview_dividend = (args) => (args.p_change.already_included === undefined ? preview({ asks: 'already_included' }) : preview({ movements: [] }));
    answers.save_dividend = { ok: true };
    open();
    await press('Check');
    expect(saveButton().disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByLabelText(`Already in the balance confirmed on ${shortDate('2026-10-20')}`));
    });
    expect(calls.at(-1).args.p_change).toEqual({ action: 'record', already_included: true });
    expect(screen.getByText('Moves no balance')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    await press('Save dividend');
    expect(calls.at(-1).args.p_change).toEqual({ action: 'record', already_included: true });
  });

  it('clears the check when a field changes', async () => {
    answers.preview_dividend = preview();
    open();
    await press('Check');
    expect(saveButton().disabled).toBe(false);
    type('Fees (USD)', '0.2');
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText('Adds USD 7.00 to Dollar funds')).toBeNull();
  });

  it('shows a refusal in words and keeps what was typed', async () => {
    answers.preview_dividend = preview();
    answers.save_dividend = { ok: false, error: 'stale' };
    const { onSaved } = open();
    type('Fees (USD)', '0.2');
    await press('Check');
    await press('Save dividend');
    expect(screen.getByRole('alert').textContent).toBe('This dividend changed since you opened it. Check it again.');
    expect(screen.getByLabelText('Fees (USD)').value).toBe('0.2');
    expect(saveButton().disabled).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('DividendForm: fixing, skipping and adding', () => {
  it('fixes the amount, the withholding and where it is paid', async () => {
    answers.preview_dividend = preview();
    open({ action: 'fix' });
    // Only funds and accounts in the dividend's currency can take it.
    const options = [...screen.getByLabelText('Paid into').querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['Dollar funds', 'Bank']);
    type('Amount per share (USD)', '0.3');
    type('Withholding (%)', '25');
    type('Paid into', 'a-bank');
    await press('Check');
    expect(calls[0].args.p_change).toEqual({ action: 'fix', per_share: 0.3, tax_pct: 25, paid_into_account_id: 'a-bank' });
  });

  it('skips one that never came, after checking what it moves', async () => {
    answers.preview_dividend = preview({ movements: [] });
    open({ action: 'skip' });
    expect(screen.queryByLabelText('Credited on')).toBeNull();
    await press('Check');
    expect(calls[0].args).toEqual({ p_dividend_id: 'd-1', p_change: { action: 'skip' } });
    expect(screen.getByText('Moves no balance')).toBeTruthy();
  });

  it('adds one the feed missed', async () => {
    answers.preview_dividend = preview({ version: 0 });
    answers.save_dividend = { ok: true };
    open({ dividend: null, action: 'add' });
    type('Ex-date', '2026-06-12');
    type('Units held on the ex-date', '40');
    type('Amount per share (USD)', '0.25');
    await press('Check');
    expect(calls[0].args).toEqual({
      p_dividend_id: null,
      p_change: { action: 'add', holding_id: 'h-abc', ex_date: '2026-06-12', units: 40, per_share: 0.25, tax_pct: 30, paid_into_account_id: 'f-usd' },
    });
    await press('Save dividend');
    expect(calls.at(-1).args.p_dividend_id).toBeNull();
  });

  it('asks for the figures an added dividend needs before checking', async () => {
    open({ dividend: null, action: 'add' });
    await press('Check');
    expect(calls).toEqual([]);
    expect(screen.getByText('Enter the ex-date or the day it was credited.')).toBeTruthy();
    expect(screen.getByText('Enter the units held.')).toBeTruthy();
  });
});
