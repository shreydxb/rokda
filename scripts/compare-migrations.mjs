// QA-12 (SHR-253): compare repository migrations with what is actually applied.
//
// Every local version identifier differed from its applied counterpart even
// though the names matched, and matching names prove nothing about contents.
// This normalises both sides the same way — strip SQL comments, lowercase,
// collapse whitespace — and reports, per migration, whether the SQL is
// equivalent.
//
// The applied side is a JSON file exported read-only from the target database:
//
//   select version, name, array_to_string(statements, E'\n') as sql
//   from supabase_migrations.schema_migrations order by version;
//
// Usage: node scripts/compare-migrations.mjs docs/applied-migrations.json
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';

export function normalise(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(sql) {
  return createHash('md5').update(normalise(sql)).digest('hex');
}

export function repoMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
      const sql = readFileSync(join(dir, file), 'utf8');
      return { file, version, name: rest.join('_'), sql, fingerprint: fingerprint(sql) };
    });
}

// Pairs repository and applied migrations by NAME — the versions are known to
// differ, and name plus order is the only correspondence that survives.
export function compare(repo, applied) {
  const appliedByName = new Map(applied.map((m) => [m.name, m]));
  const rows = repo.map((local) => {
    const remote = appliedByName.get(local.name);
    if (!remote) return { name: local.name, status: 'not-applied', localVersion: local.version };
    const remoteFingerprint = remote.fingerprint ?? fingerprint(remote.sql ?? '');
    return {
      name: local.name,
      status: local.fingerprint === remoteFingerprint ? 'equivalent' : 'differs',
      localVersion: local.version,
      appliedVersion: remote.version,
      versionMatches: local.version === remote.version,
    };
  });
  const appliedOnly = applied
    .filter((m) => !repo.some((l) => l.name === m.name))
    .map((m) => ({ name: m.name, status: 'applied-only', appliedVersion: m.version }));
  return [...rows, ...appliedOnly];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/compare-migrations.mjs <applied-migrations.json>');
    process.exit(2);
  }
  const applied = JSON.parse(readFileSync(path, 'utf8'));
  const rows = compare(repoMigrations(), applied);
  let drift = 0;
  let pending = 0;
  for (const row of rows) {
    // A migration in the repository that is not applied yet is expected, not
    // drift: it is waiting for a deployment decision.
    const isDrift = row.status === 'differs' || row.status === 'applied-only' || (row.appliedVersion && !row.versionMatches);
    if (isDrift) drift++;
    if (row.status === 'not-applied') pending++;
    const flag = isDrift ? 'DRIFT ' : row.status === 'not-applied' ? 'pending' : 'ok    ';
    console.log(
      `${flag.padEnd(8)}${row.name.padEnd(28)} local=${row.localVersion ?? '—'} applied=${row.appliedVersion ?? '—'} ${row.status}`,
    );
  }
  console.log(`\n${rows.length} migrations; ${drift} drifting, ${pending} awaiting deployment.`);
  process.exitCode = drift ? 1 : 0;
}
