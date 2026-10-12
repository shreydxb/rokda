import { describe, it, expect } from 'vitest';
import { autopayAnswer, autopayCycle, autopayQuestion, autopayReactionDecision, dayString } from './autopay.js';

const day = (s) => new Date(`${s}T00:00:00`);
const emi = { next_due_date: '2026-10-03', cadence: 'monthly', interval_count: 1, ends_on: '2030-07-03' };

describe('autopayCycle', () => {
  it('starts on the due date itself, not the day after', () => {
    expect(autopayCycle(emi, day('2026-10-03'))).toEqual({ due: '2026-10-03', next: '2026-11-03' });
  });

  it('stays on that cycle until the next due date', () => {
    expect(autopayCycle(emi, day('2026-10-12'))).toEqual({ due: '2026-10-03', next: '2026-11-03' });
    expect(autopayCycle(emi, day('2026-11-02'))).toEqual({ due: '2026-10-03', next: '2026-11-03' });
    expect(autopayCycle(emi, day('2026-11-03'))).toEqual({ due: '2026-11-03', next: '2026-12-03' });
  });

  it('follows a stale stored date forward', () => {
    expect(autopayCycle({ ...emi, next_due_date: '2026-07-03' }, day('2026-10-05'))).toEqual({ due: '2026-10-03', next: '2026-11-03' });
  });

  it('asks nothing before the first date, after the last, or for an unknown cadence', () => {
    expect(autopayCycle(emi, day('2026-10-02'))).toBeNull();
    expect(autopayCycle(emi, day('2030-08-10'))).toBeNull();
    expect(autopayCycle({ ...emi, cadence: 'daily' }, day('2026-10-05'))).toBeNull();
  });

  it('keeps a month-end bill on the last day of short months', () => {
    const rent = { next_due_date: '2026-01-31', cadence: 'monthly', interval_count: 1 };
    expect(autopayCycle(rent, day('2026-02-28'))).toEqual({ due: '2026-02-28', next: '2026-03-31' });
  });

  it('honours every-N cycles', () => {
    const rent = { next_due_date: '2026-09-06', cadence: 'monthly', interval_count: 2 };
    expect(autopayCycle(rent, day('2026-10-20'))).toEqual({ due: '2026-09-06', next: '2026-11-06' });
  });
});

describe('autopayAnswer', () => {
  const paid = [
    'yes', 'Yes', 'YES!', 'y', 'yep', 'yeah', 'yup', 'ok', 'okay', 'done', 'Done.', 'paid', 'Paid', 'deducted', 'debited', 'cleared',
    'yes paid', 'yes, paid', 'yes deducted', 'yes it is', "it's paid", 'its paid', 'it’s paid', 'already paid', 'paid already',
    'got deducted', 'has been deducted', 'EMI paid', 'car emi deducted', 'yes it was deducted', 'payment done', 'all done',
    'yes done', 'paid, thanks', 'paid thank you', 'deducted from FAB', '👍', '👍🏽', '👍👍', '✅', '✔️', '👌', 'paid ✅', 'paid✅', 'yes 👍',
  ];
  for (const text of paid) {
    it(`reads "${text}" as paid`, () => {
      expect(autopayAnswer(text)).toEqual({ decision: 'paid', amount: null });
    });
  }

  const notYet = [
    'no', 'No.', 'nope', 'nah', 'not yet', 'Not yet', 'no not yet', 'not paid', 'not deducted', 'not yet deducted',
    'still pending', 'pending', "didn't", "hasn't been deducted", 'nothing yet', 'not paid yet', '👎', '❌', 'no 👎',
  ];
  for (const text of notYet) {
    it(`reads "${text}" as not yet`, () => {
      expect(autopayAnswer(text)).toEqual({ decision: 'not_yet', amount: null });
    });
  }

  it('reads an amount given with the answer', () => {
    expect(autopayAnswer('paid 2050')).toEqual({ decision: 'paid', amount: 2050 });
    expect(autopayAnswer('paid 2,050')).toEqual({ decision: 'paid', amount: 2050 });
    expect(autopayAnswer('yes, 2050.50 deducted')).toEqual({ decision: 'paid', amount: 2050.5 });
    expect(autopayAnswer('deducted AED 1,999.99')).toEqual({ decision: 'paid', amount: 1999.99 });
    // An amount means nothing beside "not yet".
    expect(autopayAnswer('not yet 2050')).toEqual({ decision: 'not_yet', amount: null });
  });

  const notAnswers = ['', '   ', 'paid 40 for lunch', 'spent 40 on lunch', 'what did we spend', 'yes I know, also bought coffee', 'paid 20 and 30', 'hello', 'ok google', 'paid 0', '🎉', null, undefined];
  for (const text of notAnswers) {
    it(`does not read ${JSON.stringify(text)} as an answer`, () => {
      expect(autopayAnswer(text).decision).toBeNull();
    });
  }
});

describe('autopayReactionDecision', () => {
  it('takes thumbs up, a tick or OK as paid, and thumbs down or a cross as not yet', () => {
    for (const e of ['👍', '👍🏿', '✅', '👌', '💯']) expect(autopayReactionDecision(e)).toBe('paid');
    for (const e of ['👎', '❌']) expect(autopayReactionDecision(e)).toBe('not_yet');
    for (const e of ['❤', '🔥', '', undefined]) expect(autopayReactionDecision(e)).toBeNull();
  });
});

describe('autopayQuestion', () => {
  const bill = { name: 'Car EMI', amount: 2000, accountName: 'Bank', due: '2026-10-03' };

  it('asks on the due date, saying how to answer', () => {
    const q = autopayQuestion(bill);
    expect(q).toContain('Car EMI (AED 2,000.00) was due today, 3 Oct. Has it been deducted from Bank?');
    expect(q).toMatch(/"yes" or "paid"/);
    expect(q).toMatch(/👍/);
    expect(q).toMatch(/"not yet"/);
  });

  it('says the date, not "today", when first asked after the due date', () => {
    expect(autopayQuestion(bill, { today: '2026-10-03' })).toContain('was due today, 3 Oct.');
    expect(autopayQuestion(bill, { today: '2026-10-13' })).toContain('Car EMI (AED 2,000.00) was due on 3 Oct. Has it been deducted from Bank?');
  });

  it('reminds on the days after', () => {
    expect(autopayQuestion(bill, { reminder: true })).toMatch(/^Reminder: has Car EMI \(AED 2,000.00, due 3 Oct\) been deducted from Bank yet\?/);
  });

  it('formats a day in local time', () => {
    expect(dayString(new Date(2026, 9, 3))).toBe('2026-10-03');
  });
});
