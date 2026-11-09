#!/usr/bin/env bash
# The release gate: does production actually match this commit, right now?
# (QA #7)
#
# Everything else in CI answers a question about the repository -- do the tests
# pass, does a fresh database build, does the committed snapshot agree with the
# committed migrations. None of that can say what is running in production, and
# the two checks that could were each one step short:
#
#   * The migration comparison read a checked-in file. That file covered 43 of
#     49 migrations, so six migrations that were LIVE printed as "awaiting
#     deployment" and --strict accepted the run.
#   * The function comparison fetched live state correctly, but treated a
#     missing deployment as nonblocking and never looked at verify_jwt -- so
#     deleting the deployed webhook, or turning JWT verification on for it
#     (which 401s every Telegram call before the function runs), both passed.
#
# This runs after a deploy and insists on the whole thing: every migration this
# commit has is applied, every function config.toml declares is live, serving,
# running this commit's source, and configured the way this commit says.
#
# Two more since the outside review (F-02). A matching migration history
# proves the right scripts ran, not that production still defines what they
# made: a function replaced in the dashboard keeps its history row. So
# production's live catalog -- every function, column, constraint, index,
# policy, trigger and view -- is compared with one built fresh from this
# commit, which needs a local Postgres with the pg_cron/pg_net stubs (CI's
# scripts/ci-postgres.sh). And the scheduled jobs are checked against this
# project, as the recovery runbook does by hand.
#
# The applied side is exported fresh every run into a temp file. It
# deliberately does NOT read docs/applied-migrations.json -- a release decision
# should not rest on a checked-in description of production, which is the
# failure this exists to prevent.
#
#   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... SUPABASE_DB_URL=... \
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres scripts/verify-release.sh
set -euo pipefail

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || [ -z "${SUPABASE_PROJECT_REF:-}" ] || [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "verify-release: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and SUPABASE_DB_URL are required." >&2
  echo "  Production state cannot be read without them, and an unverified release claim" >&2
  echo "  is not a passing one -- so this fails rather than skipping." >&2
  exit 1
fi
if ! psql -d "${PGDATABASE:-postgres}" -q -c 'select 1' > /dev/null 2>&1; then
  echo "verify-release: no local Postgres to build this commit's catalog in (PGHOST, PGUSER, PGPASSWORD)." >&2
  echo "  It needs the pg_cron/pg_net stubs from supabase/test/fake-extensions; scripts/ci-postgres.sh" >&2
  echo "  installs them. Without it production's definitions cannot be checked, so this fails." >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
LEDGER="$WORKDIR/applied-migrations.json"

echo "verify-release: exporting the live migration ledger from $SUPABASE_PROJECT_REF"
node scripts/export-applied-migrations.mjs "$LEDGER"

echo
echo "verify-release: comparing migrations against that live ledger"
node scripts/compare-migrations.mjs "$LEDGER" --strict --require-applied

echo
echo "verify-release: comparing Edge Functions, their configuration and their status"
bash scripts/verify-function-parity.sh --require-deployed

echo
echo "verify-release: comparing production's live definitions with a fresh build of this commit"
bash scripts/fresh-catalog.sh "$WORKDIR/catalog-built.txt"
node scripts/production-psql.mjs -At -F '|' -f scripts/catalog-fingerprint.sql > "$WORKDIR/catalog-production.txt"
node scripts/compare-catalog.mjs "$WORKDIR/catalog-built.txt" "$WORKDIR/catalog-production.txt"

echo
echo "verify-release: checking the scheduled jobs are aimed at this project"
node scripts/production-psql.mjs -q -v base_url="https://$SUPABASE_PROJECT_REF.supabase.co" -f scripts/verify-cron-targets.sql

echo
echo "verify-release: ok — production is running this commit's migrations, functions, definitions and scheduled jobs"
