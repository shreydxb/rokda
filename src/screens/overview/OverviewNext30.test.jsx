import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import OverviewNext30 from './OverviewNext30';

const money = { fmt: (v) => Math.abs(Math.round(v)).toLocaleString('en-US'), fmtSigned: (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString('en-US')}` };
const due = (name, amount, day, autopay) => ({ occurrenceKey: name, name, amount, autopay, dueDate: new Date(2026, 10, day) });

// The Overview redesign (November 2026): the next 30 days as a short list,
// one row a bill, instead of a large box each.
describe('OverviewNext30', () => {
  it('lists each bill on one row: date, name, amount, autopay or not', () => {
    render(
      <MemoryRouter>
        <OverviewNext30 next30={[due('Streaming', -55, 20, true), due('Rent', -6500, 28, false)]} recurring={[{}]} money={money} committedTotal={6555} withoutAutopay={1} />
      </MemoryRouter>,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toMatch(/28 Nov.*Rent.*−6,500.*no autopay/);
  });

  // The fresh review: a long name must never hide the native amount.
  it("keeps a bill's native amount out of the name that may be cut short", () => {
    const usd = { ...due('Annual insurance renewal with a long name', -4591, 25, false), native_amount: -1250, currency: 'USD' };
    render(
      <MemoryRouter>
        <OverviewNext30 next30={[usd]} recurring={[{}]} money={money} committedTotal={4591} withoutAutopay={1} />
      </MemoryRouter>,
    );
    const native = screen.getByText(/\$1,250/);
    expect(native.closest('.ov-next30-name')).toBeNull();
    expect(screen.getByRole('list')).toBeTruthy();
  });
});
