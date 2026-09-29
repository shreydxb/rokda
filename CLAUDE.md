# Working on Rokda

Read `docs/features.md` for what the app does and `docs/decisions.md` for why.
This repository is **public**: no real names, balances, salaries, account
numbers or household figures in code, tests, docs, commits or PR text. Use
generic fixtures ("Partner", "Bank card", round numbers). The household's own
plan lives in the app (Planning → Notes).

## Style

- Plain JavaScript/JSX, single quotes, long lines, no Prettier. Match the
  surrounding comment density: comments explain why, in full sentences.
- Pure logic goes in `src/lib/*.js` with a `*.test.js` beside it. Screens in
  `src/screens/**` get a `*.test.jsx` for behaviour that matters.
- Anything the bot shares with the app lives in both `src/lib/recurring.js`
  and `supabase/functions/_shared/applib/recurring.js`, and must stay
  identical (`scripts/applib-parity.test.mjs`).
- Every product decision gets a short section in `docs/decisions.md`.

## Checks before pushing

```sh
npx eslint src e2e
npx vitest run                                   # unit and screen tests
VITE_SUPABASE_URL=https://e2e.supabase.test VITE_SUPABASE_PUBLISHABLE_KEY=e2e-key npm run build
CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx playwright test
```

Bot changes, from `supabase/functions` (delete `deno.lock` afterwards):

```sh
deno check --node-modules-dir=none telegram-webhook/index.ts
deno test --node-modules-dir=none --allow-env --allow-read --allow-net=api.telegram.org,openrouter.ai,supabase.test telegram-webhook/index.test.ts
```

Database changes need a local Postgres (`pg_ctlcluster 16 main start`,
`PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres`):

```sh
bash scripts/verify-migrations.sh
# then, for each of rokda_behaviour and rokda_rls: create the database, load
# supabase/test/platform-shim.sql and every migration in order, and run
# supabase/test/migration-behaviour.test.sql / rls-policies.test.sql
```

New tables need RLS policies and a case in `rls-policies.test.sql`; new
constraints and triggers need a case in `migration-behaviour.test.sql`.

## Migrations and production

Production is the Supabase project; CI on `main` checks that production's
applied migrations and deployed Edge Functions match the commit.

1. Write `supabase/migrations/<timestamp>_<name>.sql` and its tests; open the PR.
2. Apply to production only when the user says so ("apply and merge"): apply
   the file's contents with the Supabase MCP `apply_migration` under the same
   name.
3. Read the version production assigned
   (`select version, name from supabase_migrations.schema_migrations order by version desc limit 1`),
   `git mv` the file to that version, and append the ledger entry to
   `docs/applied-migrations.json` with `fingerprint`, `framingFingerprint`
   (from `scripts/compare-migrations.mjs`) and `fingerprintVersion: 2`.
4. `npm run compare:migrations -- --strict` must pass. Push, wait for green
   CI, merge (squash).
5. Edge Functions deploy from `main` through the Supabase GitHub integration;
   the Pages deploy follows CI. Check both after a merge.

## Git

- Work on the branch the session names. After a merge, wait until CI has
  started on `main` for the merge commit, then reset the branch to
  `origin/main` and force-push with lease. Pushing the same commit to the
  branch first can leave `main` with no CI run, so no Pages deploy.
- The user reviews and asks for merges; do not merge without being asked.
- Commit messages: a short subject, then what changed and why.
