// The SQL suites' assertions raise unless their condition is false: written
// `if (cond) is not false then raise exception …`. A plain
// `if a <> b then raise exception` does nothing when a is null, so a test
// passed when the value it checked was missing altogether (outside review,
// F-03). This keeps every assertion in that form.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SUITES = ['supabase/test/migration-behaviour.test.sql', 'supabase/test/rls-policies.test.sql'];

// Each `if … then raise exception` whose condition is not null-safe, with
// its line number.
export function unsafeAssertions(sql) {
  const found = [];
  let pos = 0;
  for (const m of sql.matchAll(/\bthen\s+raise\s+exception/gi)) {
    const head = sql.slice(pos, m.index);
    const ifs = [...head.matchAll(/\b(?:els)?if\b/gi)];
    pos = m.index + m[0].length;
    if (!ifs.length) continue;
    const last = ifs[ifs.length - 1];
    const cond = head.slice(last.index + last[0].length).trim();
    if (/^\(.*\)\s+is\s+not\s+false$/s.test(cond) || /^(not\s+)?found$/i.test(cond)) continue;
    found.push(sql.slice(0, m.index).split('\n').length);
  }
  return found;
}

describe('SQL assertions fail when the value they check is missing', () => {
  it('catches a plain comparison, and accepts the null-safe form', () => {
    expect(unsafeAssertions("if n <> 3 then raise exception 'x';")).toEqual([1]);
    expect(unsafeAssertions("if (n <> 3) is not false then raise exception 'x';")).toEqual([]);
    expect(unsafeAssertions("if not found then raise exception 'x';")).toEqual([]);
  });

  for (const suite of SUITES) {
    it(`${suite} uses the null-safe form throughout`, () => {
      expect(unsafeAssertions(readFileSync(suite, 'utf8'))).toEqual([]);
    });
  }
});
