import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup, within } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// The dividend functions, answered per name, every call recorded.
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

const { default: HoldingDividends } = await import('./HoldingDividends');

const ABC = { id: 'h-abc', name: 'ABC', currency: 'USD', asset_class: 'us_equity', dividend_tax_pct: 30 };
const ACCOUNTS = [
  { id: 'f-usd', name: 'Dollar funds', type: 'broker_funds', currency: 'USD', balance: 100, balance_as_of: '2026-10-01T00:00:00+00:00', archived_at: null },
  { id: 'a-bank', name: 'Bank', type: 'checking', currency: 'USD', balance: 0, balance_as_of: null, archived_at: null },
];
const row = (over) => ({
  holding_id: 'h-abc', currency: 'USD', units: 40, per_share: 0.25, tax_pct: 30, expected_gross: 10, expected_tax: 3, expected_fees: 0, expected_net: 7,
  received_net: null, credited_on: null, pay_date: null, review_reason: null, review_event_id: null, event_id: null, version: 1, paid_into_account_id: 'f-usd',
  ...over,
});
// Newest first: the flagged one, the earned one, the presumed one, the skipped one.
const DUPLICATE = row({ id: 'd-dup', ex_date: '2026-10-25', status: 'earned', review_reason: 'possible_duplicate', review_event_id: 'e-2', event_id: 'e-0', version: 3 });
const EARNED = row({ id: 'd-earned', ex_date: '2026-10-15', pay_date: '2026-10-20', status: 'earned', event_id: 'e-1' });
const PRESUMED = row({ id: 'd-presumed', ex_date: '2026-09-10', status: 'presumed', credited_on: '2026-10-12', paid_into_account_id: 'a-bank' });
const SKIPPED = row({ id: 'd-skipped', ex_date: '2026-08-05', status: 'skipped' });
const ROWS = [SKIPPED, EARNED, DUPLICATE, PRESUMED];

beforeEach(() => {
  calls.length = 0;
  answers = {};
  cleanup();
});

function open({ dividends = ROWS, specialParts = [], failed = false, disabledReason = null, onChanged = vi.fn().mockResolvedValue(undefined), onFormOpen = vi.fn() } = {}) {
  renderScreen(
    <HoldingDividends holding={ABC} dividends={dividends} specialParts={specialParts} accounts={ACCOUNTS} failed={failed} disabledReason={disabledReason} onChanged={onChanged} onFormOpen={onFormOpen} />,
  );
  return { onChanged, onFormOpen };
}
const rows = () => screen.getAllByRole('listitem');
const button = (item, name) => within(item).queryByRole('button', { name });

describe('HoldingDividends: the rows and what each can do', () => {
  it('offers Record on an earned or presumed dividend, and Restore on a skipped one', () => {
    open();
    const [dup, earned, presumed, skipped] = rows();
    expect(within(dup).getByText(/Earned/)).toBeTruthy();
    expect(button(earned, 'Record')).toBeTruthy();
    expect(button(earned, 'Skip')).toBeTruthy();
    expect(within(presumed).getByText(/Presumed received, not checked/)).toBeTruthy();
    expect(within(presumed).getByText(/into Bank/)).toBeTruthy();
    expect(button(presumed, 'Record')).toBeTruthy();
    expect(button(skipped, 'Restore')).toBeTruthy();
    expect(button(skipped, 'Record')).toBeNull();
    expect(button(skipped, 'Fix')).toBeNull();
  });

  it('says why a row is flagged, and a possible duplicate can be linked to the feed', async () => {
    const { onChanged } = open();
    const [dup] = rows();
    expect(within(dup).getByText('The feed has a dividend close to this date. Is it this one?')).toBeTruthy();
    answers.link_dividend = { ok: true };
    await act(async () => {
      fireEvent.click(button(dup, "It's this one"));
    });
    expect(calls).toEqual([{ name: 'link_dividend', args: { p_dividend_id: 'd-dup', p_event_id: 'e-2', p_expected_version: 3 } }]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps a flagged row as it is', async () => {
    answers.keep_dividend = { ok: true };
    const { onChanged } = open();
    await act(async () => {
      fireEvent.click(button(rows()[0], 'Keep as it is'));
    });
    expect(calls).toEqual([{ name: 'keep_dividend', args: { p_dividend_id: 'd-dup', p_expected_version: 3 } }]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows a refusal in the row, and changes nothing', async () => {
    answers.keep_dividend = { ok: false, error: 'stale' };
    const { onChanged } = open();
    await act(async () => {
      fireEvent.click(button(rows()[0], 'Keep as it is'));
    });
    expect(within(rows()[0]).getByRole('alert').textContent).toBe('This dividend changed since you opened it. Check it again.');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("records the one-off part of a feed's dividend per share", async () => {
    answers.set_special_part = { ok: true };
    const { onChanged } = open({ specialParts: [] });
    const earned = rows()[1];
    fireEvent.click(button(earned, 'Part was a one-off…'));
    fireEvent.change(within(earned).getByLabelText('One-off part per share (USD)'), { target: { value: '0.1' } });
    await act(async () => {
      fireEvent.click(button(earned, 'Save one-off part'));
    });
    expect(calls).toEqual([{ name: 'set_special_part', args: { p_event_id: 'e-1', p_special_per_share: 0.1 } }]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows a one-off part already given', () => {
    open({ specialParts: [{ event_id: 'e-1', special_per_share: 0.1 }] });
    expect(within(rows()[1]).getByText(/USD 0.10 per share was a one-off/)).toBeTruthy();
  });

  it('opens the form to add a dividend, and tells the editor', () => {
    const { onFormOpen } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Add a dividend' }));
    expect(onFormOpen).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText('Ex-date')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to dividends' }));
    expect(onFormOpen).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Add a dividend' })).toBeTruthy();
  });

  it('says when there are none yet', () => {
    open({ dividends: [] });
    expect(screen.getByText('No dividends on this holding yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a dividend' })).toBeTruthy();
  });
});

describe('HoldingDividends: while it cannot act', () => {
  it('turns every action off, and says why', () => {
    open({ disabledReason: 'Save or discard your changes to the holding first.' });
    expect(screen.getByText('Save or discard your changes to the holding first.')).toBeTruthy();
    for (const b of screen.getAllByRole('button')) expect(b.disabled).toBe(true);
  });

  it('says the dividends did not load, and offers nothing', () => {
    open({ failed: true });
    expect(screen.getByRole('alert').textContent).toMatch(/^Couldn.t load this holding.s dividends\./);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
