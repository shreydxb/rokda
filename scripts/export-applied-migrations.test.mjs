import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSameProject, fetchLedger, fetchLedgerViaPsql, LEDGER_QUERY, parsePsqlLedger, projectRefFromDbUrl, snapshotFromRows } from './export-applied-migrations.mjs';
import { classify, compare, fingerprint, FINGERPRINT_VERSION } from './compare-migrations.mjs';

// QA #7: the committed snapshot covered 43 of 49 migrations, so six deployed
// migrations printed as "awaiting deployment" and --strict accepted the run.
// Refreshing it has to be one command, and what that command writes has to
// say how old it is.

function repoRows() {
  return readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
      return { version, name: rest.join('_'), sql: readFileSync(join('supabase/migrations', file), 'utf8') };
    });
}

describe('what an export writes', () => {
  it('records when it was taken and which project it came from', () => {
    // The whole failure was a file being read as current when it was not.
    const snapshot = snapshotFromRows([{ version: '20260101000000', name: 'x', sql: 'select 1;' }], {
      projectRef: 'abcdef',
      now: new Date('2026-09-20T10:00:00Z'),
    });
    expect(snapshot.exportedAt).toBe('2026-09-20T10:00:00.000Z');
    expect(snapshot.projectRef).toBe('abcdef');
  });

  it('fingerprints under the current normalise(), not an older one', () => {
    const snapshot = snapshotFromRows([{ version: '20260101000000', name: 'x', sql: 'select 1; -- trailing' }]);
    expect(snapshot.migrations[0].fingerprintVersion).toBe(FINGERPRINT_VERSION);
    expect(snapshot.migrations[0].fingerprint).toBe(fingerprint('select 1; -- trailing'));
  });

  it('round-trips: an export of exactly this repository compares as fully applied', () => {
    // The end-to-end shape check. If the comparison could not read what the
    // exporter writes, the release gate would report drift on a database that
    // matches perfectly -- a failure mode as bad as the one being fixed.
    const snapshot = snapshotFromRows(repoRows(), { projectRef: 'test' });
    const rows = compare(
      repoRows().map((r) => ({
        file: `${r.version}_${r.name}.sql`,
        version: r.version,
        name: r.name,
        sql: r.sql,
        fingerprint: fingerprint(r.sql),
        fingerprintVersion: FINGERPRINT_VERSION,
      })),
      snapshot.migrations,
    );
    const states = rows.map(classify);
    expect(states.every((s) => s === 'applied-equivalent')).toBe(true);
    expect(states).not.toContain('pending');
  });
});

describe('fetching the ledger', () => {
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

  it('asks the read-only endpoint, so a verification step cannot change what it verifies', async () => {
    let seen = null;
    await fetchLedger({
      projectRef: 'abcdef',
      accessToken: 't',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return ok([{ version: '1', name: 'a', sql: 'select 1' }]);
      },
    });
    expect(seen.url).toBe('https://api.supabase.com/v1/projects/abcdef/database/query/read-only');
    expect(seen.init.headers.Authorization).toBe('Bearer t');
    expect(JSON.parse(seen.init.body).query).toBe(LEDGER_QUERY);
  });

  it('reads rows whether or not they arrive wrapped in an envelope', async () => {
    const row = { version: '1', name: 'a', sql: 'select 1' };
    for (const body of [[row], { result: [row] }, { rows: [row] }]) {
      const rows = await fetchLedger({ projectRef: 'r', accessToken: 't', fetchImpl: async () => ok(body) });
      expect(rows).toEqual([row]);
    }
  });

  it('refuses an empty ledger rather than writing "nothing is applied"', async () => {
    // Writing that file would make every repository migration read as
    // pending -- the same false story the stale snapshot told, with a fresh
    // timestamp on it.
    await expect(fetchLedger({ projectRef: 'r', accessToken: 't', fetchImpl: async () => ok([]) })).rejects.toThrow(/empty/i);
  });

  it('fails loudly on an error response instead of writing a partial snapshot', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => '{"message":"Unauthorized"}' });
    await expect(fetchLedger({ projectRef: 'r', accessToken: 'bad', fetchImpl })).rejects.toThrow(/401/);
  });

  it('fails loudly when the response is not JSON at all', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>gateway</html>' });
    await expect(fetchLedger({ projectRef: 'r', accessToken: 't', fetchImpl })).rejects.toThrow(/did not return JSON/);
  });
});

