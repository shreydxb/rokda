// SHR-304: the deploy check must wait out a deploy that is in flight, and
// nothing else.
//
// On main the Supabase GitHub integration deploys a pushed function at about
// the moment CI starts. The first comparison could read the previous build,
// fail, turn main red and -- because Pages publishes only after CI succeeds --
// leave the GitHub Pages copy a release behind until someone re-ran the job.
// That happened for PR #38 and again for PR #40 on 24 Sep.
//
// These run the real scripts/verify-function-parity.sh end to end. Only its
// two outside dependencies are stood in for: the Management API (curl reads a
// file:// URL) and the Supabase CLI's download (a script that copies this
// repository's functions, "deploying" the previous build for the first N
// downloads). `git` is stood in for so a test can say whether the commit under
// check changed a function, which is the condition that earns a wait.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Vitest runs from the repository root, as the other scripts/ tests assume.
const REPO = process.cwd();
const REF = 'testref';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rokda-parity-e2e-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'api', 'v1', 'projects', REF), { recursive: true });

  // The Supabase CLI's `functions download`: copy the repository's function
  // (and the shared code it imports) into the workdir. While the counter is
  // at or below STALE_DOWNLOADS, telegram-webhook comes out as the previous
  // build -- one extra line -- which is exactly what production looks like
  // while a deploy is still in flight.
  writeFileSync(
    join(dir, 'bin', 'fake-supabase'),
    `#!/usr/bin/env bash
set -euo pipefail
slug="$3"
workdir=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--workdir" ]; then workdir="$2"; fi
  shift
done
dest="$workdir/supabase/functions"
mkdir -p "$dest"
cp -R "${REPO}/supabase/functions/$slug" "$dest/"
cp -R "${REPO}/supabase/functions/_shared" "$dest/" 2>/dev/null || true
if [ "$slug" = "telegram-webhook" ]; then
  n=$(( $(cat "${dir}/downloads" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "${dir}/downloads"
  if [ "$n" -le "\${STALE_DOWNLOADS:-0}" ]; then
    echo "// the previous build" >> "$dest/telegram-webhook/index.ts"
  fi
fi
`,
  );
  chmodSync(join(dir, 'bin', 'fake-supabase'), 0o755);

  // git, as far as the script asks it anything: is there a parent commit, did
  // this commit touch supabase/functions, and what is HEAD called.
  writeFileSync(
    join(dir, 'bin', 'git'),
    `#!/usr/bin/env bash
case "$1 $2" in
  "rev-parse --verify") exit 0 ;;
  "rev-parse --short") echo abc1234 ;;
  "diff --quiet") [ "\${FAKE_COMMIT_CHANGES_FUNCTIONS:-0}" = 1 ] && exit 1 || exit 0 ;;
  "show base:supabase/config.toml") [ -n "\${FAKE_BASE_CONFIG:-}" ] && cat "$FAKE_BASE_CONFIG" || exit 128 ;;
  *) echo "fake git: unexpected $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(join(dir, 'bin', 'git'), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The platform's list, with verify_jwt as supabase/config.toml declares it
// unless a test says otherwise.
function listFunctions(overrides = {}) {
  const fns = [
    { slug: 'fd-accrual', status: 'ACTIVE', verify_jwt: false },
    { slug: 'price-refresh', status: 'ACTIVE', verify_jwt: false },
    { slug: 'telegram-webhook', status: 'ACTIVE', verify_jwt: false, ...overrides },
  ];
  writeFileSync(join(dir, 'api', 'v1', 'projects', REF, 'functions'), JSON.stringify(fns));
}

function run({ staleDownloads = 0, awaitSeconds = 0, commitChangesFunctions = false, baseRef = '', baseConfig = '', args = [] } = {}) {
  return new Promise((done) => {
    execFile(
      'bash',
      ['scripts/verify-function-parity.sh', ...args],
      {
        cwd: REPO,
        env: {
          ...process.env,
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          SUPABASE_ACCESS_TOKEN: 'test-token',
          SUPABASE_PROJECT_REF: REF,
          SUPABASE_CLI: join(dir, 'bin', 'fake-supabase'),
          SUPABASE_API_URL: `file://${join(dir, 'api')}`,
          STALE_DOWNLOADS: String(staleDownloads),
          AWAIT_DEPLOY_SECONDS: String(awaitSeconds),
          AWAIT_DEPLOY_POLL_SECONDS: '0',
          FAKE_COMMIT_CHANGES_FUNCTIONS: commitChangesFunctions ? '1' : '0',
          PARITY_BASE_REF: baseRef,
          FAKE_BASE_CONFIG: baseConfig,
        },
      },
      (error, stdout, stderr) => {
        let downloads = 0;
        try {
          downloads = Number(readFileSync(join(dir, 'downloads'), 'utf8'));
        } catch {
          // never downloaded
        }
        done({ code: error ? error.code : 0, out: stdout + stderr, downloads });
      },
    );
  });
}

