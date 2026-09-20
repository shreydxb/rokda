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
import { dirname, join, normalize, relative } from 'node:path';
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

export const CONFIG_PATH = 'supabase/config.toml';

// What supabase/config.toml declares each function's verify_jwt to be.
//
// This is deliberately read from config.toml rather than from a list kept
// here: that file is what `supabase functions deploy` actually applies, so it
// is the only expectation that cannot drift from the deploy itself. It already
// declares all three functions, and its own header explains why -- deploying
// telegram-webhook with the default verify_jwt = true makes the gateway 401
// every Telegram call before the function runs, and the bot stops working in a
// way that looks like a Telegram problem.
//
// Nothing compared this. Source hashes cannot see it: turning JWT verification
// on for the webhook breaks the bot completely without changing a single byte
// of source, and parity reported in-sync throughout (QA #7).
//
// A deliberately small parser -- this reads one shape, `[functions.<slug>]`
// followed by `verify_jwt = true|false`, and ignores everything else.
export function declaredFunctionConfig(configPath = CONFIG_PATH) {
  if (!existsSync(configPath)) return {};
  const declared = {};
  let slug = null;
  for (const raw of readFileSync(configPath, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const section = line.match(/^\[functions\.([A-Za-z0-9_-]+)\]$/);
    if (section) {
      slug = section[1];
      declared[slug] ??= {};
      continue;
    }
    if (line.startsWith('[')) {
      slug = null;
      continue;
    }
    if (!slug) continue;
    const setting = line.match(/^verify_jwt\s*=\s*(true|false)$/);
    if (setting) declared[slug].verifyJwt = setting[1] === 'true';
  }
  return declared;
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
// Source parity is one of two questions about a deployment. The other is
// whether it is deployed at all, and running as configured -- neither of which
// a source hash can answer (QA #7).
//
//   `declared`       supabase/config.toml, keyed by slug (declaredFunctionConfig)
//   `deployedState`  the platform's own list, keyed by slug: { verifyJwt, status }
//   `requireDeployed` release mode -- a function this repository declares must
//                    actually be live. Off by default, because between merging
//                    a new function and deploying it, not-deployed is a
//                    deployment decision rather than a fault.
//   `branch`         this ref is not the deployed line, so "production is not
//                    running this commit" is not a fault -- it is the whole
//                    point of a branch. See isBlocking() for why the other
//                    states still block here.
export function compare({
  repo,
  deployedManifests,
  deployedSlugs,
  declared = {},
  deployedState = {},
  requireDeployed = false,
  branch = false,
}) {
  const repoBySlug = new Map(repo.map((m) => [m.slug, m]));
  const deployedBySlug = new Map(deployedManifests.map((m) => [m.slug, m]));
  const rows = [];

  // Declared in config.toml, deployed, or both: any of the three makes this a
  // function the release cares about.
  const configFor = (slug) => {
    const want = declared[slug]?.verifyJwt;
    const got = deployedState[slug]?.verifyJwt;
    if (want === undefined) return { configState: 'undeclared', expectedVerifyJwt: null, deployedVerifyJwt: got ?? null };
    if (got === undefined) return { configState: 'unknown', expectedVerifyJwt: want, deployedVerifyJwt: null };
    return { configState: want === got ? 'ok' : 'drift', expectedVerifyJwt: want, deployedVerifyJwt: got };
  };

  for (const slug of [...repoBySlug.keys()].sort()) {
    const local = repoBySlug.get(slug);
    // Required when the repository declares how it should be configured --
    // which is what config.toml is for. A function with source but no
    // declaration is not yet part of the release contract.
    const required = requireDeployed && declared[slug] !== undefined;
    if (!deployedSlugs.includes(slug)) {
      rows.push({ slug, state: 'not-deployed', required, repoDigest: local.digest, configState: 'n/a' });
      continue;
    }
    const live = deployedBySlug.get(slug);
    // A function the platform lists but is not serving is not deployed in any
    // sense that matters; the source could match perfectly.
    const platformStatus = deployedState[slug]?.status ?? null;
    if (!live) {
      rows.push({ slug, state: 'unreadable', required, repoDigest: local.digest, platformStatus, ...configFor(slug) });
      continue;
    }
    rows.push({
      slug,
      state: local.digest === live.digest ? 'in-sync' : 'stale-deployment',
      required,
      // On a branch, a source difference is this branch's proposed change
      // awaiting a deploy it cannot have yet -- reported, not blocking.
      sourceParityAdvisory: branch,
      repoDigest: local.digest,
      deployedDigest: live.digest,
      platformStatus,
      differingFiles: local.digest === live.digest ? [] : differingFiles(local, live),
      ...configFor(slug),
    });
  }

  for (const slug of [...deployedSlugs].sort()) {
    if (!repoBySlug.has(slug)) {
      rows.push({
        slug,
        state: 'orphan-deployment',
        required: false,
        deployedDigest: deployedBySlug.get(slug)?.digest,
        platformStatus: deployedState[slug]?.status ?? null,
        ...configFor(slug),
      });
    }
  }

  return rows;
}

// The platform's own view of each deployed function, keyed by slug. Kept
// beside the manifest walk rather than folded into it: this comes from the
// list endpoint and describes the deployment, not its source.
export function deployedStateFromList(list) {
  const byStatus = {};
  for (const fn of list ?? []) {
    const slug = fn.slug ?? fn.name;
    if (!slug) continue;
    byStatus[slug] = {
      verifyJwt: typeof fn.verify_jwt === 'boolean' ? fn.verify_jwt : undefined,
      status: fn.status ?? null,
    };
  }
  return byStatus;
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
// by default -- a function committed but not yet released is a deployment
// decision, the same way a pending migration is -- but it does under
// `requireDeployed`, which is what makes a release check a release check
// rather than a second pre-merge check (QA #7). unreadable fails too: an
// unproven parity claim is not a passing one, which is the lesson of the
// migration snapshot reading "0 drifting" while covering 32 of 38.
//
// Config drift always blocks, in either mode. It is not a timing question: a
// function deployed with verify_jwt different from what this repository
// declares is misconfigured right now, and in the webhook's case that means
// every Telegram call is being 401ed at the gateway while every source hash
// still matches.
//
// A function the platform is not actively serving blocks for the same reason:
// whatever its source says, it is not answering.
export function isBlocking(row) {
  // Config and platform status come FIRST, because they are statements about
  // production that hold whatever branch is being checked and whatever the
  // source says.
  //
  // They used to come last, after an early return for stale-deployment. On a
  // branch that changed a function's source -- which is every branch that
  // touches one -- that early return fired and these were never reached. A
  // webhook whose gateway rejects every Telegram call with 401, or one the
  // platform has THROTTLED or REMOVED, reported blocking:false as long as the
  // same branch also edited its source. The advisory was meant to excuse one
  // thing, a branch not being deployed yet, and quietly excused two others
  // that have nothing to do with branches.
  if (row.configState === 'drift') return true;
  if (row.platformStatus != null && row.platformStatus !== 'ACTIVE') return true;

  if (row.state === 'orphan-deployment' || row.state === 'unreadable') return true;
  if (row.state === 'not-deployed') return !!row.required;

  // The one state whose meaning depends on which ref is being checked. On main
  // it is the finding this whole check exists for -- telegram-webhook ran an
  // 8 Sep build for five days while main had moved on. On a branch it is
  // unavoidable and says nothing: a branch that changes a function is
  // different from production by construction, and cannot be deployed until it
  // merges, so blocking on it makes every such PR permanently red and the
  // check useless as a merge gate.
  if (row.state === 'stale-deployment') return !row.sourceParityAdvisory;
  return false;
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
  const args = process.argv.slice(2);
  const requireDeployed = args.includes('--require-deployed');
  const branch = args.includes('--branch');
  const [deployedDir, listPath] = args.filter((a) => !a.startsWith('--'));
  if (!deployedDir || !listPath) {
    console.error('usage: node scripts/compare-functions.mjs <deployed-functions-dir> <deployed-list.json> [--require-deployed] [--branch]');
    console.error('  both are produced by scripts/verify-function-parity.sh — run that instead.');
    process.exit(2);
  }

  const deployedList = JSON.parse(readFileSync(listPath, 'utf8'));
  // The deployed slug list comes from the platform, not from what happened to
  // download: a function that failed to unbundle must read as unreadable, not
  // quietly vanish from the comparison.
  const deployedSlugs = deployedList
    .map((fn) => fn.slug ?? fn.name)
    .filter(Boolean)
    .sort();

  const declared = declaredFunctionConfig();
  const deployedState = deployedStateFromList(deployedList);
  const repo = repoFunctionSlugs().map((slug) => manifest(FUNCTIONS_DIR, slug));
  const deployedManifests = deployedSlugs.map((slug) => manifest(deployedDir, slug)).filter(Boolean);

  const rows = compare({ repo, deployedManifests, deployedSlugs, declared, deployedState, requireDeployed, branch });
  const tally = { 'in-sync': 0, 'stale-deployment': 0, 'not-deployed': 0, 'orphan-deployment': 0, unreadable: 0 };
  let configDrift = 0;
  let notActive = 0;

  for (const row of rows) {
    tally[row.state]++;
    const jwt =
      row.configState === 'drift'
        ? ` verify_jwt=${row.deployedVerifyJwt} EXPECTED ${row.expectedVerifyJwt}`
        : row.configState === 'ok'
          ? ` verify_jwt=${row.deployedVerifyJwt}`
          : '';
    const status = row.platformStatus && row.platformStatus !== 'ACTIVE' ? ` status=${row.platformStatus}` : '';
    console.log(
      `${LABELS[row.state]}${row.slug.padEnd(24)} repo=${(row.repoDigest ?? '—').slice(0, 12)} deployed=${(row.deployedDigest ?? '—').slice(0, 12)} ${row.state}${jwt}${status}`,
    );
    if (row.configState === 'drift') configDrift++;
    if (row.platformStatus != null && row.platformStatus !== 'ACTIVE') notActive++;
    for (const file of row.differingFiles ?? []) {
      console.log(`           ${file.file}`);
      console.log(`             repo     ${file.repo.slice(0, 12)}`);
      console.log(`             deployed ${file.deployed.slice(0, 12)}`);
    }
  }

  const blocking = rows.filter(isBlocking).length;
  const requiredMissing = rows.filter((r) => r.state === 'not-deployed' && r.required).length;
  const mode = requireDeployed
    ? ' (release mode: every function config.toml declares must be live)'
    : branch
      ? ' (branch mode: a source difference is this branch awaiting deployment, not production drift)'
      : '';
  console.log(`\n${rows.length} functions${mode}`);
  console.log(`  ${tally['in-sync']} in sync with this commit`);
  console.log(`  ${tally['stale-deployment']} deployed but DIFFERENT from this commit`);
  console.log(`  ${tally['orphan-deployment']} deployed with NO source in this repository`);
  console.log(`  ${tally['not-deployed']} in this repository, not deployed${requiredMissing > 0 ? ` (${requiredMissing} of them REQUIRED)` : ''}`);
  console.log(`  ${tally.unreadable} deployed but unreadable`);
  console.log(`  ${configDrift} with verify_jwt DIFFERENT from supabase/config.toml`);
  console.log(`  ${notActive} deployed but not ACTIVE`);

  if (tally['stale-deployment'] > 0) {
    console.log(
      branch
        ? `\n${tally['stale-deployment']} function(s) above differ from production because this branch changes them. Deploy after merging: supabase functions deploy <slug> --project-ref <ref>`
        : `\nRedeploy the function(s) above: supabase functions deploy <slug> --project-ref <ref>`,
    );
  }
  if (tally['orphan-deployment'] > 0) {
    console.log(`Remove or commit the orphan(s) above: supabase functions delete <slug> --project-ref <ref>`);
  }
  if (configDrift > 0) {
    console.log(`Redeploying applies supabase/config.toml's verify_jwt; deploying with --no-verify-jwt by hand is what drifts it.`);
  }
  if (requiredMissing > 0) {
    console.log(`A function declared in supabase/config.toml is not live. Deploy it, or remove its declaration.`);
  }

  process.exitCode = blocking > 0 ? 1 : 0;
}
