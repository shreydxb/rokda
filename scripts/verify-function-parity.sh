#!/usr/bin/env bash
# Prove the Edge Functions running in production are the ones in this commit
# (QA re-run, 10 Sep 2026).
#
# Fetches deployed state fresh every run -- there is no committed snapshot of
# it on purpose. A snapshot is the failure this check exists to catch: the
# migration snapshot covered 32 of 38 migrations and made six live migrations
# read as "awaiting deployment" while reporting 0 drifting.
#
# Needs a Supabase access token, because deployed state is only readable with
# one:
#
#   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... scripts/verify-function-parity.sh
#
# Downloads into a throwaway directory, never into supabase/functions -- the
# repository side of the comparison has to stay untouched or the check compares
# the deployment against itself.
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || [ -z "$PROJECT_REF" ]; then
  echo "verify-function-parity: SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required." >&2
  echo "  Deployed state cannot be read without them, and an unverified parity claim" >&2
  echo "  is not a passing one -- so this fails rather than skipping." >&2
  exit 1
fi

SUPABASE="${SUPABASE_CLI:-npx --yes supabase}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$WORKDIR/supabase/functions"
LIST_JSON="$WORKDIR/deployed-list.json"

# The CLI expects to be run inside a project directory. This is a throwaway one
# holding only the download, deliberately NOT the repository's own -- writing
# the deployment into supabase/functions would overwrite the source side of the
# comparison and the check would then compare the deployment against itself.
printf 'project_id = "%s"\n' "$PROJECT_REF" > "$WORKDIR/supabase/config.toml"

# The list comes from the Management API rather than `supabase functions list`:
# the endpoint is documented to return JSON, whereas the CLI's JSON output flag
# is a global that differs between subcommands. The CLI is still used for the
# download, because that has to unbundle an eszip.
echo "verify-function-parity: listing deployed functions in $PROJECT_REF"
curl -sS --fail-with-body \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$PROJECT_REF/functions" > "$LIST_JSON"

if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$LIST_JSON" 2>/dev/null; then
  echo "verify-function-parity: the functions list did not come back as JSON:" >&2
  head -c 400 "$LIST_JSON" >&2
  exit 1
fi

slugs=$(node -e '
  const fns = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(fns.map((f) => f.slug ?? f.name).filter(Boolean).join("\n"));
' "$LIST_JSON")

if [ -z "$slugs" ]; then
  echo "verify-function-parity: the project reports no Edge Functions — refusing to call that parity." >&2
  exit 1
fi

# --use-api unbundles server-side. Without it the CLI wants Docker, which the
# CI runner does not have, and the download would fail in a way that reads as
# "no drift found" rather than "not checked".
while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  echo "  downloading $slug"
  if ! $SUPABASE functions download "$slug" --project-ref "$PROJECT_REF" --use-api --workdir "$WORKDIR"; then
    echo "  warning: could not download $slug — it will be reported as unreadable" >&2
  fi
done <<< "$slugs"

# --require-deployed turns "in the repository, not deployed" from an expected
# state into a failure. It belongs to a release check, not a pre-merge one:
# before a deploy, a merged-but-unreleased function is a deployment decision,
# and after one it means production is missing something this commit declares
# (QA #7). scripts/verify-release.sh passes it; ordinary CI does not.
echo "verify-function-parity: comparing against $(git rev-parse --short HEAD)"
node scripts/compare-functions.mjs "$WORKDIR/supabase/functions" "$LIST_JSON" "$@"
