#!/usr/bin/env bash
# The catalog a fresh build of this commit defines (outside review, F-02).
#
# Builds a database the way verify-migrations.sh does -- the platform shim,
# then every migration in filename order -- and writes
# scripts/catalog-fingerprint.sql's kind|name|hash lines to <out-file>.
# scripts/compare-catalog.mjs compares that with production's.
#
# Connection comes from the standard libpq environment (PGHOST, PGPORT, PGUSER,
# PGPASSWORD). The database is a throwaway one and is dropped again, unless a
# name is given: then it is left for the caller, which drops it.
#
#   scripts/fresh-catalog.sh <out-file> [database-name]
set -euo pipefail

OUT="${1:?usage: scripts/fresh-catalog.sh <out-file> [database-name]}"
ADMIN_DB="${PGDATABASE:-postgres}"
DB="${2:-rokda_catalog_$$}"

# Only on a test server. A recovery shell can hold PGHOST and PGPASSWORD for
# the new project, and this creates a database and runs every migration in
# it. The pg_cron stub (supabase/test/fake-extensions, version 0.1) exists
# nowhere else, so its presence is what marks a server as safe to build on.
stub=$(psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -At -c "select coalesce((select default_version from pg_available_extensions where name = 'pg_cron'), 'none')")
if [ "$stub" != "0.1" ]; then
  echo "fresh-catalog: refusing to build on $(psql -d "$ADMIN_DB" -At -c "select coalesce(inet_server_addr()::text, 'a local socket')") — its pg_cron is '$stub', not the 0.1 test stub." >&2
  echo "  Point PGHOST at a test Postgres with supabase/test/fake-extensions installed (scripts/ci-postgres.sh)." >&2
  exit 1
fi

PGOPTIONS='-c client_min_messages=warning' psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$DB\";" -c "create database \"$DB\";"
if [ -z "${2:-}" ]; then
  trap 'psql -d "$ADMIN_DB" -q -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true' EXIT
fi

# Query results (the migrations' own selects) are not wanted in a release
# log; errors still reach stderr and stop the build.
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f supabase/test/platform-shim.sql > /dev/null
for file in supabase/migrations/*.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$file" > /dev/null
done

psql -d "$DB" -v ON_ERROR_STOP=1 -At -F '|' -f scripts/catalog-fingerprint.sql > "$OUT"
echo "fresh-catalog: $(wc -l < "$OUT" | tr -d ' ') objects from $(ls supabase/migrations/*.sql | wc -l | tr -d ' ') migrations"
