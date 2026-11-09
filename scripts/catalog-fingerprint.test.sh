#!/usr/bin/env bash
# Does the catalog fingerprint see what it should, and only that? (F-02)
#
# Builds a fresh database, then changes it the two ways that matter:
#
#   * A function rewritten with Windows line endings must read the same.
#     Production holds 53 functions that were applied that way, and a check
#     that reported them would be red on main for nothing.
#   * A function whose body changed must read differently, and be named.
#
# Connection as for fresh-catalog.sh. The database is dropped again.
set -euo pipefail

ADMIN_DB="${PGDATABASE:-postgres}"
DB="rokda_fingerprint_test_$$"
WORK="$(mktemp -d)"
trap 'psql -d "$ADMIN_DB" -q -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

bash scripts/fresh-catalog.sh "$WORK/built.txt" "$DB" > /dev/null
FN="public.touch_updated_at()"

# Every line ending in the definition becomes \r\n, as an editor on Windows
# would have saved it. Postgres keeps the body exactly as given.
psql -d "$DB" -v ON_ERROR_STOP=1 -q -c "do \$\$ begin execute replace(pg_get_functiondef('$FN'::regprocedure), E'\n', E'\r\n'); end \$\$;"
crs=$(psql -d "$DB" -At -c "select position(E'\r' in prosrc) > 0 from pg_proc where oid = '$FN'::regprocedure")
if [ "$crs" != "t" ]; then echo "catalog-fingerprint test: could not give $FN Windows line endings" >&2; exit 1; fi
psql -d "$DB" -v ON_ERROR_STOP=1 -At -F '|' -f scripts/catalog-fingerprint.sql > "$WORK/crlf.txt"
if ! node scripts/compare-catalog.mjs "$WORK/built.txt" "$WORK/crlf.txt" > "$WORK/crlf.out"; then
  cat "$WORK/crlf.out"
  echo "catalog-fingerprint test: FAILED — line endings alone made $FN read as different" >&2
  exit 1
fi

# A real edit: one line added to the body.
psql -d "$DB" -v ON_ERROR_STOP=1 -q -c "do \$\$ begin execute regexp_replace(pg_get_functiondef('$FN'::regprocedure), '\\\$function\\\$\\s*\$', E'-- edited\n\$function\$'); end \$\$;"
psql -d "$DB" -v ON_ERROR_STOP=1 -At -F '|' -f scripts/catalog-fingerprint.sql > "$WORK/edited.txt"
if node scripts/compare-catalog.mjs "$WORK/built.txt" "$WORK/edited.txt" > "$WORK/edited.out"; then
  echo "catalog-fingerprint test: FAILED — an edited body of $FN read as the same" >&2
  exit 1
fi
if ! grep -qF "DIFFERENT  function $FN" "$WORK/edited.out" || [ "$(grep -c '^DIFFERENT\|^MISSING\|^EXTRA' "$WORK/edited.out")" != 1 ]; then
  cat "$WORK/edited.out"
  echo "catalog-fingerprint test: FAILED — expected exactly $FN to differ" >&2
  exit 1
fi

echo "catalog-fingerprint test: ok — line endings ignored, an edited body named"
