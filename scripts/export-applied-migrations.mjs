// Export the migration ledger a database is ACTUALLY running (QA #7).
//
// docs/applied-migrations.json is the applied side of `npm run
// compare:migrations`. It is a file, so it goes stale, and a stale one does
// not fail loudly -- it makes live migrations read as "awaiting deployment".
// That is exactly what happened: the committed snapshot covered 43 of 49
// migrations, six deployed migrations printed as pending, and --strict
// accepted the run.
//
// Two things fix that, and this is the first: refreshing is one command, and
// the file it writes records when and from which project, so the comparison
// can say how old its own evidence is instead of presenting a 2026-09-14
// snapshot as the state of production.
//
// The second is scripts/verify-release.sh, which does not read the committed
// file at all -- it calls this, writes to a temp file, and compares against
// that. A release decision should never rest on a checked-in description of
// production.
//
// Two transports, because the obvious one turned out not to be available here.
// The first real run of this script failed with a 403 from the Management API:
// "Your account does not have the necessary privileges to access this
// endpoint." The same token lists and downloads Edge Functions perfectly well
// -- the database-query endpoints are simply not in what it may do, and that
// is an account-level grant rather than anything this repository controls.
//
// So a direct connection is preferred when one is configured, and it is the
// better transport anyway: it is the same connection string docs/backup-restore.md
// §3 already uses for pg_dump, it returns the migration SQL in full so the
// content fingerprint keeps its meaning, and it does not depend on the
// privileges attached to a platform token.
//
//   SUPABASE_DB_URL=postgresql://... node scripts/export-applied-migrations.mjs [out.json]
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... node scripts/export-applied-migrations.mjs [out.json]
//
// Default output is docs/applied-migrations.json; pass a path to write
// elsewhere (which is what the release check does).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fingerprint, FINGERPRINT_VERSION } from './compare-migrations.mjs';

// How the platform STORED a migration decides how to read it back -- see the
// long note at the top of compare-migrations.mjs. The CLI and dashboard record
// one statement holding the whole file; the GitHub integration splits it into
// statements WITHOUT their terminating semicolons, and rejoining with ';\n'
// puts back precisely what the splitter removed. Appending a terminator
// unconditionally would corrupt the single-statement entries, most of which
// end in a comment rather than a ';'.
export const LEDGER_QUERY = `select version, name,
       case when array_length(statements, 1) > 1
            then array_to_string(statements, E';\\n') || ';'
            else array_to_string(statements, E'\\n')
       end as sql
from supabase_migrations.schema_migrations
order by version`;

// Rows in, snapshot out. Kept separate from the fetch so the shape that
// actually matters -- what gets written, and what the comparison then reads --
// is testable without a network or a token.
export function snapshotFromRows(rows, { projectRef = null, now = new Date() } = {}) {
  const migrations = rows.map((row) => ({
    version: String(row.version),
    name: String(row.name),
    fingerprint: fingerprint(row.sql ?? ''),
    fingerprintVersion: FINGERPRINT_VERSION,
  }));
  return {
    // Provenance first, because the failure this file had was being read as
    // current when it was not.
    exportedAt: now.toISOString(),
    projectRef,
    migrations,
  };
}

// The read-only endpoint runs as supabase_read_only_user and is the right one
// for a check: a verification step should be structurally unable to change the
// thing it is verifying. All references are schema-qualified, as that endpoint
// requires.
export async function fetchLedger({ projectRef, accessToken, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/database/query/read-only`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: LEDGER_QUERY }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase Management API returned ${res.status}: ${text.slice(0, 400)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Supabase Management API did not return JSON: ${text.slice(0, 400)}`);
  }
  // The endpoint returns the rows directly; accept a wrapped shape too rather
  // than failing on a response envelope changing around us.
  const rows = Array.isArray(body) ? body : (body.result ?? body.rows ?? null);
  if (!Array.isArray(rows)) {
    throw new Error(`Could not find rows in the Management API response: ${text.slice(0, 400)}`);
  }
  if (rows.length === 0) {
    // An empty ledger is not a clean bill -- it would make every repository
    // migration read as pending, which is the same false story the stale
    // snapshot told.
    throw new Error('The migration ledger came back empty. Refusing to write a snapshot that says nothing is applied.');
  }
  return rows;
}

// psql rather than a Postgres driver: this repository has no pg dependency, the
// runner and every machine that follows the backup runbook already has psql,
// and adding a driver to ship one read would be the larger change.
//
// -At gives unaligned, tuple-only output and -R/-F set record and field
// separators to control characters, so migration SQL -- which is full of
// newlines, pipes and semicolons -- cannot be confused with the delimiters
// around it. A naive newline/pipe split silently truncates every multi-line
// migration, which is all of them.
const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

export function parsePsqlLedger(raw) {
  return raw
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [version, name, ...sql] = record.split(FIELD_SEP);
      // sql is rejoined rather than taken as [2]: a separator appearing inside
      // the SQL would otherwise truncate it, and truncated SQL fingerprints as
      // drift against a database that is actually correct.
      return { version, name, sql: sql.join(FIELD_SEP) };
    });
}

export function fetchLedgerViaPsql({ dbUrl, exec = execFileSync }) {
  const out = exec(
    'psql',
    [dbUrl, '-At', '-R', RECORD_SEP, '-F', FIELD_SEP, '-v', 'ON_ERROR_STOP=1', '-c', LEDGER_QUERY],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const rows = parsePsqlLedger(out);
  if (rows.length === 0) {
    throw new Error('The migration ledger came back empty. Refusing to write a snapshot that says nothing is applied.');
  }
  return rows;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const out = process.argv[2] ?? 'docs/applied-migrations.json';
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const dbUrl = process.env.SUPABASE_DB_URL;

  if (!dbUrl && !(projectRef && accessToken)) {
    console.error('export-applied-migrations: no way to reach the database.');
    console.error('  Set SUPABASE_DB_URL (preferred — the same connection string docs/backup-restore.md §3 uses),');
    console.error('  or SUPABASE_ACCESS_TOKEN plus SUPABASE_PROJECT_REF for the Management API.');
    console.error('  The applied side can only be read from the database: without one of those there is nothing');
    console.error('  to export, and writing the repository back to itself would make the comparison a tautology.');
    process.exit(1);
  }

  let rows;
  if (dbUrl) {
    console.log('export-applied-migrations: reading the ledger over a direct connection');
    rows = fetchLedgerViaPsql({ dbUrl });
  } else {
    console.log('export-applied-migrations: reading the ledger through the Management API');
    rows = await fetchLedger({ projectRef, accessToken });
  }
  const snapshot = snapshotFromRows(rows, { projectRef: projectRef ?? null });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`export-applied-migrations: wrote ${snapshot.migrations.length} applied migrations to ${out}`);
  console.log(`  ${snapshot.migrations[0].version} … ${snapshot.migrations.at(-1).version}`);
}
