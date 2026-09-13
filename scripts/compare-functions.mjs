// QA re-run (10 Sep): prove the Edge Functions running in production are the
// ones in this repository.
//
// The migration comparison already answers "is the applied schema the
// repository's schema?". Nothing answered the same question for Edge
// Functions, and that is exactly where drift hid: telegram-webhook ran for
// five days as a 8 Sep build while main carried two behaviour changes
// (budgets' alerts_enabled filter, recurring interval_count). CI was green
// the whole time, because CI never looked at what was deployed.
//
// Two halves, and it needs both. Source -> deployment catches production
// lagging main. Deployment -> source catches a function running in production
// with no committed source at all: when this was written, telegram-setup-check
// and deploy-test-scratch were both live and in no commit anywhere, so a check
// that only asked "is main deployed?" would have passed while those ran.
//
// Deliberately live-only: there is no committed snapshot of deployed state.
// A snapshot is the failure mode this whole check exists to catch -- the
// migration snapshot silently covered 32 of 38 migrations and made six live
// migrations read as "awaiting deployment". Deployed state is one API call, so
// it is always fetched fresh (see scripts/verify-function-parity.sh) and there
// is nothing to go stale.
//
// Usage (pure comparison; the shell script does the fetching):
//   node scripts/compare-functions.mjs <deployed-functions-dir> <deployed-list.json>
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FUNCTIONS_DIR = 'supabase/functions';

// Directories under supabase/functions that are shared code, not deployable
// functions. A function is a directory with its own entrypoint; _shared has
// no index.ts and is pulled in by relative import instead.
const NOT_A_FUNCTION = new Set(['_shared']);

// Only relative imports are part of a function's own source. jsr:, npm: and
// https: specifiers are resolved by the Deno runtime at deploy time and are
// not files this repository controls, so they are recorded as edges but never
// followed or hashed.
function relativeSpecifiers(source) {
  const specifiers = [];
  // Matches the specifier of `import ... from '<spec>'`, a bare `import
  // '<spec>'`, and `export ... from '<spec>'`. Dynamic `import('<spec>')` is
  // matched too: a function that lazily imports a shared module still depends
  // on it.
  const patterns = [
    /\bimport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec.startsWith('./') || spec.startsWith('../')) specifiers.push(spec);
    }
  }
  return specifiers;
}

// A function's entrypoint. The repository keeps it at <slug>/index.ts; an
// unbundled deployment can place it at <slug>/source/index.ts (that is the
// layout the platform reports for CLI-deployed functions), so both are
// accepted and the rest of the closure follows the imports from wherever it
// is found.
export function findEntrypoint(functionsRoot, slug) {
  for (const candidate of [join(slug, 'index.ts'), join(slug, 'source', 'index.ts')]) {
    if (existsSync(join(functionsRoot, candidate))) return candidate;
  }
  return null;
}

// Every file a function is actually built from, keyed by path relative to the
// functions root. The SAME walker runs over the repository and over a
// downloaded deployment: because imports are relative, each side resolves its
// own layout, so a deployment that nests the entrypoint one level deeper still
// produces a comparable closure rather than a spurious mismatch.
export function functionClosure(functionsRoot, slug) {
  const entry = findEntrypoint(functionsRoot, slug);
  if (!entry) return null;
  const files = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    const abs = join(functionsRoot, rel);
    if (!existsSync(abs)) {
      // A missing relative import is recorded rather than thrown: it is a real
      // finding about that side (a deployment built from a file the repository
      // no longer has, or vice versa), and reporting it beats crashing.
      files.set(rel, null);
      continue;
    }
    const source = readFileSync(abs, 'utf8');
    files.set(rel, source);
    for (const spec of relativeSpecifiers(source)) {
      queue.push(normalize(join(dirname(rel), spec)));
    }
  }
  return files;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Paths are canonicalised relative to the ENTRYPOINT'S directory, not to the
// functions root. Layout is not behaviour, and the two sides genuinely differ
// in layout: the repository keeps the entrypoint at <slug>/index.ts while the
// platform reports it at <slug>/source/index.ts with _shared nested beside it.
// Keyed from the root, every single path then differs and a two-file drift
// reports as twenty files "absent" on one side or the other -- the real
// finding buried in noise. Keyed from the entrypoint, both sides agree on
// `index.ts` and `../_shared/applib/day.js`, because that is what the import
// statements themselves say, so only genuinely differing files are listed.
export function manifest(functionsRoot, slug) {
  const closure = functionClosure(functionsRoot, slug);
  if (!closure) return null;
  const entryDir = dirname(findEntrypoint(functionsRoot, slug));
  const files = {};
  for (const [rel, content] of closure) {
    // relative() yields '../_shared/...' for a sibling of the entrypoint's
    // directory, matching the specifier the source actually imports.
    const key = relative(entryDir, rel).split('\\').join('/');
    files[key] = content === null ? 'missing' : sha256(content);
  }
  const ordered = Object.keys(files).sort();
  return {
    slug,
    files: Object.fromEntries(ordered.map((key) => [key, files[key]])),
    fileCount: ordered.length,
    digest: sha256(ordered.map((key) => `${key}:${files[key]}`).join('\n')),
  };
}

export function repoFunctionSlugs(functionsRoot = FUNCTIONS_DIR) {
  return readdirSync(functionsRoot)
    .filter((name) => !NOT_A_FUNCTION.has(name))
    .filter((name) => statSync(join(functionsRoot, name)).isDirectory())
    .filter((name) => findEntrypoint(functionsRoot, name) !== null)
    .sort();
}

