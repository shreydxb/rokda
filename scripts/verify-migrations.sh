#!/usr/bin/env bash
# Prove a fresh database can be built from this repository (QA-12, SHR-253).
#
# Creates an empty database, applies supabase/test/platform-shim.sql, then every
# file in supabase/migrations in filename order, stopping at the first error.
# This is what makes the migration history reproducible rather than merely
# plausible: matching table names never proved the SQL was equivalent.
#
# Connection comes from the standard libpq environment (PGHOST, PGPORT, PGUSER,
# PGPASSWORD). It never touches an existing database: it creates a throwaway one
# and drops it again.
#
#   PGHOST=/var/run/postgresql PGUSER=postgres scripts/verify-migrations.sh
set -euo pipefail

ADMIN_DB="${PGDATABASE:-postgres}"
DB="rokda_migration_check_$$"

psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -q -c "create database \"$DB\";"
trap 'psql -d "$ADMIN_DB" -q -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true' EXIT

echo "verify-migrations: building $DB from supabase/migrations"

psql -d "$DB" -v ON_ERROR_STOP=1 -q -f supabase/test/platform-shim.sql

count=0
for file in supabase/migrations/*.sql; do
  printf '  %s\n' "$(basename "$file")"
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$file"
  count=$((count + 1))
done

# A build that produced no tables would still "succeed" without this.
tables=$(psql -d "$DB" -tAc "select count(*) from information_schema.tables where table_schema = 'public';")
rls=$(psql -d "$DB" -tAc "select count(*) from pg_tables where schemaname = 'public' and rowsecurity;")
echo "verify-migrations: applied $count migrations; $tables public tables, $rls with RLS enabled"

if [ "$tables" -lt 10 ]; then
  echo "verify-migrations: too few tables — the migrations did not build the schema" >&2
  exit 1
fi
if [ "$rls" -ne "$tables" ]; then
  echo "verify-migrations: $((tables - rls)) public table(s) without row-level security" >&2
  exit 1
fi
echo "verify-migrations: ok"
