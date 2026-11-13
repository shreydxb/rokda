import { describe, expect, it } from 'vitest';
import { statementAlreadySettledMessage, statementAnswer, statementAskDue, statementDoneMessage, statementNotYetMessage, statementQuestion, statementReactionDecision, statementSentMessage } from './statementReminder.js';

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
  it.each(['done', 'Done!', 'reconciled', 'yes done', "it's done", 'all done, thanks', 'yes', '👍', '✅', 'done 👍🏽', 'statement checked', 'sent and checked'])(
    '%s means done',
    (text) => expect(statementAnswer(text)).toBe('done'),
  );

  it.each(['not yet', 'no', 'later', 'not done yet', 'tomorrow', "haven't checked it", '👎', 'sent, not checked'])('%s means not yet', (text) =>
    expect(statementAnswer(text)).toBe('not_yet'),
  );

  // Handing the statement over is not the same as checking it (QA, 15 Oct).
  it.each(['sent to claude', 'Sent it to Claude', 'uploaded', 'shared', 'yes, sent it', 'ok uploaded'])('%s means sent, not done', (text) =>
    expect(statementAnswer(text)).toBe('sent'),
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

describe('replies', () => {
  it('says done, not reconciled, for a member\'s answer', () => {
    expect(statementDoneMessage('Bank card', '2026-09-28')).toBe('Thanks. The Bank card statement from 28 Sept is marked as done.');
  });

  it('says what a statement already settled is, rather than that this answer settled it', () => {
    expect(statementAlreadySettledMessage('Bank card', '2026-09-28', 'mismatch')).toContain("doesn't match Rokda");
    expect(statementAlreadySettledMessage('Bank card', '2026-09-28', 'reconciled')).toContain('already been reconciled');
    expect(statementAlreadySettledMessage('Bank card', '2026-09-28', 'confirmed')).toContain('already marked as done');
  });
});

describe('statementAskDue', () => {
  const statement = { statementDate: '2026-10-28', dueDate: '2026-11-22' };

  it('asks once, the first morning after the close', () => {
    expect(statementAskDue({ ...statement, lastAskedOn: null }, '2026-10-29')).toBe('first');
    expect(statementAskDue({ ...statement, lastAskedOn: '2026-10-29' }, '2026-10-30')).toBe(null);
    expect(statementAskDue({ ...statement, lastAskedOn: '2026-10-29' }, '2026-11-18')).toBe(null);
  });

  it('reminds once, three days before the payment is due, and then stops', () => {
    expect(statementAskDue({ ...statement, lastAskedOn: '2026-10-29' }, '2026-11-19')).toBe('reminder');
    expect(statementAskDue({ ...statement, lastAskedOn: '2026-11-19' }, '2026-11-20')).toBe(null);
    expect(statementAskDue({ ...statement, lastAskedOn: '2026-11-19' }, '2026-12-05')).toBe(null);
  });

  it('a first question already inside those three days is the only one', () => {
    expect(statementAskDue({ statementDate: '2026-10-28', dueDate: '2026-10-30', lastAskedOn: '2026-10-29' }, '2026-10-30')).toBe(null);
  });

  it('with no due date, reminds once ten days after the close', () => {
    const noDue = { statementDate: '2026-10-28', dueDate: null, lastAskedOn: '2026-10-29' };
    expect(statementAskDue(noDue, '2026-11-06')).toBe(null);
    expect(statementAskDue(noDue, '2026-11-07')).toBe('reminder');
  });
});

describe('the answers to "not yet" and "sent"', () => {
  it('no longer promise a question every morning', () => {
    expect(statementNotYetMessage('Bank card')).not.toContain('tomorrow');
    expect(statementSentMessage('Bank card')).not.toContain('tomorrow');
    expect(statementQuestion({ cardName: 'Bank card', statementDate: '2026-09-28', dueDate: '2026-10-22' })).not.toContain('tomorrow');
  });
});
