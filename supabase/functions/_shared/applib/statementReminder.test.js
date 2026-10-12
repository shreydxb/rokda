import { describe, expect, it } from 'vitest';
import { statementAnswer, statementQuestion, statementReactionDecision } from './statementReminder.js';

describe('statementQuestion', () => {
  it('names the card, the close and the due date, and says how to answer', () => {
    const q = statementQuestion({ cardName: 'Bank card', statementDate: '2026-09-28', dueDate: '2026-10-22' });
    expect(q).toContain('Bank card statement closed on 28 Sept');
    expect(q).toContain('Payment is due 22 Oct');
    expect(q).toContain('reply "done"');
  });

  it('is shorter as a reminder, and leaves out a due date it does not know', () => {
    const q = statementQuestion({ cardName: 'Bank card', statementDate: '2026-10-02', dueDate: null }, { reminder: true });
    expect(q).toMatch(/^Reminder: the Bank card statement from 2 Oct hasn't been reconciled yet\.\n/);
    expect(q).not.toContain('due');
  });
});

describe('statementAnswer', () => {
  it.each(['done', 'Done!', 'reconciled', 'yes done', "it's done", 'all done, thanks', 'sent to claude', '👍', '✅', 'done 👍🏽', 'statement checked'])(
    '%s means done',
    (text) => expect(statementAnswer(text)).toBe('done'),
  );

  it.each(['not yet', 'no', 'later', 'not done yet', 'tomorrow', "haven't checked it", '👎'])('%s means not yet', (text) =>
    expect(statementAnswer(text)).toBe('not_yet'),
  );

  it.each(['careem 19', 'done with lunch 40', 'what is my balance', '', 'paid'])('%s is not an answer', (text) =>
    expect(statementAnswer(text)).toBeNull(),
  );
});

describe('statementReactionDecision', () => {
  it('reads the same reactions as the autopay question', () => {
    expect(statementReactionDecision('👍')).toBe('done');
    expect(statementReactionDecision('👍🏻')).toBe('done');
    expect(statementReactionDecision('👎')).toBe('not_yet');
    expect(statementReactionDecision('❤')).toBeNull();
  });
});
