import { describe, it, expect } from 'vitest';
import { buildTodo, TODO_GROUPS } from './todo';

// Overview's To do (the revamp, phase 3; review S-overview-1, N13): the one
// list of everything that needs someone, grouped Today / Month end /
// Planning, each row a name, a short status and a button named for the job.

const att = (over) => ({ id: over.id ?? `x-${over.kind}`, severity: 'warn', title: 'long', detail: 'long', ...over });

describe('buildTodo', () => {
  it('groups in a fixed order, the most pressing first within each', () => {
    const rows = buildTodo({
      attention: [
        att({ kind: 'month_close', name: 'October', status: 'Not closed' }),
        att({ kind: 'balance_unset', severity: 'info', name: 'Savings', status: 'Balance 40d old', accountId: 'a2' }),
        att({ kind: 'missing_recurring', name: 'Gym', status: 'Late · was due 10 Nov', recurringId: 'r1', late: true }),
        att({ kind: 'yearly_check', severity: 'info', name: 'Insurance', status: 'Yearly check due', noteId: 'n1' }),
      ],
    });
    expect(TODO_GROUPS).toEqual(['Today', 'Month end', 'Planning']);
    expect(rows.map((r) => [r.group, r.title])).toEqual([
      ['Today', 'Gym'],
      ['Today', 'Savings'],
      ['Month end', 'October'],
      ['Planning', 'Insurance'],
    ]);
  });

  it('names each button for what it does', () => {
    const rows = buildTodo({
      attention: [
        att({ kind: 'missing_recurring', name: 'Gym', status: 'Late · was due 10 Nov', recurringId: 'r1', late: true }),
        att({ kind: 'missing_recurring', id: 'm2', name: 'Streaming', status: 'Autopay not confirmed · due 12 Nov', recurringId: 'r2', late: false }),
        att({ kind: 'balance_unset', name: 'Cash wallet', status: 'Balance not confirmed', accountId: 'a1' }),
        att({ kind: 'card_due', severity: 'urgent', name: 'Bank card', status: 'Payment due in 3d', accountId: 'c1' }),
        att({ kind: 'stale_holding', severity: 'info', name: 'Index fund', status: 'Price 9d old', holdingId: 'h1' }),
        att({ kind: 'month_close', name: 'October', status: 'Not closed' }),
        att({ kind: 'backup', name: 'Backup', status: 'None recorded' }),
        att({ kind: 'yearly_check', severity: 'info', name: 'Insurance', status: 'Yearly check due', noteId: 'n1' }),
      ],
    });
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.action]));
    expect(byTitle.Gym).toEqual({ kind: 'mark-paid', label: 'Mark paid', recurringId: 'r1' });
    expect(byTitle.Streaming).toEqual({ kind: 'mark-paid', label: 'Mark paid', recurringId: 'r2' });
    expect(byTitle['Cash wallet']).toEqual({ kind: 'link', label: 'Confirm balance', href: '/wealth?tab=accounts' });
    expect(byTitle['Bank card']).toEqual({ kind: 'link', label: 'Open card', href: '/wealth?tab=accounts' });
    expect(byTitle['Index fund']).toEqual({ kind: 'link', label: 'Update price', href: '/wealth?tab=investments' });
    expect(byTitle.October).toEqual({ kind: 'link', label: 'Close month', href: '/money?tab=review' });
    expect(byTitle.Backup).toEqual({ kind: 'link', label: 'Record backup', href: '/settings?tab=backups' });
    expect(byTitle.Insurance).toEqual({ kind: 'link', label: 'Open notes', href: '/planning?tab=notes' });
  });

  it('colours by what is wrong: late or due red, a look needed amber, the rest grey', () => {
    const rows = buildTodo({
      attention: [
        att({ kind: 'missing_recurring', name: 'Gym', status: 'Late', recurringId: 'r1', late: true }),
        att({ kind: 'missing_recurring', id: 'm2', name: 'Streaming', status: 'Autopay', recurringId: 'r2', late: false }),
        att({ kind: 'card_due', severity: 'urgent', name: 'Bank card', status: 'Due', accountId: 'c1' }),
        att({ kind: 'stale_holding', severity: 'info', name: 'Index fund', status: 'Old', holdingId: 'h1' }),
      ],
    });
    expect(Object.fromEntries(rows.map((r) => [r.title, r.tone]))).toEqual({ Gym: 'neg', 'Bank card': 'neg', Streaming: 'warn', 'Index fund': 'neutral' });
  });

  it('keeps a record to review as the in-place categorise and mark-reviewed row', () => {
    const tx = { id: 't1', merchant: 'Unknown', amount: -95, occurred_at: '2026-11-13' };
    const [row] = buildTodo({ attention: [att({ kind: 'review', id: 'review-t1', tx })] });
    expect(row).toMatchObject({ group: 'Today', title: 'Unknown', action: { kind: 'review', tx } });
  });

  // "Groceries running high" is a finding, not a decision: it shows under
  // What changed instead.
  it('leaves out a category running high', () => {
    expect(buildTodo({ attention: [att({ kind: 'category_anomaly', categoryId: 'g' })] })).toEqual([]);
  });

  it('lists the latest statement to check on each card, and counts the older ones', () => {
    const card = { id: 'c1', name: 'Bank card' };
    const rows = buildTodo({
      statements: [
        { account: card, statementDate: '2026-11-10', periodStart: '2026-10-11', status: 'unchecked' },
        { account: card, statementDate: '2026-10-10', periodStart: '2026-09-11', status: 'mismatch' },
        { account: card, statementDate: '2026-09-10', periodStart: '2026-08-11', status: 'unchecked' },
        { account: card, statementDate: '2026-08-10', periodStart: '2026-07-11', status: 'reconciled' },
        { account: { id: 'c2', name: 'Travel card' }, statementDate: '2026-11-05', periodStart: '2026-10-06', status: 'reconciled' },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      group: 'Month end',
      title: 'Bank card statement',
      status: 'To check · 11 Oct – 10 Nov · 2 older',
      tone: 'warn',
      action: { kind: 'link', label: 'Check', href: '/wealth?tab=statements' },
    });
  });

  it("says a statement that doesn't match, in red", () => {
    const [row] = buildTodo({ statements: [{ account: { id: 'c1', name: 'Bank card' }, statementDate: '2026-11-10', periodStart: '2026-10-11', status: 'mismatch' }] });
    expect(row).toMatchObject({ status: "Doesn't match · 11 Oct – 10 Nov", tone: 'neg' });
  });

  it('asks each dividend question once, by holding', () => {
    const rows = buildTodo({
      dividendQuestions: [
        { kind: 'one_off', holdingId: 'h1', eventId: 'e1' },
        { kind: 'flagged', holdingId: 'h2', dividendId: 'd1' },
      ],
      holdings: [
        { id: 'h1', name: 'Infra fund' },
        { id: 'h2', name: 'Index fund' },
      ],
    });
    expect(rows.map((r) => [r.group, r.title, r.status, r.action.label, r.action.href])).toEqual([
      ['Today', 'Infra fund dividend', 'One-off question', 'Answer', '/wealth?tab=dividends'],
      ['Today', 'Index fund dividend', 'Needs a look', 'Answer', '/wealth?tab=dividends'],
    ]);
  });

  it('raises a goal due within 3 years and short of cash, under Planning', () => {
    const [row] = buildTodo({ goalsShort: [{ goal: { id: 'g1', name: 'Car' }, remaining: 20000 }] });
    expect(row).toMatchObject({ group: 'Planning', title: 'Car', status: 'Short of cash · AED 20,000 to set aside', tone: 'warn', action: { kind: 'link', label: 'Open goal', href: '/planning?tab=goals' } });
  });

  it('gives every row its own key', () => {
    const rows = buildTodo({
      attention: [att({ kind: 'month_close', name: 'October', status: 'Not closed' })],
      goalsShort: [{ goal: { id: 'g1', name: 'Car' }, remaining: 1 }],
      dividendQuestions: [{ kind: 'one_off', holdingId: 'h1', eventId: 'e1' }],
      holdings: [{ id: 'h1', name: 'Fund' }],
    });
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

describe('buildTodo: from the fresh review of the cockpit', () => {
  it('carries the date a late bill was due to Mark paid', () => {
    const [row] = buildTodo({ attention: [att({ kind: 'missing_recurring', name: 'Gym', status: 'Late', recurringId: 'r1', late: true, dueOn: '2026-11-05', income: false })] });
    expect(row.action).toEqual({ kind: 'mark-paid', label: 'Mark paid', recurringId: 'r1', dueOn: '2026-11-05' });
  });

  it('says Mark received for pay', () => {
    const [row] = buildTodo({ attention: [att({ kind: 'missing_recurring', name: 'Salary', status: 'Late', recurringId: 'r2', late: true, dueOn: '2026-11-01', income: true })] });
    expect(row.action.label).toBe('Mark received');
  });

  it('says a goal amount is in dirhams', () => {
    const [row] = buildTodo({ goalsShort: [{ goal: { id: 'g1', name: 'Car' }, remaining: 20000 }] });
    expect(row.status).toBe('Short of cash · AED 20,000 to set aside');
  });
});
