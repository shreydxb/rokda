import { describe, it, expect } from 'vitest';
import { normalise, fingerprint, compare, FINGERPRINT_VERSION } from './compare-migrations.mjs';

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

  // 762a6c4 recheck (SHR-253): PL/pgSQL bodies are almost always written as
  // dollar-quoted strings ($$...$$), which the tokeniser didn't recognise at
  // all — they fell through to the generic lowercase-everything path.
  it('is case-preserving inside a $$-quoted string', () => {
    expect(normalise('SELECT $$A$$;')).not.toBe(normalise('SELECT $$a$$;'));
  });

  it('is case-preserving inside a tagged dollar-quoted string', () => {
    expect(normalise('SELECT $tag$Hello$tag$;')).not.toBe(normalise('SELECT $tag$hello$tag$;'));
  });

  it('does not treat -- or a single quote inside a dollar-quoted string specially', () => {
    const sql = "SELECT $$it's a -- comment, not really$$;";
    expect(normalise(sql)).toContain("it's a -- comment, not really");
  });

  it('does not confuse two different tags as the same delimiter', () => {
    // $a$...$b$ never closes on $b$ alone — the literal runs until the exact
    // $a$ delimiter repeats, consuming the "$b$...$a$" text as part of it.
    expect(normalise('SELECT $a$one $b$ two$a$;')).toContain('one $b$ two');
  });

  it('still folds case and whitespace outside a dollar-quoted body', () => {
    expect(fingerprint('CREATE FUNCTION f() AS $$ select 1; $$ LANGUAGE sql;')).toBe(
      fingerprint('create   function f() as $$ select 1; $$ language sql;'),
    );
  });

  it('handles an escaped quote inside a literal without losing what follows', () => {
    expect(normalise("select 'it''s fine', 2")).toContain("it''s fine");
  });
});

describe('SHR-253: compare() reports a real difference as drift', () => {
  it('flags literal-only differences as "differs", not "equivalent"', () => {
    const repo = [{ name: 'x', version: '1', fingerprint: fingerprint("select 'A'") }];
    const applied = [{ name: 'x', version: '1', fingerprint: fingerprint("select 'a'"), fingerprintVersion: FINGERPRINT_VERSION }];
    const [row] = compare(repo, applied);
    expect(row.status).toBe('differs');
  });

  it('reports equivalent SQL that only differs in case/whitespace outside literals', () => {
    const repo = [{ name: 'x', version: '1', fingerprint: fingerprint('SELECT 1;') }];
    const applied = [{ name: 'x', version: '1', fingerprint: fingerprint('select   1;'), fingerprintVersion: FINGERPRINT_VERSION }];
    const [row] = compare(repo, applied);
    expect(row.status).toBe('equivalent');
  });
});

// 762a6c4 recheck (SHR-253): docs/applied-migrations.json is a read-only
// export from the live database. Regenerating its fingerprints from the
// repository's own SQL whenever normalise() changes would make the
// comparison trivially "equivalent" no matter what is actually applied — it
// stops being an independent check. An applied entry recorded under an
// older fingerprint version must therefore be reported as unverifiable, not
// silently folded into either "equivalent" or "differs".
describe('SHR-253: an applied fingerprint from an older normalise() is unverifiable, not silently equivalent', () => {
  it('flags a fingerprint with no recorded version as stale, even if the hash happens to match', () => {
    const sql = 'select 1;';
    const repo = [{ name: 'x', version: '1', fingerprint: fingerprint(sql) }];
    const applied = [{ name: 'x', version: '1', fingerprint: fingerprint(sql) }]; // no fingerprintVersion recorded
    const [row] = compare(repo, applied);
    expect(row.status).toBe('stale-fingerprint');
  });

  it('flags a fingerprint recorded under an explicitly older version', () => {
    const repo = [{ name: 'x', version: '1', fingerprint: fingerprint("select 'A'") }];
    const applied = [{ name: 'x', version: '1', fingerprint: fingerprint("select 'A'"), fingerprintVersion: FINGERPRINT_VERSION - 1 }];
    const [row] = compare(repo, applied);
    expect(row.status).toBe('stale-fingerprint');
  });

  it('does not flag a fingerprint recorded under the current version', () => {
    const repo = [{ name: 'x', version: '1', fingerprint: fingerprint('select 1;') }];
    const applied = [{ name: 'x', version: '1', fingerprint: fingerprint('select 1;'), fingerprintVersion: FINGERPRINT_VERSION }];
    const [row] = compare(repo, applied);
    expect(row.status).toBe('equivalent');
  });
});
