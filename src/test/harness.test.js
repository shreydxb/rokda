import { describe, it, expect } from 'vitest';
import { scopedValue } from '../lib/scope';
import { convertFromAed } from '../lib/currency';
import { buildLabel, buildShortSha } from '../lib/buildInfo';

// The two checks the published QA reproductions already passed at 9bd6a59.
// They are kept as a guard: the fixes in this correction pass must not
// regress ownership splitting or the refusal to invent an FX rate.
describe('QA reproductions that already passed at 9bd6a59', () => {
  it('reconciles Both = Me + Partner for a shared row', () => {
    const row = { is_shared: true };
    expect(scopedValue(100, row, null)).toBe(scopedValue(100, row, 'a') + scopedValue(100, row, 'b'));
  });

  it('reports an unavailable conversion rather than guessing a missing INR rate', () => {
    expect(convertFromAed(100, 'INR', {})).toBeNull();
  });
});

describe('build identity', () => {
  it('exposes a short commit label for the running build', () => {
    expect(buildLabel()).toContain(buildShortSha);
  });
});
