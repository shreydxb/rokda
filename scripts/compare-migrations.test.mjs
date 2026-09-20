import { describe, it, expect } from 'vitest';
import { normalise, fingerprint, compare, classify, isDrift, FINGERPRINT_VERSION , framingFingerprint} from './compare-migrations.mjs';

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

// 81a6bb3 recheck (SHR-253): a green CI run under the default, informational
// mode doesn't by itself establish a completed comparison if any entry is
// unverifiable. isDrift() is what the CLI uses to decide both the per-row
// DRIFT flag and the overall exit code; --strict additionally fails on any
// stale-fingerprint entry (checked at the process level in the CLI, not
// here, since isDrift() itself never counts staleness as drift).
describe('SHR-253: isDrift() never counts a stale fingerprint as drift, even with a version mismatch', () => {
  it('is drift when the version differs and the content IS comparable', () => {
    // An applied version is assigned at apply time and reconciling a
    // mismatch is a deliberate, tracked step (docs/migration-reconciliation.md)
    // — it stays drift-worthy whenever there's an actual fingerprint to
    // compare against.
    const row = { status: 'equivalent', appliedVersion: '1', localVersion: '2', versionMatches: false };
    expect(isDrift(row)).toBe(true);
  });

  it('is not drift when the fingerprint is stale, even if the version also differs', () => {
    const row = { status: 'stale-fingerprint', appliedVersion: '1', localVersion: '2', versionMatches: false };
    expect(isDrift(row)).toBe(false);
  });

  it('is still drift for a genuine content difference', () => {
    const row = { status: 'differs', appliedVersion: '1', localVersion: '1', versionMatches: true };
    expect(isDrift(row)).toBe(true);
  });

  it('is still drift for an applied-only migration', () => {
    const row = { status: 'applied-only', appliedVersion: '1' };
    expect(isDrift(row)).toBe(true);
  });

  it('is not drift for a migration merely awaiting deployment', () => {
    const row = { status: 'not-applied', localVersion: '1' };
    expect(isDrift(row)).toBe(false);
  });
});

// QA re-run (10 Sep): a migration already live in production was printed as
// "awaiting deployment" because the applied-side export didn't list it. The
// release decision turns on telling those cases apart, so the four states get
// distinct labels — without changing what CI accepts (isDrift is untouched).
describe('QA re-run: classify() separates pending from an applied version mismatch', () => {
  it('calls an applied, equivalent, same-id migration applied-equivalent', () => {
    expect(classify({ status: 'equivalent', appliedVersion: '1', localVersion: '1', versionMatches: true })).toBe(
      'applied-equivalent',
    );
  });

  it('calls an applied, equivalent migration under a different id a version-mismatch, never pending', () => {
    const row = { status: 'equivalent', appliedVersion: '20260909120108', localVersion: '20260909100000', versionMatches: false };
    expect(classify(row)).toBe('version-mismatch');
    expect(classify(row)).not.toBe('pending');
  });

  it('calls a real content difference drift', () => {
    expect(classify({ status: 'differs', appliedVersion: '1', localVersion: '1', versionMatches: true })).toBe('drift');
  });

  it('calls a migration applied but absent from the repository drift', () => {
    expect(classify({ status: 'applied-only', appliedVersion: '1' })).toBe('drift');
  });

  it('calls a repository-only migration pending', () => {
    expect(classify({ status: 'not-applied', localVersion: '1' })).toBe('pending');
  });

  it('calls a stale applied fingerprint unverifiable', () => {
    expect(classify({ status: 'stale-fingerprint', appliedVersion: '1', localVersion: '2', versionMatches: false })).toBe(
      'unverifiable',
    );
  });

  it('agrees with isDrift on every failing state', () => {
    const failing = ['drift', 'version-mismatch'];
    const rows = [
      { status: 'differs', appliedVersion: '1', localVersion: '1', versionMatches: true },
      { status: 'applied-only', appliedVersion: '1' },
      { status: 'equivalent', appliedVersion: '1', localVersion: '2', versionMatches: false },
      { status: 'equivalent', appliedVersion: '1', localVersion: '1', versionMatches: true },
      { status: 'not-applied', localVersion: '1' },
    ];
    for (const row of rows) expect(failing.includes(classify(row))).toBe(isDrift(row));
  });
});

