import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';

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

const { default: TaxEventForm } = await import('./TaxEventForm');

const FILED = { id: 'r-25', member_id: 'm1', financial_year: 2025, revision: 1, filed_on: '2026-07-20', version: 4 };

beforeEach(() => {
  calls.length = 0;
  answers = { save_tax_return_event: { ok: true, id: 'e-new' } };
  cleanup();
});

function open({ taxReturn = FILED, event = null } = {}) {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  renderScreen(<TaxEventForm memberId="m1" year={2025} taxReturn={taxReturn} event={event} onSaved={onSaved} onCancel={vi.fn()} />);
  return { onSaved };
}
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));

describe('what happened to the refund', () => {
  it('recording a credit', async () => {
    const { onSaved } = open();
    type('What happened', 'refund_credited');
    type('Date', '2026-09-20');
    type('Amount', '5,150');
    await save();
    expect(calls).toEqual([{ name: 'save_tax_return_event', args: { p_member_id: 'm1', p_financial_year: 2025,
      p_event: { kind: 'refund_credited', happened_on: '2026-09-20', amount: 5150, revision: 1 }, p_event_id: null, p_expected_version: null } }]);
    expect(onSaved).toHaveBeenCalled();
    expect(screen.queryByLabelText('For')).toBeNull();
  });

  it('a processing with a demand', async () => {
    open();
    type('What happened', 'processed');
    type('Date', '2026-09-01');
    type('Refund determined', '-500');
    type('Interest', '0');
    await save();
    expect(calls[0].args.p_event).toEqual({ kind: 'processed', happened_on: '2026-09-01', refund_determined: -500, refund_interest: 0, revision: 1 });
  });

  it("a negative amount is refused before sending, except a demand", async () => {
    open();
    type('What happened', 'refund_credited');
    type('Date', '2026-09-20');
    type('Amount', '-5');
    await save();
    expect(calls).toEqual([]);
    expect(screen.getByText('Enter an amount, like 1000.50')).toBeTruthy();
  });

  it("a revised return's event defaults to the latest revision", async () => {
    open({ taxReturn: { ...FILED, revision: 2 } });
    expect(screen.getByLabelText('For').value).toBe('2');
    expect(screen.getByRole('option', { name: 'Revised return' }).selected).toBe(true);
    type('What happened', 'refund_credited');
    type('Date', '2026-09-20');
    type('Amount', '100');
    type('For', '1');
    await save();
    expect(calls[0].args.p_event.revision).toBe(1);
  });

  it("fixing sends the event's id and all of it", async () => {
    open({ event: { id: 'e1', kind: 'refund_credited', happened_on: '2026-09-20', amount: 5150, revision: 1, note: 'first credit', version: 3 } });
    type('Amount', '5100');
    await save();
    expect(calls[0].args).toEqual({ p_member_id: 'm1', p_financial_year: 2025,
      p_event: { kind: 'refund_credited', happened_on: '2026-09-20', amount: 5100, revision: 1, note: 'first credit' }, p_event_id: 'e1', p_expected_version: 3 });
  });

  it('a refusal keeps the form', async () => {
    answers.save_tax_return_event = { ok: false, error: 'in_future' };
    const { onSaved } = open();
    type('What happened', 'refund_credited');
    type('Date', '2026-09-20');
    type('Amount', '100');
    await save();
    expect(screen.getByRole('alert').textContent).toBe('That date is after today.');
    expect(screen.getByLabelText('Amount').value).toBe('100');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('missing figures are named before sending', () => {
  it('a processing needs its refund, a credit its amount, and the date comes after the year', async () => {
    open();
    type('What happened', 'processed');
    type('Date', '2026-09-01');
    type('Refund determined', '');
    await save();
    expect(screen.getByText('Give the refund determined.')).toBeTruthy();
    type('What happened', 'refund_credited');
    type('Amount', '0');
    await save();
    expect(screen.getByText('Give the amount.')).toBeTruthy();
    type('Amount', '100');
    type('Date', '2026-03-01');
    await save();
    expect(screen.getByText('A date after the tax year ended, from 1 Apr 2026.')).toBeTruthy();
    expect(screen.getByLabelText('Date').getAttribute('min')).toBe('2026-04-01');
    expect(calls).toEqual([]);
  });
});

