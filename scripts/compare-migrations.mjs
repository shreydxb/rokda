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
    if (ch === '$') {
      // A dollar-quoted string ($$...$$ or $tag$...$tag$ — PL/pgSQL function
      // bodies are almost always written this way). The previous version had
      // no notion of these at all: normalise('SELECT $$A$$;') and
      // normalise('SELECT $$a$$;') both fell through to the generic
      // lowercase-everything path and compared equal. The opening delimiter
      // is $, an optional tag (letters/digits/underscore), then $; the
      // literal runs verbatim until that exact same delimiter repeats.
      const openMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (openMatch) {
        const delim = openMatch[0];
        const closeAt = sql.indexOf(delim, i + delim.length);
        const end = closeAt === -1 ? n : closeAt + delim.length;
        flushSpace();
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }
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

// Bumped whenever normalise()'s rules change (762a6c4 recheck, SHR-253: added
// dollar-quoted-string awareness; the fix before it added literal/quoted-
// identifier preservation). A fingerprint recorded under an older version is
// not comparable to one computed now — the SQL may not have changed at all,
// only the hashing rules did. `docs/applied-migrations.json` is a read-only
// export from the live database; regenerating ITS fingerprints from the
// repository's own SQL would make the comparison trivially "equivalent"
// regardless of what is actually applied, which defeats the point of the
// check. So that file is never rewritten locally — entries recorded before
// this version are instead reported as unverifiable until someone with
// database access re-exports them (see compare()'s 'stale-fingerprint'
// status below).
export const FINGERPRINT_VERSION = 2;

export function repoMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
      const sql = readFileSync(join(dir, file), 'utf8');
      return { file, version, name: rest.join('_'), sql, fingerprint: fingerprint(sql), fingerprintVersion: FINGERPRINT_VERSION };
    });
}

// Pairs repository and applied migrations by NAME — the versions are known to
// differ, and name plus order is the only correspondence that survives.
export function compare(repo, applied) {
  const appliedByName = new Map(applied.map((m) => [m.name, m]));
  const rows = repo.map((local) => {
    const remote = appliedByName.get(local.name);
    if (!remote) return { name: local.name, status: 'not-applied', localVersion: local.version };
    // An applied entry recorded under an older fingerprint version can't be
    // honestly compared: a "differs" here could mean real drift, or just
    // that the hashing rules changed since it was exported. Neither
    // "equivalent" nor "differs" is true to say, so it gets its own status
    // rather than silently becoming one or the other.
    if ((remote.fingerprintVersion ?? 1) !== FINGERPRINT_VERSION) {
      return {
        name: local.name,
        status: 'stale-fingerprint',
        localVersion: local.version,
        appliedVersion: remote.version,
        versionMatches: local.version === remote.version,
      };
    }
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

// A migration in the repository that is not applied yet is expected, not
// drift: it is waiting for a deployment decision. A stale-fingerprint entry
// is neither proven equivalent nor proven to differ — it was recorded under
// an older, less strict normalise() — so it is never counted as drift by
// itself (including via a version mismatch: without a comparable content
// hash, a version mismatch alone isn't something this can respons­ibly call
// drift either) — it is flagged on its own instead of being folded into
// either a false failure or a false clean bill.
export function isDrift(row) {
  return Boolean(
    row.status === 'differs' || row.status === 'applied-only' || (row.status !== 'stale-fingerprint' && row.appliedVersion && !row.versionMatches),
  );
}

// Entry-point check via URL comparison rather than string splitting: the
// previous version split argv[1] on '/' only, so on Windows (backslash
// paths) it never matched import.meta.url, `npm run compare:migrations`
// silently printed nothing and exited 0 — a mismatch was invisible there.
// pathToFileURL normalises the platform path separator either way.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  // --strict (SHR-253, 81a6bb3 recheck): a green CI run under the default,
  // informational mode does not by itself establish a completed migration
  // comparison if any entry is unverifiable — it only establishes that
  // nothing PROVEN equivalent was found to differ. Release validation needs
  // to be able to insist on more than that: --strict also fails on any
  // stale-fingerprint entry, so a release gate can require every migration
  // to be actually re-verified under the current rules, not just not-yet-
  // contradicted.
  const args = process.argv.slice(2).filter((a) => a !== '--strict');
  const strict = process.argv.includes('--strict');
  const path = args[0];
  if (!path) {
    console.error('usage: node scripts/compare-migrations.mjs <applied-migrations.json> [--strict]');
    process.exit(2);
  }
  const applied = JSON.parse(readFileSync(path, 'utf8'));
  const rows = compare(repoMigrations(), applied);
  let drift = 0;
  let pending = 0;
  let staleFingerprints = 0;
  for (const row of rows) {
    const drifted = isDrift(row);
    if (drifted) drift++;
    if (row.status === 'not-applied') pending++;
    if (row.status === 'stale-fingerprint') staleFingerprints++;
    const flag =
      drifted ? 'DRIFT ' : row.status === 'not-applied' ? 'pending' : row.status === 'stale-fingerprint' ? 'STALE ' : 'ok    ';
    console.log(
      `${flag.padEnd(8)}${row.name.padEnd(28)} local=${row.localVersion ?? '—'} applied=${row.appliedVersion ?? '—'} ${row.status}`,
    );
  }
  console.log(`\n${rows.length} migrations; ${drift} drifting, ${pending} awaiting deployment, ${staleFingerprints} unverifiable (applied fingerprint predates the current normalise() — re-export needed, see docs/migration-reconciliation.md).`);
  if (strict && staleFingerprints > 0) {
    console.log(`\n--strict: failing on ${staleFingerprints} unverifiable entr${staleFingerprints === 1 ? 'y' : 'ies'}.`);
  }
  process.exitCode = drift || (strict && staleFingerprints > 0) ? 1 : 0;
}
