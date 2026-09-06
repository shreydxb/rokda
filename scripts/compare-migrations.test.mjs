import { describe, it, expect } from 'vitest';
import { normalise, fingerprint, compare } from './compare-migrations.mjs';

// SHR-253 (QA-12): normalise() used to lowercase and strip comment-like text
// EVERYWHERE, including inside string literals and quoted identifiers — so
// two migrations that differ only inside a literal fingerprinted as
// identical. That's not "semantically equivalent"; it's a verifier bug that
// could hide real drift. These prove a real difference still fails.
describe('SHR-253: normalise() must not erase meaning inside literals', () => {
  it('is case-preserving inside a string literal', () => {
    expect(normalise("select 'A'")).not.toBe(normalise("select 'a'"));
    expect(fingerprint("select 'A'")).not.toBe(fingerprint("select 'a'"));
  });

  it('is case-preserving inside a quoted identifier', () => {
    expect(normalise('select "Foo"')).not.toBe(normalise('select "foo"'));
  });

  it('does not treat -- inside a string literal as a comment', () => {
    expect(normalise("select '--not a comment'")).toContain('--not a comment');
    expect(fingerprint("select '--not a comment'")).not.toBe(fingerprint("select ''"));
  });

  it('preserves whitespace that is significant inside a literal', () => {
    expect(fingerprint("select 'a  b'")).not.toBe(fingerprint("select 'a b'"));
  });

  it('still ignores case and collapses whitespace OUTSIDE literals', () => {
    expect(normalise('SELECT  1;')).toBe(normalise('select 1;'));
    expect(fingerprint('create table Foo (id int);')).toBe(fingerprint('CREATE   TABLE foo (id int);'));
  });

  it('still strips real comments outside of literals', () => {
    expect(fingerprint('select 1; -- a real comment')).toBe(fingerprint('select 1;'));
    expect(fingerprint('select /* block */ 1;')).toBe(fingerprint('select 1;'));
  });

  it('handles an escaped quote inside a literal without losing what follows', () => {
    expect(normalise("select 'it''s fine', 2")).toContain("it''s fine");
  });
});

describe('SHR-253: compare() reports a real difference as drift', () => {
  it('flags literal-only differences as "differs", not "equivalent"', () => {
    const repo = [{ name: 'x', version: '1', fingerprint: fingerprint("select 'A'") }];
    const applied = [{ name: 'x', version: '1', fingerprint: fingerprint("select 'a'") }];
    const [row] = compare(repo, applied);
    expect(row.status).toBe('differs');
  });

  it('reports equivalent SQL that only differs in case/whitespace outside literals', () => {
    const repo = [{ name: 'x', version: '1', fingerprint: fingerprint('SELECT 1;') }];
    const applied = [{ name: 'x', version: '1', fingerprint: fingerprint('select   1;') }];
    const [row] = compare(repo, applied);
    expect(row.status).toBe('equivalent');
  });
});