// QA re-run follow-up: the Supabase GitHub integration does not store a
// migration the way the CLI does. It splits the file into statements and drops
// each terminating semicolon -- tenant_qualified_foreign_keys came back as 48
// statements missing exactly 48 semicolons -- so the export has to rejoin them
// with `;` to reconstruct the file. These pin the two properties that makes
// safe: the semicolon genuinely matters to the fingerprint (so putting it back
// is necessary), and the blank lines the splitter discards genuinely do not (so
// putting it back is sufficient).
describe('QA re-run: statements split and rejoined by the platform fingerprint as the original', () => {
  it('is NOT blind to a missing statement terminator -- which is why the export rejoins with one', () => {
    expect(fingerprint('select 1;\nselect 2;')).not.toBe(fingerprint('select 1\nselect 2'));
  });

  it('is blind to the blank lines between statements that the splitter discards', () => {
    const authored = "alter table t add column a int;\n\nalter table t add column b int;\n";
    const rejoined = "alter table t add column a int;\nalter table t add column b int;";
    expect(fingerprint(authored)).toBe(fingerprint(rejoined));
  });

  it('reconstructs a real multi-statement migration exactly, comments and all', () => {
    const authored = [
      '-- a leading comment',
      'create table t (id int);',
      '',
      '-- another comment',
      'alter table t add column b int;',
      '',
    ].join('\n');
    // What the platform stores: statements without terminators, rejoined with ';'.
    const stored = ['-- a leading comment\ncreate table t (id int)', '-- another comment\nalter table t add column b int'];
    const rejoined = `${stored.join(';\n')};`;
    expect(fingerprint(authored)).toBe(fingerprint(rejoined));
  });

  // The semicolons inside a PL/pgSQL body are content, not separators. If the
  // export's rejoin ever leaked into a function body it would corrupt it, and
  // normalise() has to be able to tell the two apart.
  it('keeps semicolons inside a dollar-quoted body as content', () => {
    const body = "create function f() returns int language plpgsql as $$ begin return 1; end; $$;";
    expect(normalise(body)).toContain('begin return 1; end;');
    expect(fingerprint(body)).not.toBe(fingerprint(body.replace('return 1; end;', 'return 1 end')));
  });
});

// The GitHub integration stores a one-statement migration with its terminating
// ';' stripped. The repo file has one. That framing difference fingerprinted
// as drift on a database that was in fact correct -- one real entry,
// 20260914200000_intake_parsed_kind.sql, does exactly this.
describe('a trailing statement terminator is framing, not SQL', () => {
  const stored = 'alter table intake add column parsed_kind text';

  it('agrees on a file ending in ; and the same statement stored without one', () => {
    expect(framingFingerprint(`${stored};`)).toBe(framingFingerprint(stored));
    expect(framingFingerprint(`${stored};\n`)).toBe(framingFingerprint(stored));
  });

  it('leaves the exact fingerprint alone, so existing snapshots stay valid', () => {
    // Changing normalise() itself would have made all 43 committed entries
    // unverifiable and turned the CI check red until a re-export.
    expect(fingerprint(`${stored};`)).not.toBe(fingerprint(stored));
    expect(FINGERPRINT_VERSION).toBe(2);
  });

  it('still distinguishes statements separated by a semicolon', () => {
    // Only the LAST terminator is framing. A separator BETWEEN statements is
    // the difference between one statement and two.
    expect(framingFingerprint('select 1; select 2;')).not.toBe(framingFingerprint('select 1 select 2'));
  });

  it('does not collapse a semicolon inside a literal', () => {
    expect(framingFingerprint("select 'a;'")).not.toBe(framingFingerprint("select 'a'"));
  });

  it('still reports genuinely different SQL as different', () => {
    expect(framingFingerprint('alter table intake add column a text;')).not.toBe(
      framingFingerprint('alter table intake add column b text;'),
    );
  });

  it('accepts a terminator difference only when both sides recorded one', () => {
    const repo = [{ file: 'f.sql', version: '1', name: 'm', sql: `${stored};`, fingerprint: fingerprint(`${stored};`), framingFingerprint: framingFingerprint(`${stored};`), fingerprintVersion: FINGERPRINT_VERSION }];
    const withField = [{ version: '1', name: 'm', fingerprint: fingerprint(stored), framingFingerprint: framingFingerprint(stored), fingerprintVersion: FINGERPRINT_VERSION }];
    const without = [{ version: '1', name: 'm', fingerprint: fingerprint(stored), fingerprintVersion: FINGERPRINT_VERSION }];
    expect(compare(repo, withField)[0].status).toBe('equivalent');
    // An older snapshot has no such field: compared exactly, as before.
    expect(compare(repo, without)[0].status).toBe('differs');
  });
});
