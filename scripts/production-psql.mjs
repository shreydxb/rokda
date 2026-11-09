// psql against production, for the release check (outside review, F-02).
//
// scripts/verify-release.sh reads production's catalog and its scheduled jobs
// over SUPABASE_DB_URL, as the ledger export does. The same care applies: the
// password goes to psql in PGPASSWORD, never in argv, and anything psql prints
// is redacted before it can reach a CI log, which for this repository is
// public. SUPABASE_PROJECT_REF must name the same project, so a recovery
// shell holding the old connection string cannot check the old database and
// report it as the new one.
//
//   node scripts/production-psql.mjs <psql arguments...>
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertSameProject, splitDbUrl } from './export-applied-migrations.mjs';

const redact = (text, secret) => (secret ? String(text ?? '').split(secret).join('***') : String(text ?? ''));

export function runProductionPsql({ dbUrl, projectRef, args, spawn = spawnSync, env = process.env }) {
  if (!dbUrl) {
    throw new Error('SUPABASE_DB_URL is required: production can only be read over it, and without it psql would read whatever local database it finds.');
  }
  assertSameProject({ dbUrl, projectRef });
  const { safeUrl, password } = splitDbUrl(dbUrl);
  const result = spawn('psql', [safeUrl, '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: password ? { ...env, PGPASSWORD: password } : env,
  });
  if (result.error) {
    return { status: 1, stdout: '', stderr: `psql could not run: ${redact(result.error.message, password)}\n` };
  }
  return {
    status: result.status ?? 1,
    stdout: redact(result.stdout, password),
    stderr: redact(result.stderr, password),
  };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  let result;
  try {
    result = runProductionPsql({
      dbUrl: process.env.SUPABASE_DB_URL,
      projectRef: process.env.SUPABASE_PROJECT_REF,
      args: process.argv.slice(2),
    });
  } catch (error) {
    console.error(`production-psql: ${error.message}`);
    process.exit(1);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
}