describe('SHR-304: waiting for a deploy that is in flight', () => {
  it('passes when production already matches', async () => {
    listFunctions();
    const r = await run({ awaitSeconds: 60, commitChangesFunctions: true });
    expect(r.code).toBe(0);
    expect(r.downloads).toBe(1);
  });

  it('waits for this commit’s deploy to land, then passes', async () => {
    // The 24 Sep failure: the first look sees the previous build.
    listFunctions();
    const r = await run({ staleDownloads: 2, awaitSeconds: 60, commitChangesFunctions: true });
    expect(r.out).toMatch(/deploy is probably in flight/);
    expect(r.code).toBe(0);
    expect(r.downloads).toBe(3);
  });

  it('does not wait unless told to, so a branch or a local run fails at once', async () => {
    listFunctions();
    const r = await run({ staleDownloads: 5, awaitSeconds: 0, commitChangesFunctions: true });
    expect(r.code).toBe(1);
    expect(r.downloads).toBe(1);
  });

  it('does not wait when this commit changed no function: that difference is drift', async () => {
    // The 8 Sep case the check exists for -- production running an old build
    // with nothing on its way to replace it -- must still fail immediately.
    listFunctions();
    const r = await run({ staleDownloads: 5, awaitSeconds: 60, commitChangesFunctions: false });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no deploy is on its way/);
    expect(r.downloads).toBe(1);
  });

  it('fails when the deploy never lands within the wait', async () => {
    listFunctions();
    const r = await run({ staleDownloads: 10_000, awaitSeconds: 1, commitChangesFunctions: true });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/did not land/);
  });

  it('never waits out a failure that waiting cannot fix', async () => {
    // Stale AND verify_jwt drifted: the gateway is rejecting every Telegram
    // call right now, whatever deploy is coming.
    listFunctions({ verify_jwt: true });
    const r = await run({ staleDownloads: 1, awaitSeconds: 60, commitChangesFunctions: true });
    expect(r.code).toBe(1);
    expect(r.downloads).toBe(1);
  });

  it('never waits on a function the platform is not serving', async () => {
    listFunctions({ status: 'THROTTLED' });
    const r = await run({ staleDownloads: 1, awaitSeconds: 60, commitChangesFunctions: true });
    expect(r.code).toBe(1);
    expect(r.downloads).toBe(1);
  });
});

// A commit that turns verify_jwt off for the scheduled functions (the
// scheduler-secret change) differs from production until it deploys. With the
// base's config.toml the check can tell that from drift.
describe('a verify_jwt change this commit makes', () => {
  // Production still runs both scheduled functions with verify_jwt on, as the
  // base declares; this commit's config.toml turns it off.
  function beforeTheDeploy() {
    listFunctions();
    const fns = JSON.parse(readFileSync(join(dir, 'api', 'v1', 'projects', REF, 'functions'), 'utf8'));
    for (const fn of fns) if (fn.slug !== 'telegram-webhook') fn.verify_jwt = true;
    writeFileSync(join(dir, 'api', 'v1', 'projects', REF, 'functions'), JSON.stringify(fns));
    const base = join(dir, 'base-config.toml');
    writeFileSync(
      base,
      ['[functions.telegram-webhook]', 'verify_jwt = false', '[functions.price-refresh]', 'verify_jwt = true', '[functions.fd-accrual]', 'verify_jwt = true'].join('\n'),
    );
    return base;
  }

  it('does not block a branch that makes it', async () => {
    const base = beforeTheDeploy();
    const r = await run({ baseRef: 'base', baseConfig: base, args: ['--branch'] });
    expect(r.out).toMatch(/when this branch merges and deploys/);
    expect(r.code).toBe(0);
  });

  it('is waited for on main, like a source change, and fails if the deploy never applies it', async () => {
    const base = beforeTheDeploy();
    const r = await run({ baseRef: 'base', baseConfig: base, awaitSeconds: 2, commitChangesFunctions: true });
    expect(r.out).toMatch(/deploy is probably in flight/);
    expect(r.out).toMatch(/did not land/);
    expect(r.code).toBe(1);
    expect(r.downloads).toBeGreaterThan(1);
  });

  it('is drift without a base, and fails at once even on a branch', async () => {
    beforeTheDeploy();
    const r = await run({ args: ['--branch'], awaitSeconds: 60, commitChangesFunctions: true });
    expect(r.out).toMatch(/verify_jwt=true EXPECTED false/);
    expect(r.code).toBe(1);
    expect(r.downloads).toBe(1);
  });

  it('is drift when the base cannot be read, and says so', async () => {
    beforeTheDeploy();
    const r = await run({ baseRef: 'base', args: ['--branch'] });
    expect(r.out).toMatch(/could not read supabase\/config.toml at base/);
    expect(r.code).toBe(1);
  });
});
