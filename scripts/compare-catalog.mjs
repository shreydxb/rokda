// Does production define what this commit's migrations build? (outside
// review, F-02)
//
// The migration comparison proves that production's history names the same
// migrations with the same SQL. It cannot see a function replaced by hand in
// the dashboard, a policy dropped in the SQL editor, or an index added to
// production only: none of those touch the history. This compares the
// definitions themselves, one object at a time, as
// scripts/catalog-fingerprint.sql lists them: kind|name|md5 of the definition.
//
// Only names are printed, never definitions. CI logs for this repository are
// public, and a definition changed by hand could hold anything.
//
//   node scripts/compare-catalog.mjs <fresh-build.txt> <production.txt>
//
// scripts/verify-release.sh produces both files; run that instead.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// kind|name|hash, one object per line, as psql -At -F '|' prints the
// fingerprint query. The name may not contain '|'; the hash never does.
export function parseCatalog(text) {
  const catalog = new Map();
  String(text ?? '')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const first = line.indexOf('|');
      const last = line.lastIndexOf('|');
      if (first <= 0 || last === first || last === line.length - 1) {
        throw new Error(`catalog line ${i + 1} is not kind|name|hash: ${line.slice(0, 80)}`);
      }
      const key = line.slice(0, last);
      if (catalog.has(key)) throw new Error(`catalog lists ${key} twice`);
      catalog.set(key, line.slice(last + 1));
    });
  return catalog;
}

const split = (key) => {
  const at = key.indexOf('|');
  return { kind: key.slice(0, at), name: key.slice(at + 1) };
};

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// missing: built fresh, not on production. extra: on production, built by no
// migration. differing: on both, defined differently.
export function compareCatalogs(built, live) {
  // An empty side means a query that returned nothing, not a database with
  // nothing in it, and comparing against it would report everything or
  // nothing.
  if (built.size === 0) throw new Error('The fresh build listed no objects; its catalog is empty. Refusing to compare.');
  if (live.size === 0) throw new Error("production's catalog came back empty. Refusing to compare.");
  const missing = [];
  const extra = [];
  const differing = [];
  for (const key of [...built.keys()].sort(byKey)) {
    if (!live.has(key)) missing.push(split(key));
    else if (live.get(key) !== built.get(key)) differing.push(split(key));
  }
  for (const key of [...live.keys()].sort(byKey)) {
    if (!built.has(key)) extra.push(split(key));
  }
  return { missing, extra, differing };
}

export function summarize(catalog) {
  const counts = {};
  for (const key of [...catalog.keys()].sort(byKey)) {
    const { kind } = split(key);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const [builtPath, livePath] = process.argv.slice(2);
  if (!builtPath || !livePath) {
    console.error('usage: node scripts/compare-catalog.mjs <fresh-build.txt> <production.txt>');
    process.exit(2);
  }
  let built;
  let live;
  let result;
  try {
    built = parseCatalog(readFileSync(builtPath, 'utf8'));
    live = parseCatalog(readFileSync(livePath, 'utf8'));
    result = compareCatalogs(built, live);
  } catch (error) {
    console.error(`compare-catalog: ${error.message}`);
    process.exit(1);
  }

  const builtCounts = summarize(built);
  const liveCounts = summarize(live);
  const kinds = [...new Set([...Object.keys(builtCounts), ...Object.keys(liveCounts)])].sort(byKey);
  for (const kind of kinds) {
    console.log(`  ${kind.padEnd(13)} ${String(builtCounts[kind] ?? 0).padStart(5)} built  ${String(liveCounts[kind] ?? 0).padStart(5)} on production`);
  }

  const lines = [
    ...result.missing.map((d) => `MISSING    ${d.kind} ${d.name}  (a migration makes it; production does not have it)`),
    ...result.extra.map((d) => `EXTRA      ${d.kind} ${d.name}  (on production; no migration makes it)`),
    ...result.differing.map((d) => `DIFFERENT  ${d.kind} ${d.name}  (defined differently on production)`),
  ];
  if (lines.length === 0) {
    console.log(`\ncompare-catalog: ok — production defines the same ${built.size} objects as a fresh build of this commit`);
    process.exit(0);
  }
  console.log('');
  for (const line of lines) console.log(line);
  console.log(
    `\ncompare-catalog: ${lines.length} object(s) differ. Production was changed outside the migrations, or a migration was applied differently.` +
      ' Write a migration that makes production match, or one that records the change, rather than editing production by hand.',
  );
  process.exit(1);
}
