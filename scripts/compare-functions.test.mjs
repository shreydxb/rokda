import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compare, functionClosure, isBlocking, manifest, repoFunctionSlugs } from './compare-functions.mjs';

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
    expect([...closure.keys()].sort()).toEqual(['_shared/b.js', '_shared/c.js', 'a/index.ts']);
  });

  it('does not follow jsr:, npm: or https: specifiers', () => {
    write(
      'repo/a/index.ts',
      ["import 'jsr:@supabase/functions-js/edge-runtime.d.ts';", "import { createClient } from 'jsr:@supabase/supabase-js@2';", "import x from 'npm:left-pad';", "import y from 'https://example.com/y.js';"].join('\n'),
    );
    const closure = functionClosure(join(root, 'repo'), 'a');
    expect([...closure.keys()]).toEqual(['a/index.ts']);
  });

  it('records a relative import whose file is missing rather than throwing', () => {
    write('repo/a/index.ts', "import { gone } from '../_shared/gone.js';");
    const closure = functionClosure(join(root, 'repo'), 'a');
    expect(closure.get('_shared/gone.js')).toBe(null);
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
