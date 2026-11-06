import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

// The tax functions, answered per name; every call is recorded.
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

const { default: TaxReturnForm } = await import('./TaxReturnForm');

const PLANNED = { id: 'r-25', member_id: 'm1', financial_year: 2025, claim_basis: 'treaty', claim_rate_pct: 10, revision: 0, filed_on: null, dividend_income: null,
  dividend_tax: null, dividend_tds_claimed: null, tds_claimed_total: null, note: null, version: 3 };
const FILED = { ...PLANNED, revision: 1, filed_on: '2026-07-20', dividend_income: 10000, dividend_tax: 1000, dividend_tds_claimed: 2080, tds_claimed_total: 5000, version: 4 };

beforeEach(() => {
  calls.length = 0;
  answers = { save_tax_return: { ok: true, id: 'r-25', version: 5 } };
  cleanup();
});

function open(taxReturn = null) {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  renderScreen(<TaxReturnForm memberId="m1" year={2025} taxReturn={taxReturn} onSaved={onSaved} onCancel={onCancel} />);
  return { onSaved, onCancel };
}
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save return' })));

describe('the return form', () => {
  it('a first save sets the basis at version 0', async () => {
    const { onSaved } = open();
    expect(document.activeElement).toBe(screen.getByLabelText('Claim basis'));
    type('Claim basis', 'treaty');
    type('Rate (%)', '10');
    await save();
    expect(calls).toEqual([{ name: 'save_tax_return', args: { p_member_id: 'm1', p_financial_year: 2025, p_change: { claim_basis: 'treaty', claim_rate_pct: 10 }, p_expected_version: 0 } }]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('filing shows the figures and sends only what changed', async () => {
    open(PLANNED);
    expect(screen.queryByLabelText('Filed on')).toBeNull();
    type('Return', '1');
    type('Filed on', '2026-07-20');
    type('Dividend income', '10,000');
    type('Dividend tax', '1,000');
    await save();
    expect(calls[0].args).toEqual({ p_member_id: 'm1', p_financial_year: 2025,
      p_change: { revision: 1, filed_on: '2026-07-20', dividend_income: 10000, dividend_tax: 1000 }, p_expected_version: 3 });
  });

  it('amounts typed the Indian way', async () => {
    open(FILED);
    type('Dividend income', '1,20,000.50');
    await save();
    expect(calls[0].args.p_change).toEqual({ dividend_income: 120000.5 });
    // A save that worked keeps the form busy until the screen closes it, so
    // the bad amount is typed into a fresh one.
    cleanup();
    calls.length = 0;
    open(FILED);
    type('Dividend tax', '12a');
    await save();
    expect(calls).toEqual([]);
    expect(screen.getByText('Enter an amount, like 1000.50')).toBeTruthy();
  });

  it('a refusal keeps what was typed', async () => {
    answers.save_tax_return = { ok: false, error: 'filed_before_year_end' };
    const { onSaved } = open(PLANNED);
    type('Return', '1');
    type('Filed on', '2026-03-15');
    await save();
    expect(screen.getByRole('alert').textContent).toBe('A return can only be filed after its tax year has ended.');
    expect(screen.getByLabelText('Filed on').value).toBe('2026-03-15');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('emptying a figure clears it', async () => {
    open(FILED);
    type('Dividend tax', '');
    await save();
    expect(calls[0].args.p_change).toEqual({ dividend_tax: null });
  });

  it('changing the rate sends the basis with it, and Escape cancels', async () => {
    const { onCancel } = open(FILED);
    type('Rate (%)', '15');
    await save();
    expect(calls[0].args.p_change).toEqual({ claim_basis: 'treaty', claim_rate_pct: 15 });
    fireEvent.keyDown(screen.getByLabelText('Note'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});
