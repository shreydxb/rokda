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
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... \
//     node scripts/export-applied-migrations.mjs [output.json]
//
// Default output is docs/applied-migrations.json; pass a path to write
// elsewhere (which is what the release check does).
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

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const out = process.argv[2] ?? 'docs/applied-migrations.json';
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (!projectRef || !accessToken) {
    console.error('export-applied-migrations: SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required.');
    console.error('  The applied side can only be read from the database. Without them there is nothing to export,');
    console.error('  and writing the repository back to itself would make the comparison a tautology.');
    process.exit(1);
  }

  const rows = await fetchLedger({ projectRef, accessToken });
  const snapshot = snapshotFromRows(rows, { projectRef });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`export-applied-migrations: wrote ${snapshot.migrations.length} applied migrations to ${out}`);
  console.log(`  ${snapshot.migrations[0].version} … ${snapshot.migrations.at(-1).version}`);
}
