// QA-12 (SHR-253): compare repository migrations with what is actually applied.
//
// Every local version identifier differed from its applied counterpart even
// though the names matched, and matching names prove nothing about contents.
// This normalises both sides the same way — strip SQL comments, lowercase,
// collapse whitespace — and reports, per migration, whether the SQL is
// equivalent.
//
// The applied side is a JSON file exported read-only from the target database.
// How the platform STORED a migration decides how to read it back:
//
//   select version, name,
//          case when array_length(statements, 1) > 1
//               then array_to_string(statements, E';\n') || ';'
//               else array_to_string(statements, E'\n')
//          end as sql
//   from supabase_migrations.schema_migrations order by version;
//
// The CLI and dashboard record a migration as ONE statement holding the whole
// file, terminators and all -- that is the `else` branch, and it is what the
// first 38 entries here were exported with. The GitHub integration instead
// splits the file into statements and stores them as an array WITHOUT their
// terminating semicolons: `tenant_qualified_foreign_keys` came back as 48
// statements missing exactly 48 semicolons. Joining that with a plain newline
// produces SQL that differs from the repository file by those 48 characters, so
// every migration deployed through the integration would fingerprint as drift.
// Rejoining with the semicolon puts back precisely what the splitter removed.
//
// The branch matters: appending a terminator unconditionally would CHANGE 27 of
// the 38 single-statement entries, because those files end with a trailing
// comment rather than with `;`.
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

