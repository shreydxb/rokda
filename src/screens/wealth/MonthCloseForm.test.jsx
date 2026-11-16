import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { renderScreen } from '../../test/renderScreen';
import { useMonthClose } from '../../lib/useMonthClose';

// QA-05 / SHR-246: net_worth_snapshots was read but never written. History
// accumulates because someone closes a month, and a close records what it was
// shown and confirmed, once. These tests drove the close through Net worth;
// the close is Month end's now (the revamp, phase 5a), so they drive the
// shared close (lib/useMonthClose.js and this form) directly.
const upserts = [];
// A real upsert with ignoreDuplicates + .select() returns the written row on
// a genuine insert, and an empty array when the conflict target already
// existed and nothing was written: another session already closed the month.
let conflict = false;
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    from: (table) => ({
      upsert: (row, options) => {
        upserts.push({ table, row, options });
        return { select: () => Promise.resolve(conflict ? { data: [], error: null } : { data: [row], error: null }) };
      },
    }),
  },
}));

const { default: MonthCloseForm } = await import('./MonthCloseForm');

// The close as a screen uses it: a "Close {month}" button, then the form.
function Host({ accounts, onClosed, now }) {
  const close = useMonthClose({ householdId: 'hh', accounts, holdings: [], netWorthSnapshots: [], now, onClosed });
  return (
    <>
      {close.pending && !close.draft && (
        <button type="button" onClick={close.open}>
          {`Close ${close.monthLabel}`}
        </button>
      )}
      <MonthCloseForm close={close} />
    </>
  );
}

const savings = { id: 's1', name: 'Savings', type: 'savings', balance: 1000, is_shared: true, archived_at: null };
const open = (accounts = [savings], { onClosed = vi.fn().mockResolvedValue(undefined), now = new Date() } = {}) => {
  renderScreen(<Host accounts={accounts} onClosed={onClosed} now={now} />);
  return { onClosed };
};
const click = async (el) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

beforeEach(() => {
  upserts.length = 0;
  conflict = false;
});

describe('Closing a month', () => {
  it('shows what it would write before writing, then writes one idempotent row', async () => {
    const { onClosed } = open();
    await click(screen.getByRole('button', { name: /^Close / }));
    expect(upserts).toHaveLength(0);
    await click(screen.getByRole('button', { name: /Confirm & close/ }));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe('net_worth_snapshots');
    expect(upserts[0].options).toEqual({ onConflict: 'household_id,snapshot_date', ignoreDuplicates: true });
    expect(upserts[0].row.assets).toBe(1000);
    expect(onClosed).toHaveBeenCalled();
  });

  // The QA recheck: "Close August" from live September balances must never
  // write those balances as August's history unseen.
  it("does not write September's balances as August's history by itself", async () => {
    open([{ ...savings, balance: 9000, balance_as_of: '2026-09-06T00:00:00Z' }], { now: new Date('2026-09-06T12:00:00Z') });
    await click(screen.getByRole('button', { name: /^Close / }));
    expect(upserts).toHaveLength(0);
  });

  // 762a6c4 recheck: a blank or non-numeric figure is refused, not taken as 0.
  it('refuses to close on a figure left blank', async () => {
    open();
    await click(screen.getByRole('button', { name: /^Close / }));
    fireEvent.change(screen.getByLabelText('Assets (AED)'), { target: { value: '' } });
    const confirm = screen.getByRole('button', { name: /Confirm & close/ });
    expect(confirm.disabled).toBe(true);
    await click(confirm);
    expect(upserts).toHaveLength(0);
  });

  // A total with a gap is not offered for confirming: the rupee account has
  // no AED value, so today's assets leave it out.
  it('does not fill in a close whose totals have a gap, and names it', async () => {
    open([savings, { id: 'r1', name: 'Rupee account', type: 'savings', currency: 'INR', balance: 50000, balance_aed: null, is_shared: true, archived_at: null }]);
    await click(screen.getByRole('button', { name: /^Close / }));
    expect(screen.getByTestId('close-gaps').textContent).toMatch(/Rupee account/);
    expect([screen.getByLabelText('Assets (AED)').value, screen.getByLabelText('Liabilities (AED)').value]).toEqual(['', '']);
    const confirm = screen.getByRole('button', { name: /Confirm & close/ });
    expect(confirm.disabled).toBe(true);
    await click(confirm);
    expect(upserts).toHaveLength(0);
  });

  it('says a month another session closed first was not saved, rather than reloading as if it were', async () => {
    conflict = true;
    const { onClosed } = open();
    await click(screen.getByRole('button', { name: /^Close / }));
    await click(screen.getByRole('button', { name: /Confirm & close/ }));
    expect(screen.getByRole('alert').textContent).toMatch(/already closed by another session/i);
    expect(onClosed).not.toHaveBeenCalled();
  });
});
