import { describe, it, expect } from 'vitest';
import { estimatedStatement } from './creditCard';

// QA pass 3, P2. "Spent so far" had its own spend arithmetic instead of
// routing through spendDelta()/isPosted() like Budget and Overview, so the
// card disagreed with every other screen about the same transactions.
//
// Fixtures are the published reproduction: noon on 13 September 2026, a card
// closing on the 10th, so the open cycle runs 10 Sep -> 10 Oct.
const NOW = new Date(2026, 8, 13, 12, 0, 0);
const STATEMENT_DAY = 10;

const tx = (occurred_at, amount, extra = {}) => ({ account_id: 'card', occurred_at, amount, ...extra });
const total = (rows) => estimatedStatement(rows, 'card', STATEMENT_DAY, NOW).amount;

describe('QA pass 3 P2: estimatedStatement', () => {
  it('nets a refund against the charge it refunds', () => {
    // Reported 100 before the fix: Math.max(0, -amount) read the positive
    // refund row as non-spend and contributed zero.
    expect(total([tx('2026-09-11', -100), tx('2026-09-12', 40, { kind: 'refund' })])).toBe(60);
  });

  it('excludes a charge dated in the future', () => {
    // Reported 600 before the fix. The cycle window does not exclude this:
    // 20 September is inside the cycle that closes on 10 October, and still
    // has not happened on the 13th.
    expect(total([tx('2026-09-11', -100), tx('2026-09-12', 40, { kind: 'refund' }), tx('2026-09-20', -500)])).toBe(60);
  });

  it('counts a charge dated today', () => {
    // The boundary the rule above must not overshoot: today is posted.
    expect(total([tx('2026-09-13', -25)])).toBe(25);
  });

  it('reports a net credit rather than clamping it to zero', () => {
    // Refunds exceeding charges is a real credit on the cycle. Clamping would
    // report zero and quietly disagree with the ledger.
    expect(total([tx('2026-09-11', -30), tx('2026-09-12', 50, { kind: 'refund' })])).toBe(-20);
  });

  it('ignores income paid onto the card', () => {
    // A positive row that is NOT a refund is income, and income is not
    // negative spend -- spendDelta returns 0 for it.
    expect(total([tx('2026-09-11', -100), tx('2026-09-12', 500)])).toBe(100);
  });

  it('excludes other accounts and earlier cycles', () => {
    const rows = [
      tx('2026-09-11', -100),
      { account_id: 'other', occurred_at: '2026-09-11', amount: -999 },
      tx('2026-09-09', -777), // closed on the 10th: previous statement
    ];
    expect(total(rows)).toBe(100);
  });

  it('still reports the cycle it measured', () => {
    const est = estimatedStatement([], 'card', STATEMENT_DAY, NOW);
    expect(est.since.getDate()).toBe(10);
    expect(est.since.getMonth()).toBe(8);
    expect(est.closes.getMonth()).toBe(9);
  });

  it('returns null without a statement day', () => {
    expect(estimatedStatement([tx('2026-09-11', -100)], 'card', null, NOW)).toBe(null);
  });
});
