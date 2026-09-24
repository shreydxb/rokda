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
# Overridable only so the retry loop below can be exercised against a local
# stand-in (scripts/verify-function-parity.test.mjs); production uses the real
# Management API.
API_URL="${SUPABASE_API_URL:-https://api.supabase.com}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# How long to keep re-checking when the ONLY failure is deployed source that
# differs from this commit (compare-functions.mjs exits 3). 0, the default,
# never waits: that is what a branch, a local run and any ref without an
# auto-deploy should get, because there nothing is on its way.
#
# CI sets it on main (SHR-304). The Supabase GitHub integration deploys a
# pushed function at about the moment CI starts, so the first comparison
# could read the previous build: main went red on 24 Sep for PR #38 and again
# for PR #40, and GitHub Pages -- which publishes only after CI succeeds --
# stayed a release behind until someone re-ran the job by hand. Measured on
# PR #40: stale at 16:07:08, in sync by 16:07:52, so a few minutes is ample.
AWAIT_SECONDS="${AWAIT_DEPLOY_SECONDS:-0}"
POLL_SECONDS="${AWAIT_DEPLOY_POLL_SECONDS:-20}"

# Waiting is only honest when this commit is the thing being deployed. If the
# commit changed nothing under supabase/functions, no deploy is coming, and a
# stale function is real drift that has to fail now -- exactly the 8 Sep case
# this check exists for. HEAD~1 must be present (CI checks out with
# fetch-depth: 2); when it is not, the answer is "unknown", and unknown does
# not earn a wait.
commit_changes_functions() {
  git rev-parse --verify --quiet HEAD~1 >/dev/null || return 1
  ! git diff --quiet HEAD~1 HEAD -- supabase/functions supabase/config.toml
}

# One complete look at production: list, download, compare. Fetched fresh
# each time; a retry that reused the first download would only ever see the
# build it already rejected.
check_once() {
  rm -rf "$WORKDIR/supabase" && mkdir -p "$WORKDIR/supabase/functions" || return 1
  LIST_JSON="$WORKDIR/deployed-list.json"

  # The CLI expects to be run inside a project directory. This is a throwaway
  # one holding only the download, deliberately NOT the repository's own --
  # writing the deployment into supabase/functions would overwrite the source
  # side of the comparison and the check would then compare the deployment
  # against itself.
  printf 'project_id = "%s"\n' "$PROJECT_REF" > "$WORKDIR/supabase/config.toml"

  # The list comes from the Management API rather than `supabase functions
  # list`: the endpoint is documented to return JSON, whereas the CLI's JSON
  # output flag is a global that differs between subcommands. The CLI is still
  # used for the download, because that has to unbundle an eszip.
  #
  # Every step checks its own result: this runs as `check_once || status=$?`,
  # and bash suspends `set -e` inside anything called that way.
  echo "verify-function-parity: listing deployed functions in $PROJECT_REF"
  if ! curl -sS --fail-with-body \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "$API_URL/v1/projects/$PROJECT_REF/functions" > "$LIST_JSON"; then
    echo "verify-function-parity: listing the deployed functions failed:" >&2
    head -c 400 "$LIST_JSON" >&2
    return 1
  fi

  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$LIST_JSON" 2>/dev/null; then
    echo "verify-function-parity: the functions list did not come back as JSON:" >&2
    head -c 400 "$LIST_JSON" >&2
    return 1
  fi

  local slugs
  slugs=$(node -e '
    const fns = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(fns.map((f) => f.slug ?? f.name).filter(Boolean).join("\n"));
  ' "$LIST_JSON")

  if [ -z "$slugs" ]; then
    echo "verify-function-parity: the project reports no Edge Functions — refusing to call that parity." >&2
    return 1
  fi

  # --use-api unbundles server-side. Without it the CLI wants Docker, which
  # the CI runner does not have, and the download would fail in a way that
  # reads as "no drift found" rather than "not checked".
  local slug
  while IFS= read -r slug; do
    [ -n "$slug" ] || continue
    echo "  downloading $slug"
    if ! $SUPABASE functions download "$slug" --project-ref "$PROJECT_REF" --use-api --workdir "$WORKDIR"; then
      echo "  warning: could not download $slug — it will be reported as unreadable" >&2
    fi
  done <<< "$slugs"

  # --require-deployed turns "in the repository, not deployed" from an
  # expected state into a failure. It belongs to a release check, not a
  # pre-merge one: before a deploy, a merged-but-unreleased function is a
  # deployment decision, and after one it means production is missing
  # something this commit declares (QA #7). scripts/verify-release.sh passes
  # it; ordinary CI does not.
  echo "verify-function-parity: comparing against $(git rev-parse --short HEAD)"
  node scripts/compare-functions.mjs "$WORKDIR/supabase/functions" "$LIST_JSON" "$@"
}

deadline=$((SECONDS + AWAIT_SECONDS))
while :; do
  status=0
  check_once "$@" || status=$?
  [ "$status" -eq 3 ] || exit "$status"

  # Only an out-of-date deployment is wrong. Wait for this commit's deploy if
  # told to and if this commit is one; otherwise it is plain drift.
  if [ "$AWAIT_SECONDS" -le 0 ]; then
    exit 1
  fi
  if ! commit_changes_functions; then
    echo "verify-function-parity: this commit changes no Edge Function, so no deploy is on its way — the difference above is drift." >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "verify-function-parity: still different after ${AWAIT_SECONDS}s. The deploy of this commit did not land; that is a failure, not a delay." >&2
    exit 1
  fi
  echo
  echo "verify-function-parity: this commit changes Edge Functions and production is still on the previous build; its deploy is probably in flight. Re-checking in ${POLL_SECONDS}s (giving up after ${AWAIT_SECONDS}s)."
  sleep "$POLL_SECONDS"
done
