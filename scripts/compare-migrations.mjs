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
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = 'supabase/migrations';

// Tokenises just enough SQL to strip comments and collapse insignificant
// whitespace WITHOUT touching anything inside a string literal ('...') or a
// quoted identifier ("..."). The previous version lowercased and stripped
// comment-like text everywhere, including inside literals — so `select 'A'`
// and `select 'a'` fingerprinted identically, and a `--` inside a string was
// treated as a comment marker. Two migrations can only be equivalent if
// their literals and quoted identifiers match byte-for-byte; only the SQL
// *around* them (keywords, identifiers, whitespace) is case- and
// whitespace-insensitive.
export function normalise(sql) {
  let out = '';
  let i = 0;
  let pendingSpace = false;
  const n = sql.length;
  const flushSpace = () => {
    if (pendingSpace && out !== '') out += ' ';
    pendingSpace = false;
  };
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      // Line comment: skip to (not including) the newline.
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      pendingSpace = true;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      pendingSpace = true;
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      // A literal or quoted identifier: copied verbatim — case, internal
      // whitespace and any `--`/`/*` inside it are all part of its value,
      // not something to normalise away — honouring '' / "" as an escaped
      // quote inside the same literal.
      flushSpace();
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      i += 1;
      continue;
    }
    flushSpace();
    out += ch.toLowerCase();
    i += 1;
  }
  return out.trim();
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

// Entry-point check via URL comparison rather than string splitting: the
// previous version split argv[1] on '/' only, so on Windows (backslash
// paths) it never matched import.meta.url, `npm run compare:migrations`
// silently printed nothing and exited 0 — a mismatch was invisible there.
// pathToFileURL normalises the platform path separator either way.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
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