// The Management API transport turned out not to be usable on this project:
// the first real run returned 403, "your account does not have the necessary
// privileges to access this endpoint", from a token that lists and downloads
// Edge Functions perfectly well. A direct connection is both the available
// transport and the better one -- it returns the SQL in full, so the content
// fingerprint keeps meaning something.
describe('reading the ledger over a direct connection', () => {
  const RS = '\x1e';
  const FS = '\x1f';

  it('keeps multi-line SQL whole', () => {
    // Every migration in this repository is multi-line and full of newlines,
    // semicolons and pipes. A newline-or-pipe split truncates all of them, and
    // truncated SQL fingerprints as drift against a database that is correct.
    const sql = 'create table x (\n  a int -- note\n);\nselect 1 | 2;';
    const rows = parsePsqlLedger(`20260101000000${FS}first${FS}${sql}${RS}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ version: '20260101000000', name: 'first', sql });
  });

  it('reads several migrations', () => {
    const raw = [`1${FS}a${FS}select 1;`, `2${FS}b${FS}select 2;`].join(RS) + RS;
    expect(parsePsqlLedger(raw).map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('does not truncate SQL that contains a separator byte', () => {
    // Paranoia, but the failure it prevents is silent.
    const sql = `select '${FS}';`;
    expect(parsePsqlLedger(`1${FS}a${FS}${sql}${RS}`)[0].sql).toBe(sql);
  });

  it('ignores the trailing empty record psql leaves behind', () => {
    expect(parsePsqlLedger(`1${FS}a${FS}select 1;${RS}`)).toHaveLength(1);
    expect(parsePsqlLedger('')).toEqual([]);
  });

  it('asks psql for control-character delimiters and stops on error', () => {
    let seen = null;
    fetchLedgerViaPsql({
      dbUrl: 'postgresql://example',
      exec: (bin, args) => {
        seen = { bin, args };
        return `1${FS}a${FS}select 1;${RS}`;
      },
    });
    expect(seen.bin).toBe('psql');
    expect(seen.args).toContain('-At');
    expect(seen.args).toContain('ON_ERROR_STOP=1');
    expect(seen.args).toContain(LEDGER_QUERY);
    expect(seen.args[0]).toBe('postgresql://example');
  });

  it('refuses an empty ledger, same as the API transport', () => {
    expect(() => fetchLedgerViaPsql({ dbUrl: 'x', exec: () => '' })).toThrow(/empty/i);
  });
});

// A recovery shell that still has the old SUPABASE_DB_URL exported, with only
// SUPABASE_PROJECT_REF changed, used to read the OLD ledger and write it into
// a snapshot labelled with the NEW project -- a recovery verifying itself
// against the database it was replacing.
describe('reading one project and labelling it another', () => {
  const OLD = 'postgresql://postgres:pw@db.aaaaaaaaaaaaaaaa.supabase.co:5432/postgres';
  const POOLER = 'postgresql://postgres.bbbbbbbbbbbbbbbb:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';

  it('reads the project ref out of a direct connection string', () => {
    expect(projectRefFromDbUrl(OLD)).toBe('aaaaaaaaaaaaaaaa');
  });

  it('reads it out of a pooler connection string, where it lives in the username', () => {
    expect(projectRefFromDbUrl(POOLER)).toBe('bbbbbbbbbbbbbbbb');
  });

  it('says nothing about a database it cannot identify', () => {
    expect(projectRefFromDbUrl('postgresql://postgres:pw@localhost:5432/postgres')).toBeNull();
    expect(projectRefFromDbUrl('not a url')).toBeNull();
  });

  it('refuses when the connection and the declared project disagree', () => {
    expect(() => assertSameProject({ dbUrl: OLD, projectRef: 'bbbbbbbbbbbbbbbb' }))
      .toThrow(/points at project aaaaaaaaaaaaaaaa but SUPABASE_PROJECT_REF is bbbbbbbbbbbbbbbb/);
  });

  it('allows them when they agree, and when there is nothing to compare', () => {
    expect(() => assertSameProject({ dbUrl: OLD, projectRef: 'aaaaaaaaaaaaaaaa' })).not.toThrow();
    expect(() => assertSameProject({ dbUrl: OLD, projectRef: null })).not.toThrow();
    expect(() => assertSameProject({ dbUrl: 'postgresql://postgres:pw@localhost/postgres', projectRef: 'x' })).not.toThrow();
  });
});

describe('the database password stays out of argv and out of errors', () => {
  const SECRET = 'synthetic-not-a-real-password';
  const URL_WITH_SECRET = `postgresql://postgres:${SECRET}@db.aaaaaaaaaaaaaaaa.supabase.co:5432/postgres`;

  it('passes psql a connection string with no password in it', () => {
    let seenArgs = null;
    let seenEnv = null;
    fetchLedgerViaPsql({
      dbUrl: URL_WITH_SECRET,
      env: {},
      exec: (_cmd, args, opts) => {
        seenArgs = args;
        seenEnv = opts.env;
        return `1\u001f2\u001fselect 1;`.replace(/1\u001f2/, '20260101000000\u001finit');
      },
    });
    expect(seenArgs.join(' ')).not.toContain(SECRET);
    // libpq reads it from the environment, which is not echoed in errors.
    expect(seenEnv.PGPASSWORD).toBe(SECRET);
  });

  it('keeps the password out of a failure, message and stack alike', () => {
    // The real execFileSync failure repeats argv, stdout and stderr. This
    // stands in for one that quotes the connection string back.
    const boom = () => {
      throw new Error(`Command failed: psql ${URL_WITH_SECRET} -c '...'`);
    };
    let thrown;
    try {
      fetchLedgerViaPsql({ dbUrl: URL_WITH_SECRET, env: {}, exec: boom });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).not.toContain(SECRET);
    expect(thrown.message).toContain('***');
    expect(String(thrown.stack)).not.toContain(SECRET);
  });
});
