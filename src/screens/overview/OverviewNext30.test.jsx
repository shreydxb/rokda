import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import OverviewNext30 from './OverviewNext30';

const money = { fmt: (v) => Math.abs(Math.round(v)).toLocaleString('en-US'), fmtSigned: (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString('en-US')}` };
const NOW = new Date(2026, 10, 15, 12);
const due = (name, amount, day, autopay, over = {}) => ({ occurrenceKey: `${name}-${day}`, name, amount, autopay, dueDate: new Date(2026, 10, day), ...over });
const cover = { liquidAed: 10000, dueAed: 6555, covered: true, certain: true, shortfallAed: 0 };
const show = (items, c = cover) =>
  render(
    <MemoryRouter>
      <OverviewNext30 items={items} money={money} cover={c} now={NOW} />
    </MemoryRouter>,
  );

// The cockpit's Next 30 days (the revamp, phase 3): a dated strip, the next
// five as rows, and whether the cash to hand covers what is committed.
describe('OverviewNext30', () => {
  it('lists each bill on one row: date, name, autopay or not, amount', () => {
    show([due('Streaming', -55, 20, true), due('Rent', -6500, 28, false)]);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toMatch(/28 Nov.*Rent.*manual.*−6,500/);
    expect(screen.getByRole('img', { name: '2 bills and pay days in the next 30 days' })).toBeTruthy();
  });

  it('says a late bill and an unconfirmed autopay in words', () => {
    show([due('Gym', -250, 15, false, { late: true }), due('Streaming', -55, 15, true, { unconfirmed: true })]);
    expect(screen.getByText('Late')).toBeTruthy();
    expect(screen.getByText('Not confirmed')).toBeTruthy();
  });

  // The fresh review: past five, a bill was only on the strip, which a
  // keyboard or screen reader cannot reach.
  it('shows five rows, every one on the strip, and the rest on request', () => {
    show(Array.from({ length: 7 }, (_, i) => due(`Bill ${i}`, -10, 16 + i, false)));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(document.querySelectorAll('.ds-strip-mark')).toHaveLength(7);
    const more = screen.getByRole('button', { name: 'Show all 7' });
    fireEvent.click(more);
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });

  it('says when there are no recurring bills at all, not only none due', () => {
    render(
      <MemoryRouter>
        <OverviewNext30 items={[]} money={money} cover={null} now={NOW} hasRecurring={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No recurring bills or income set up yet.')).toBeTruthy();
  });

  it('says whether the cash covers what is committed, and never covers an unknown', () => {
    show([due('Rent', -6500, 28, false)]);
    expect(screen.getByText('Covered')).toBeTruthy();
    document.body.innerHTML = '';
    show([due('Rent', -6500, 28, false)], { ...cover, covered: false, shortfallAed: 500 });
    expect(screen.getByText('Short by 500')).toBeTruthy();
    document.body.innerHTML = '';
    show([due('Rent', -6500, 28, false)], { ...cover, certain: false });
    expect(screen.queryByText('Covered')).toBeNull();
    expect(screen.getByText('Not all converted')).toBeTruthy();
  });

  // The fresh review: a long name must never hide the native amount.
  it("keeps a bill's native amount out of the name that may be cut short", () => {
    const usd = { ...due('Annual insurance renewal with a long name', -4591, 25, false), native_amount: -1250, currency: 'USD' };
    show([usd]);
    const native = screen.getByText(/\$1,250/);
    expect(native.closest('.ov-next30-name')).toBeNull();
  });
});