// The five states a release decision turns on. Named the same way
// compare-migrations.mjs names its own, for the same reason: "not deployed"
// and "deployed but different" are different problems with different fixes,
// and collapsing them is how the 8 Sep build went unnoticed.
//
//   in-sync           deployed source matches this commit. Nothing to do.
//   stale-deployment  deployed, but the source differs -- production is not
//                     running this commit. The blocker case.
//   not-deployed      in the repository, never deployed.
//   orphan-deployment deployed with no source in the repository -- the
//                     deployment -> source half.
//   unreadable        deployed, but its source could not be downloaded, so
//                     parity is unproven rather than proven either way.
export function compare({ repo, deployedManifests, deployedSlugs }) {
  const repoBySlug = new Map(repo.map((m) => [m.slug, m]));
  const deployedBySlug = new Map(deployedManifests.map((m) => [m.slug, m]));
  const rows = [];

  for (const slug of [...repoBySlug.keys()].sort()) {
    const local = repoBySlug.get(slug);
    if (!deployedSlugs.includes(slug)) {
      rows.push({ slug, state: 'not-deployed', repoDigest: local.digest });
      continue;
    }
    const live = deployedBySlug.get(slug);
    if (!live) {
      rows.push({ slug, state: 'unreadable', repoDigest: local.digest });
      continue;
    }
    rows.push({
      slug,
      state: local.digest === live.digest ? 'in-sync' : 'stale-deployment',
      repoDigest: local.digest,
      deployedDigest: live.digest,
      differingFiles: local.digest === live.digest ? [] : differingFiles(local, live),
    });
  }

  for (const slug of [...deployedSlugs].sort()) {
    if (!repoBySlug.has(slug)) rows.push({ slug, state: 'orphan-deployment', deployedDigest: deployedBySlug.get(slug)?.digest });
  }

  return rows;
}

// Which files to point a human at. Both sides are keyed from their own
// entrypoint (see manifest), so the paths line up and only real differences
// are listed.
function differingFiles(local, live) {
  const names = new Set([...Object.keys(local.files), ...Object.keys(live.files)]);
  return [...names]
    .filter((name) => local.files[name] !== live.files[name])
    .sort()
    .map((name) => ({
      file: name,
      repo: local.files[name] ?? 'absent',
      deployed: live.files[name] ?? 'absent',
    }));
}

// stale-deployment and orphan-deployment fail: production is not running this
// commit, or is running something that is in no commit. not-deployed does not
// -- a function committed but not yet released is a deployment decision, the
// same way a pending migration is. unreadable fails too: an unproven parity
// claim is not a passing one, which is the lesson of the migration snapshot
// reading "0 drifting" while covering 32 of 38.
export function isBlocking(row) {
  return row.state === 'stale-deployment' || row.state === 'orphan-deployment' || row.state === 'unreadable';
}

const LABELS = {
  'in-sync': 'ok       ',
  'stale-deployment': 'STALE    ',
  'not-deployed': 'pending  ',
  'orphan-deployment': 'ORPHAN   ',
  unreadable: 'UNKNOWN  ',
};

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const [deployedDir, listPath] = process.argv.slice(2);
  if (!deployedDir || !listPath) {
    console.error('usage: node scripts/compare-functions.mjs <deployed-functions-dir> <deployed-list.json>');
    console.error('  both are produced by scripts/verify-function-parity.sh — run that instead.');
    process.exit(2);
  }

  // The deployed slug list comes from the platform, not from what happened to
  // download: a function that failed to unbundle must read as unreadable, not
  // quietly vanish from the comparison.
  const deployedSlugs = JSON.parse(readFileSync(listPath, 'utf8'))
    .map((fn) => fn.slug ?? fn.name)
    .filter(Boolean)
    .sort();

  const repo = repoFunctionSlugs().map((slug) => manifest(FUNCTIONS_DIR, slug));
  const deployedManifests = deployedSlugs.map((slug) => manifest(deployedDir, slug)).filter(Boolean);

  const rows = compare({ repo, deployedManifests, deployedSlugs });
  const tally = { 'in-sync': 0, 'stale-deployment': 0, 'not-deployed': 0, 'orphan-deployment': 0, unreadable: 0 };

  for (const row of rows) {
    tally[row.state]++;
    console.log(`${LABELS[row.state]}${row.slug.padEnd(24)} repo=${(row.repoDigest ?? '—').slice(0, 12)} deployed=${(row.deployedDigest ?? '—').slice(0, 12)} ${row.state}`);
    for (const file of row.differingFiles ?? []) {
      console.log(`           ${file.file}`);
      console.log(`             repo     ${file.repo.slice(0, 12)}`);
      console.log(`             deployed ${file.deployed.slice(0, 12)}`);
    }
  }

  const blocking = rows.filter(isBlocking).length;
  console.log(`\n${rows.length} functions`);
  console.log(`  ${tally['in-sync']} in sync with this commit`);
  console.log(`  ${tally['stale-deployment']} deployed but DIFFERENT from this commit`);
  console.log(`  ${tally['orphan-deployment']} deployed with NO source in this repository`);
  console.log(`  ${tally['not-deployed']} in this repository, not deployed`);
  console.log(`  ${tally.unreadable} deployed but unreadable`);

  if (tally['stale-deployment'] > 0) {
    console.log(`\nRedeploy the function(s) above: supabase functions deploy <slug> --project-ref <ref>`);
  }
  if (tally['orphan-deployment'] > 0) {
    console.log(`Remove or commit the orphan(s) above: supabase functions delete <slug> --project-ref <ref>`);
  }

  process.exitCode = blocking > 0 ? 1 : 0;
}
