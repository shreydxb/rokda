// `npm run build` exiting 0 is not evidence that the build is usable.
//
// src/lib/supabaseClient.js throws at module top level when VITE_SUPABASE_URL /
// VITE_SUPABASE_PUBLISHABLE_KEY are missing. Vite replaces those at build time,
// so with no environment the condition folds to a constant, the throw becomes
// unconditional, and the bundler eliminates every statement after it — the
// whole application. The build still reports success and emits a ~230 kB
// vendor-only chunk that mounts nothing.
//
// This script asserts the emitted bundle actually contains the application, so
// a green CI build means something.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'dist';
const assets = join(outDir, 'assets');

function fail(message) {
  console.error(`verify-build: ${message}`);
  process.exit(1);
}

let entries;
try {
  entries = readdirSync(assets).filter((f) => f.endsWith('.js'));
} catch {
  fail(`no ${assets} directory — run \`npm run build\` first`);
}

if (entries.length === 0) fail(`no JavaScript emitted into ${assets}`);

const source = entries.map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');

// Markers that only exist if application source survived into the bundle:
// the entry's mount call, and a string from a screen deep in the tree.
const MARKERS = [
  { needle: 'getElementById', what: 'the application entry point (src/main.jsx)' },
  { needle: 'Nothing owed', what: 'application screens (src/screens/**)' },
];

const missing = MARKERS.filter((m) => !source.includes(m.needle));
if (missing.length > 0) {
  for (const m of missing) console.error(`verify-build: bundle is missing ${m.what}`);
  fail('the build emitted no application code. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (see .env.example) and rebuild.');
}

const bytes = entries.reduce((sum, f) => sum + statSync(join(assets, f)).size, 0);
console.log(`verify-build: ok — ${entries.length} chunk(s), ${(bytes / 1024).toFixed(1)} kB, application code present`);
