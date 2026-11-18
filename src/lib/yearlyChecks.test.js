import { describe, expect, it } from 'vitest';
import { orderNotes, yearlyCheckItems, yearlyCheckStatus, yearlyCheckText } from './yearlyChecks';

const NOW = new Date(2026, 9, 26, 12);

describe('yearly checks', () => {
  it('is nothing for an ordinary note, and due at once when never checked', () => {
    expect(yearlyCheckStatus({ check_yearly: false, checked_on: null }, NOW)).toBeNull();
    expect(yearlyCheckStatus({ check_yearly: true, checked_on: null }, NOW)).toEqual({ due: true, last: null, next: null });
  });

  it('is due again a year after it was checked, on the day itself', () => {
    expect(yearlyCheckStatus({ check_yearly: true, checked_on: '2025-10-27' }, NOW).due).toBe(false);
    expect(yearlyCheckStatus({ check_yearly: true, checked_on: '2025-10-26' }, NOW).due).toBe(true);
    expect(yearlyCheckStatus({ check_yearly: true, checked_on: '2026-03-01' }, NOW).next).toEqual(new Date(2027, 2, 1));
  });

  it('takes a check on 29 February to 28 February the next year', () => {
    expect(yearlyCheckStatus({ check_yearly: true, checked_on: '2028-02-29' }, NOW).next).toEqual(new Date(2029, 1, 28));
  });

  it('says where it stands in a line', () => {
    expect(yearlyCheckText(yearlyCheckStatus({ check_yearly: true, checked_on: null }, NOW))).toBe('Checked once a year · not checked yet');
    expect(yearlyCheckText(yearlyCheckStatus({ check_yearly: true, checked_on: '2026-03-01' }, NOW))).toBe('Checked once a year · last checked 1 Mar 2026 · next from 1 Mar 2027');
    expect(yearlyCheckText(yearlyCheckStatus({ check_yearly: true, checked_on: '2025-03-01' }, NOW))).toBe('Checked once a year · last checked 1 Mar 2025 · due now');
  });

  it('asks on Overview only for the checks that are due', () => {
    const items = yearlyCheckItems(
      [
        { id: 'a', title: 'Protection', check_yearly: true, checked_on: '2025-03-01' },
        { id: 'b', title: 'Domicile', check_yearly: true, checked_on: '2026-03-01' },
        { id: 'c', title: 'Wills', check_yearly: true, checked_on: null },
      ],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(['yearly-check-a', 'yearly-check-c']);
    expect(items[0]).toMatchObject({ kind: 'yearly_check', severity: 'info', title: 'Yearly check: Protection' });
    expect(items[0].detail).toMatch(/^Last checked 1 Mar 2025\. Go through the note in Planning → Notes/);
    expect(items[1].detail).toMatch(/^Not checked yet\./);
  });
});

// Notes' list (the revamp, phase 6c; decision 5 of the phase 6 design): a
// yearly check that is due first, then the other yearly ones, then the rest,
// each in the order they were written.
describe('orderNotes', () => {
  const now = new Date(2026, 10, 18, 12);
  const note = (id, position, extra = {}) => ({ id, title: id, position, check_yearly: false, checked_on: null, ...extra });

  it('puts a due check first, then the yearly ones, then the rest, each by position', () => {
    const notes = [
      note('plain-2', 2),
      note('yearly-checked', 5, { check_yearly: true, checked_on: '2026-06-01' }),
      note('plain-1', 1),
      note('due-later', 4, { check_yearly: true, checked_on: '2025-01-01' }),
      note('due-never', 3, { check_yearly: true, checked_on: null }),
    ];
    expect(orderNotes(notes, now).map((n) => n.id)).toEqual(['due-never', 'due-later', 'yearly-checked', 'plain-1', 'plain-2']);
  });

  it('leaves the notes it is given as they were', () => {
    const notes = [note('b', 2), note('a', 1)];
    orderNotes(notes, now);
    expect(notes.map((n) => n.id)).toEqual(['b', 'a']);
  });
});
