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
# The applied side is exported fresh every run into a temp file. It
# deliberately does NOT read docs/applied-migrations.json -- a release decision
# should not rest on a checked-in description of production, which is the
# failure this exists to prevent.
#
#   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... scripts/verify-release.sh
set -euo pipefail

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "verify-release: SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required." >&2
  echo "  Production state cannot be read without them, and an unverified release claim" >&2
  echo "  is not a passing one -- so this fails rather than skipping." >&2
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
echo "verify-release: ok — production is running this commit's migrations and functions"
