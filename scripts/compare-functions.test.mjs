import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compare,
  declaredFunctionConfig,
  deployedStateFromList,
  functionClosure,
  isBlocking,
  manifest,
  onlyAwaitingDeploy,
  repoFunctionSlugs,
} from './compare-functions.mjs';

// QA re-run (10 Sep): telegram-webhook ran a 8 Sep build for five days while
// main carried two behaviour changes, and CI stayed green because nothing
// compared the repository against what was actually deployed.

let root;

function write(path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rokda-fn-parity-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('function closure: what a function is actually built from', () => {
  it('follows relative imports transitively', () => {
    write('repo/a/index.ts', "import { b } from '../_shared/b.js';");
    write('repo/_shared/b.js', "export * from './c.js';\nexport const b = 1;");
    write('repo/_shared/c.js', 'export const c = 2;');
    const closure = functionClosure(join(root, 'repo'), 'a');
    // functionClosure() keys are native filesystem paths -- it builds them
    // with join()/normalize() -- so a literal '/' here asserts Windows is
    // POSIX and fails there on a correct implementation. manifest() is the
    // canonical surface that normalises to '/', and its assertion below is
    // deliberately left spelling them that way.
    expect([...closure.keys()].sort()).toEqual([join('_shared', 'b.js'), join('_shared', 'c.js'), join('a', 'index.ts')].sort());
  });

  it('does not follow jsr:, npm: or https: specifiers', () => {
    write(
      'repo/a/index.ts',
      ["import 'jsr:@supabase/functions-js/edge-runtime.d.ts';", "import { createClient } from 'jsr:@supabase/supabase-js@2';", "import x from 'npm:left-pad';", "import y from 'https://example.com/y.js';"].join('\n'),
    );
    const closure = functionClosure(join(root, 'repo'), 'a');
    expect([...closure.keys()]).toEqual([join('a', 'index.ts')]);
  });

  it('records a relative import whose file is missing rather than throwing', () => {
    write('repo/a/index.ts', "import { gone } from '../_shared/gone.js';");
    const closure = functionClosure(join(root, 'repo'), 'a');
    expect(closure.get(join('_shared', 'gone.js'))).toBe(null);
    expect(manifest(join(root, 'repo'), 'a').files['../_shared/gone.js']).toBe('missing');
  });

  it('ignores a directory with no entrypoint, so _shared is never a function', () => {
    write('repo/_shared/applib/day.js', 'export const d = 1;');
    write('repo/real/index.ts', 'export default 1;');
    expect(repoFunctionSlugs(join(root, 'repo'))).toEqual(['real']);
  });
});

describe('deployment parity', () => {
  const entry = "import { upcoming } from '../_shared/applib/recurring.js';\nDeno.serve(() => new Response(upcoming()));";
  const shared = 'export function upcoming() { return 1; }';

  function repoSide() {
    write('repo/telegram-webhook/index.ts', entry);
    write('repo/_shared/applib/recurring.js', shared);
  }

  it('reports in-sync when the deployed source matches', () => {
    repoSide();
    write('live/telegram-webhook/index.ts', entry);
    write('live/_shared/applib/recurring.js', shared);
    const [row] = compare({
      repo: [manifest(join(root, 'repo'), 'telegram-webhook')],
      deployedManifests: [manifest(join(root, 'live'), 'telegram-webhook')],
      deployedSlugs: ['telegram-webhook'],
    });
    expect(row.state).toBe('in-sync');
    expect(isBlocking(row)).toBe(false);
  });

  // The platform reports CLI-deployed functions with the entrypoint at
  // source/index.ts and _shared nested beside it. Keyed from the functions
  // root every path would differ and an identical deployment would read as
  // drift; keyed from the entrypoint, both sides agree.
  it('is not fooled by the platform nesting the entrypoint under source/', () => {
    repoSide();
    write('live/telegram-webhook/source/index.ts', entry);
    write('live/telegram-webhook/_shared/applib/recurring.js', shared);
    const [row] = compare({
      repo: [manifest(join(root, 'repo'), 'telegram-webhook')],
      deployedManifests: [manifest(join(root, 'live'), 'telegram-webhook')],
      deployedSlugs: ['telegram-webhook'],
    });
    expect(row.state).toBe('in-sync');
  });

  // The real 10 Sep finding: index.ts lost an .eq("alerts_enabled", true)
  // filter and the shared recurring helper ignored interval_count.
  it('catches a drifted shared module even when the entrypoint matches', () => {
    repoSide();
    write('live/telegram-webhook/source/index.ts', entry);
    write('live/telegram-webhook/_shared/applib/recurring.js', 'export function upcoming() { return 999; }');
    const [row] = compare({
      repo: [manifest(join(root, 'repo'), 'telegram-webhook')],
      deployedManifests: [manifest(join(root, 'live'), 'telegram-webhook')],
      deployedSlugs: ['telegram-webhook'],
    });
    expect(row.state).toBe('stale-deployment');
    expect(isBlocking(row)).toBe(true);
    expect(row.differingFiles.map((f) => f.file)).toEqual(['../_shared/applib/recurring.js']);
  });

  it('names only the files that actually differ', () => {
    repoSide();
    write('live/telegram-webhook/source/index.ts', `${entry}\n// deployed drift`);
    write('live/telegram-webhook/_shared/applib/recurring.js', shared);
    const [row] = compare({
      repo: [manifest(join(root, 'repo'), 'telegram-webhook')],
      deployedManifests: [manifest(join(root, 'live'), 'telegram-webhook')],
      deployedSlugs: ['telegram-webhook'],
    });
    expect(row.differingFiles.map((f) => f.file)).toEqual(['index.ts']);
  });
});

// The half a "is main deployed?" check would miss. When this was written,
// telegram-setup-check and deploy-test-scratch were both live in production
// and present in no commit anywhere.
describe('deployment -> source: functions running with no committed source', () => {
  it('flags a deployed function the repository does not have', () => {
    write('repo/fd-accrual/index.ts', 'export default 1;');
    write('live/fd-accrual/index.ts', 'export default 1;');
    write('live/deploy-test-scratch/index.ts', "Deno.serve(() => new Response('hi'));");
    const rows = compare({
      repo: [manifest(join(root, 'repo'), 'fd-accrual')],
      deployedManifests: ['fd-accrual', 'deploy-test-scratch'].map((s) => manifest(join(root, 'live'), s)),
      deployedSlugs: ['deploy-test-scratch', 'fd-accrual'],
    });
    const orphan = rows.find((r) => r.slug === 'deploy-test-scratch');
    expect(orphan.state).toBe('orphan-deployment');
    expect(isBlocking(orphan)).toBe(true);
  });

  it('does not block on a committed function that is merely not deployed yet', () => {
    write('repo/new-thing/index.ts', 'export default 1;');
    const [row] = compare({
      repo: [manifest(join(root, 'repo'), 'new-thing')],
      deployedManifests: [],
      deployedSlugs: [],
    });
    expect(row.state).toBe('not-deployed');
    expect(isBlocking(row)).toBe(false);
  });

  // A download that failed must not read as "no drift found". The migration
  // snapshot reported "0 drifting" while covering 32 of 38 migrations; an
  // unproven parity claim is not a passing one.
  it('blocks on a deployed function whose source could not be read', () => {
    write('repo/price-refresh/index.ts', 'export default 1;');
    const [row] = compare({
      repo: [manifest(join(root, 'repo'), 'price-refresh')],
      deployedManifests: [],
      deployedSlugs: ['price-refresh'],
    });
    expect(row.state).toBe('unreadable');
    expect(isBlocking(row)).toBe(true);
  });
});

// QA #7: source hashes answer one question about a deployment. These are the
// two they structurally cannot answer -- is it deployed at all, and is it
// running as this repository says it should be.
describe('deployment configuration, which no source hash can see', () => {
  const DECLARED = { 'telegram-webhook': { verifyJwt: false }, 'price-refresh': { verifyJwt: true } };

  function rowsFor(live, { requireDeployed = false, repoSlugs = ['telegram-webhook'] } = {}) {
    const repo = repoSlugs.map((slug) => ({ slug, digest: `d-${slug}`, files: {} }));
    const deployedSlugs = live.map((f) => f.slug).sort();
    const deployedManifests = live.map((f) => ({ slug: f.slug, digest: `d-${f.slug}`, files: {} }));
    return compare({
      repo,
      deployedManifests,
      deployedSlugs,
      declared: DECLARED,
      deployedState: deployedStateFromList(live),
      requireDeployed,
    });
  }

  it('blocks when verify_jwt differs from config.toml, with the source identical', () => {
    // The reported hole exactly: turning JWT verification on for the webhook
    // makes the gateway 401 every Telegram call before the function runs, and
    // not one byte of source changes.
    const [row] = rowsFor([{ slug: 'telegram-webhook', status: 'ACTIVE', verify_jwt: true }]);
    expect(row.state).toBe('in-sync');
    expect(row.configState).toBe('drift');
    expect(row.expectedVerifyJwt).toBe(false);
    expect(isBlocking(row)).toBe(true);
  });

  it('passes when verify_jwt matches', () => {
    const [row] = rowsFor([{ slug: 'telegram-webhook', status: 'ACTIVE', verify_jwt: false }]);
    expect(row.configState).toBe('ok');
    expect(isBlocking(row)).toBe(false);
  });

  it('blocks a function the platform is not actively serving', () => {
    const [row] = rowsFor([{ slug: 'telegram-webhook', status: 'REMOVED', verify_jwt: false }]);
    expect(row.state).toBe('in-sync');
    expect(isBlocking(row)).toBe(true);
  });

  it('reports config as unknown rather than ok when the platform did not say', () => {
    const [row] = rowsFor([{ slug: 'telegram-webhook', status: 'ACTIVE' }]);
    expect(row.configState).toBe('unknown');
    // Unknown is not drift: it is a gap in what the list returned, and the
    // source comparison still stands on its own.
    expect(isBlocking(row)).toBe(false);
  });

  it('leaves a function config.toml says nothing about undeclared', () => {
    const rows = rowsFor([{ slug: 'scratch', status: 'ACTIVE', verify_jwt: true }], { repoSlugs: ['scratch'] });
    expect(rows[0].configState).toBe('undeclared');
    expect(isBlocking(rows[0])).toBe(false);
  });
});

describe('release mode: a declared function must actually be live', () => {
  const DECLARED = { 'telegram-webhook': { verifyJwt: false } };

  function notDeployedRow({ requireDeployed }) {
    return compare({
      repo: [{ slug: 'telegram-webhook', digest: 'd', files: {} }],
      deployedManifests: [],
      deployedSlugs: [],
      declared: DECLARED,
      deployedState: {},
      requireDeployed,
    })[0];
  }

  it('treats a missing deployment as a deployment decision before release', () => {
    // Deleting just the deployed webhook produced a nonblocking not-deployed.
    // That is right between merging a function and deploying it, and wrong as
    // a statement about production.
    const row = notDeployedRow({ requireDeployed: false });
    expect(row.state).toBe('not-deployed');
    expect(isBlocking(row)).toBe(false);
  });

  it('treats the same missing deployment as a failure at release', () => {
    const row = notDeployedRow({ requireDeployed: true });
    expect(row.state).toBe('not-deployed');
    expect(row.required).toBe(true);
    expect(isBlocking(row)).toBe(true);
  });

  it('does not require a function this repository has not declared', () => {
    const row = compare({
      repo: [{ slug: 'scratch', digest: 'd', files: {} }],
      deployedManifests: [],
      deployedSlugs: [],
      declared: DECLARED,
      deployedState: {},
      requireDeployed: true,
    })[0];
    expect(row.required).toBe(false);
    expect(isBlocking(row)).toBe(false);
  });
});

describe('reading verify_jwt out of supabase/config.toml', () => {
  it('reads the real file, so the expectation cannot drift from the deploy', () => {
    // config.toml is what `supabase functions deploy` applies. Keeping a
    // second list in the checker would just be another thing to go stale.
    const declared = declaredFunctionConfig();
    expect(declared['telegram-webhook'].verifyJwt).toBe(false);
    expect(declared['price-refresh'].verifyJwt).toBe(true);
    expect(declared['fd-accrual'].verifyJwt).toBe(true);
  });

  it('ignores comments, other sections, and settings it does not understand', () => {
    write('config.toml', [
      'project_id = "abc"',
      '# [functions.commented-out]',
      '[auth]',
      'verify_jwt = true',
      '[functions.real]',
      'verify_jwt = false  # inline comment',
      'import_map = "./map.json"',
    ].join('\n'));
    expect(declaredFunctionConfig(join(root, 'config.toml'))).toEqual({ real: { verifyJwt: false } });
  });

  it('returns nothing rather than throwing when the file is absent', () => {
    expect(declaredFunctionConfig(join(root, 'nope.toml'))).toEqual({});
  });
});

// A PR that changes an Edge Function is different from production by
// construction, and cannot be deployed until it merges. Blocking on that made
// every such PR permanently red -- which is what happened to the PR carrying
// this very change, and is why the check needs to know which ref it is on.
describe('branch mode: a proposed change is not production drift', () => {
  function staleRow({ branch }) {
    return compare({
      repo: [{ slug: 'telegram-webhook', digest: 'new', files: { 'index.ts': 'a' } }],
      deployedManifests: [{ slug: 'telegram-webhook', digest: 'old', files: { 'index.ts': 'b' } }],
      deployedSlugs: ['telegram-webhook'],
      declared: { 'telegram-webhook': { verifyJwt: false } },
      deployedState: { 'telegram-webhook': { verifyJwt: false, status: 'ACTIVE' } },
      branch,
    })[0];
  }

  it('blocks a stale deployment on the deployed line', () => {
    // The finding this whole check exists for: telegram-webhook ran an 8 Sep
    // build for five days while main had moved on.
    const row = staleRow({ branch: false });
    expect(row.state).toBe('stale-deployment');
    expect(isBlocking(row)).toBe(true);
  });

  it('reports the same difference on a branch without blocking it', () => {
    const row = staleRow({ branch: true });
    expect(row.state).toBe('stale-deployment');
    expect(row.sourceParityAdvisory).toBe(true);
    expect(isBlocking(row)).toBe(false);
  });

  it('still blocks everything a branch cannot excuse', () => {
    const rows = compare({
      repo: [{ slug: 'telegram-webhook', digest: 'd', files: {} }],
      deployedManifests: [
        { slug: 'telegram-webhook', digest: 'd', files: {} },
        { slug: 'scratch', digest: 'x', files: {} },
      ],
      deployedSlugs: ['scratch', 'telegram-webhook'],
      declared: { 'telegram-webhook': { verifyJwt: false } },
      // Config drift and a function running from no commit are statements
      // about production, true whichever ref is being checked.
      deployedState: {
        'telegram-webhook': { verifyJwt: true, status: 'ACTIVE' },
        scratch: { verifyJwt: true, status: 'ACTIVE' },
      },
      branch: true,
    });
    const webhook = rows.find((r) => r.slug === 'telegram-webhook');
    const orphan = rows.find((r) => r.slug === 'scratch');
    expect(webhook.configState).toBe('drift');
    expect(isBlocking(webhook)).toBe(true);
    expect(orphan.state).toBe('orphan-deployment');
    expect(isBlocking(orphan)).toBe(true);
  });

  it('still blocks a function the platform is not serving', () => {
    const row = compare({
      repo: [{ slug: 'telegram-webhook', digest: 'd', files: {} }],
      deployedManifests: [{ slug: 'telegram-webhook', digest: 'd', files: {} }],
      deployedSlugs: ['telegram-webhook'],
      declared: { 'telegram-webhook': { verifyJwt: false } },
      deployedState: { 'telegram-webhook': { verifyJwt: false, status: 'REMOVED' } },
      branch: true,
    })[0];
    expect(isBlocking(row)).toBe(true);
  });
});

// Branch mode makes a source difference advisory, which is right: a branch
// that changes a function is different from production by construction. It
// used to return early on that, so two checks that have nothing to do with
// branches were skipped whenever the same branch also edited the source.
describe('branch mode excuses being undeployed, and nothing else', () => {
  const onABranchThatChangedTheSource = {
    state: 'stale-deployment',
    sourceParityAdvisory: true,
    platformStatus: 'ACTIVE',
    configState: 'match',
  };

  it('does not block on source alone', () => {
    expect(isBlocking(onABranchThatChangedTheSource)).toBe(false);
  });

  it('still blocks when the gateway config has drifted', () => {
    // verify_jwt drift on telegram-webhook means every Telegram call is being
    // 401ed at the gateway right now, however green the source looks.
    expect(isBlocking({ ...onABranchThatChangedTheSource, configState: 'drift' })).toBe(true);
  });

  it('still blocks when the platform is not serving the function', () => {
    for (const platformStatus of ['THROTTLED', 'REMOVED', 'INACTIVE']) {
      expect(isBlocking({ ...onABranchThatChangedTheSource, platformStatus })).toBe(true);
    }
  });

  it('still blocks on an orphan or unreadable deployment', () => {
    expect(isBlocking({ ...onABranchThatChangedTheSource, state: 'orphan-deployment' })).toBe(true);
    expect(isBlocking({ ...onABranchThatChangedTheSource, state: 'unreadable' })).toBe(true);
  });

  it('keeps blocking on stale source when it is not advisory, as on main', () => {
    expect(isBlocking({ ...onABranchThatChangedTheSource, sourceParityAdvisory: false })).toBe(true);
  });
});

// SHR-304: the one failure a deploy in flight can explain, told apart from
// every failure it cannot.
describe('onlyAwaitingDeploy: which failures are worth waiting out', () => {
  const stale = { slug: 'telegram-webhook', state: 'stale-deployment', configState: 'ok', platformStatus: 'ACTIVE' };
  const ok = { slug: 'fd-accrual', state: 'in-sync', configState: 'ok', platformStatus: 'ACTIVE' };

  it('is true when the only thing wrong is deployed source that differs', () => {
    expect(onlyAwaitingDeploy([stale, ok])).toBe(true);
  });

  it('is false when nothing is wrong, so a pass is never reported as a wait', () => {
    expect(onlyAwaitingDeploy([ok])).toBe(false);
  });

  it('is false when the stale function also has verify_jwt drift', () => {
    expect(onlyAwaitingDeploy([{ ...stale, configState: 'drift' }])).toBe(false);
  });

  it('is false when the stale function is not being served', () => {
    expect(onlyAwaitingDeploy([{ ...stale, platformStatus: 'THROTTLED' }])).toBe(false);
  });

  it('is false when anything else blocks alongside the stale function', () => {
    expect(onlyAwaitingDeploy([stale, { slug: 'scratch', state: 'orphan-deployment', configState: 'undeclared' }])).toBe(false);
    expect(onlyAwaitingDeploy([stale, { slug: 'x', state: 'unreadable', configState: 'ok' }])).toBe(false);
    expect(onlyAwaitingDeploy([stale, { slug: 'y', state: 'not-deployed', required: true, configState: 'n/a' }])).toBe(false);
  });

  it('ignores an advisory difference on a branch, which is not blocking at all', () => {
    expect(onlyAwaitingDeploy([{ ...stale, sourceParityAdvisory: true }])).toBe(false);
  });
});