// The same fingerprint with a single trailing statement terminator ignored.
//
// The GitHub integration stores a one-statement migration with its final ';'
// stripped, so a repository file ending in ';' fingerprints as drift against a
// database holding exactly the same statement. One real entry does this today
// (20260914200000_intake_parsed_kind.sql), and calling a correct database
// "drifting" is the kind of false alarm that teaches people to ignore the
// check.
//
// It is a SECOND value rather than a change to normalise() because the
// committed snapshot stores fingerprints, not SQL: changing the hashing rules
// would make all 43 existing entries unverifiable and turn the CI check red
// until someone with database access re-exports them. Only the very last
// terminator is trimmed, so a separator BETWEEN statements still counts --
// `a; b` and `a b` remain different.
export function framingFingerprint(sql) {
  return createHash('md5').update(normalise(sql).replace(/\s*;$/, '')).digest('hex');
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
      return {
        file,
        version,
        name: rest.join('_'),
        sql,
        fingerprint: fingerprint(sql),
        framingFingerprint: framingFingerprint(sql),
        fingerprintVersion: FINGERPRINT_VERSION,
      };
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
    // Exact first. Only if that differs is the framing-insensitive pair
    // consulted, and only when the applied side actually recorded one -- an
    // older snapshot has no such field and is compared exactly, as before.
    const agrees =
      local.fingerprint === remoteFingerprint ||
      (remote.framingFingerprint != null && local.framingFingerprint === remote.framingFingerprint);
    return {
      name: local.name,
      status: agrees ? 'equivalent' : 'differs',
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

// QA re-run (10 Sep): "pending" was doing too much work. A migration already
// applied to production, but recorded there under a different version id than
// its repository filename, paired correctly by name — yet if the applied-side
// export simply didn't list it, it fell to 'not-applied' and printed as
// "awaiting deployment". A production-deployed migration reading as pending in
// release CI is the one thing this report must never say, so the four states a
// release decision actually turns on are named separately:
//
//   applied-equivalent — applied, same content, same version id. Nothing to do.
//   version-mismatch   — applied and content-equivalent, but the ids disagree.
//                        Not a content risk; still a release-blocking identity
//                        problem, and reconciled deliberately (see
//                        docs/migration-reconciliation.md).
//   drift              — content actually differs, or production has a
//                        migration the repository doesn't.
//   pending            — in the repository, not applied anywhere. Expected;
//                        waiting on a deployment decision.
//   unverifiable       — applied fingerprint predates the current normalise().
//
// isDrift() keeps its exact meaning: version-mismatch and drift both fail, so
// splitting the label changes what the report SAYS, never what CI accepts.
export function classify(row) {
  if (row.status === 'stale-fingerprint') return 'unverifiable';
  if (row.status === 'differs' || row.status === 'applied-only') return 'drift';
  if (row.status === 'not-applied') return 'pending';
  return row.versionMatches ? 'applied-equivalent' : 'version-mismatch';
}

const LABELS = {
  'applied-equivalent': 'ok      ',
  'version-mismatch': 'VERSION ',
  drift: 'DRIFT   ',
  pending: 'pending ',
  unverifiable: 'STALE   ',
};

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
  //
  // --require-applied (QA #7) is the other half, and the one that makes this a
  // release check rather than a second pre-merge check. `pending` means "in
  // the repository, not applied", which before a deploy is a correct and
  // expected answer -- so the default mode prints it and passes. After a
  // deploy it means production is missing a migration this commit says it
  // should have, and the whole comparison is then describing a schema nobody
  // is running.
  //
  // This is also what stopped the committed snapshot's staleness from
  // mattering in the way it did: six migrations that were live read as
  // "awaiting deployment" purely because the snapshot predated them, and
  // --strict accepted it. Under --require-applied that run fails, and
  // verify-release.sh does not use the committed snapshot at all -- it exports
  // live state fresh, the same way the function check already does.
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const strict = flags.has('--strict');
  const requireApplied = flags.has('--require-applied');
  const path = args[0];
  if (!path) {
    console.error('usage: node scripts/compare-migrations.mjs <applied-migrations.json> [--strict] [--require-applied]');
    process.exit(2);
  }
  const appliedFile = JSON.parse(readFileSync(path, 'utf8'));
  // An export may be a bare array (the original shape) or an object carrying
  // provenance alongside it. Both are read; only the second can say when it
  // was taken, which is the difference between a stale snapshot you can see
  // and one you cannot.
  const applied = Array.isArray(appliedFile) ? appliedFile : (appliedFile.migrations ?? []);
  const exportedAt = Array.isArray(appliedFile) ? null : (appliedFile.exportedAt ?? null);
  const exportedFrom = Array.isArray(appliedFile) ? null : (appliedFile.projectRef ?? null);
  const rows = compare(repoMigrations(), applied);
  const tally = { 'applied-equivalent': 0, 'version-mismatch': 0, drift: 0, pending: 0, unverifiable: 0 };
  for (const row of rows) {
    const state = classify(row);
    tally[state]++;
    console.log(
      `${LABELS[state]}${row.name.padEnd(30)} local=${row.localVersion ?? '—'} applied=${row.appliedVersion ?? '—'} ${state}`,
    );
  }

  // Each state is named on its own line rather than folded into one sentence:
  // the previous summary put "N unverifiable" next to a parenthetical about
  // re-exporting that printed unconditionally, so a run with zero stale
  // entries still advised a re-export — which is how a clean comparison came
  // to be read as a stale one.
  const failing = tally.drift + tally['version-mismatch'];
  console.log(`\n${rows.length} migrations`);
  console.log(`  ${tally['applied-equivalent']} applied, equivalent, same version id`);
  console.log(`  ${tally['version-mismatch']} applied and equivalent but under a DIFFERENT version id`);
  console.log(`  ${tally.drift} drifting (content differs, or applied but absent from the repository)`);
  console.log(`  ${tally.pending} awaiting deployment (in the repository, not applied)`);
  console.log(`  ${tally.unverifiable} unverifiable`);
  // Always printed, because "which database is this, and how long ago" is the
  // question a comparison against a file cannot answer for itself.
  console.log(
    exportedAt
      ? `  applied side: exported ${exportedAt}${exportedFrom ? ` from ${exportedFrom}` : ''}`
      : `  applied side: ${path} (no export date recorded — run npm run export:migrations to refresh it)`,
  );
  if (tally['version-mismatch'] > 0) {
    console.log(`\nReconcile the version ids above — see docs/migration-reconciliation.md.`);
  }
  if (tally.unverifiable > 0) {
    console.log(`\n${tally.unverifiable} applied fingerprint(s) predate the current normalise(); a re-export is needed to verify them — see docs/migration-reconciliation.md.`);
  }
  if (strict && tally.unverifiable > 0) {
    console.log(`--strict: failing on ${tally.unverifiable} unverifiable entr${tally.unverifiable === 1 ? 'y' : 'ies'}.`);
  }
  if (requireApplied && tally.pending > 0) {
    console.log(
      `--require-applied: failing on ${tally.pending} migration(s) this commit has and the database does not.` +
        ` Deploy them, or run this without --require-applied if you are checking before a deploy rather than after one.`,
    );
  }
  process.exitCode =
    failing || (strict && tally.unverifiable > 0) || (requireApplied && tally.pending > 0) ? 1 : 0;
}
