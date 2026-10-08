#!/usr/bin/env bash
# Netlify runs this before every build (netlify.toml, build.ignore). Exit 0
# means "nothing to publish": the build stops, nothing is deployed and no
# credits are spent. Any other exit status builds. So every doubt -- a first
# build, a cleared cache, a commit Netlify cannot find -- falls through to a
# build: a wasted build costs credits, a skipped release leaves the household
# on old code without anyone noticing.
#
# The question asked is: did anything the site is built from change between
# the last commit Netlify built (CACHED_COMMIT_REF) and this one (COMMIT_REF)?
# Migrations, Edge Functions, docs, CI and tests are not part of the site.
#
# Commits whose message contains [skip netlify] never reach this script:
# Netlify drops them before a build starts. That is for batching several
# site changes into one deploy; this script is for changes that are not the
# site at all, so nobody has to remember the marker for those.

set -u

# A redeploy of the commit already built is a deliberate "Trigger deploy".
if [ -z "${CACHED_COMMIT_REF:-}" ] || [ -z "${COMMIT_REF:-}" ] || [ "$CACHED_COMMIT_REF" = "$COMMIT_REF" ]; then
  echo "netlify-ignore: no earlier build to compare with; building."
  exit 1
fi

# git diff --quiet exits 0 for no difference, 1 for a difference and 128 when
# it cannot compare (an unknown commit), which is exactly the contract above.
# Test files live beside the code in src/, so they are excluded by name;
# without a glob pathspec, * also matches across directories.
git diff --quiet "$CACHED_COMMIT_REF" "$COMMIT_REF" -- \
  index.html public src package.json package-lock.json vite.config.js netlify.toml \
  scripts/csp.mjs scripts/verify-build.mjs scripts/netlify-ignore.sh \
  ':(exclude)src/*.test.js' ':(exclude)src/*.test.jsx' ':(exclude)src/test'
status=$?

if [ "$status" -eq 0 ]; then
  echo "netlify-ignore: nothing the site is built from changed since ${CACHED_COMMIT_REF}; skipping the build."
else
  echo "netlify-ignore: the site changed since ${CACHED_COMMIT_REF} (git diff exit ${status}); building."
fi
exit "$status"
