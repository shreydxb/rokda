import { describe, expect, it } from 'vitest';
import { statementAlreadySettledMessage, statementAnswer, statementAskDue, statementDoneMessage, statementNotYetMessage, statementQuestion, statementReactionDecision, statementSentMessage } from './statementReminder.js';

describe('statementQuestion', () => {
  // The revamp, phase 8c (review T11, decision 5): one line, answered with
  // Checked; it no longer tells anyone to send the PDF elsewhere.
  it('names the card, the close and the due date in one line', () => {
    expect(statementQuestion({ cardName: 'Bank card', statementDate: '2026-09-28', dueDate: '2026-10-22' }, { today: '2026-09-29' })).toBe('Bank card statement closed 28 Sep · due 22 Oct.');
  });

  it('says it is still to check as a reminder, and leaves out a due date it does not know', () => {
    expect(statementQuestion({ cardName: 'Bank card', statementDate: '2026-10-02', dueDate: null }, { reminder: true, today: '2026-10-12' })).toBe('Bank card statement from 2 Oct still to check.');
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
  it('says checked, not reconciled, for a member\'s answer', () => {
    expect(statementDoneMessage('Bank card', '2026-09-28', '2026-10-01')).toBe('✓ Bank card statement · 28 Sep · checked');
  });

  it('says what a statement already settled is, rather than that this answer settled it', () => {
    expect(statementAlreadySettledMessage('Bank card', '2026-09-28', 'mismatch', '2026-10-01')).toBe("Bank card statement · 28 Sep · doesn't match Rokda. Resolve it in Month end.");
    expect(statementAlreadySettledMessage('Bank card', '2026-09-28', 'reconciled', '2026-10-01')).toBe('✓ Bank card statement · 28 Sep · reconciled already');
    expect(statementAlreadySettledMessage('Bank card', '2026-09-28', 'confirmed', '2026-10-01')).toBe('✓ Bank card statement · 28 Sep · checked already');
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
    expect(statementNotYetMessage('Bank card')).toBe('Not yet · Bank card statement · it stays open in Month end');
  });
});
