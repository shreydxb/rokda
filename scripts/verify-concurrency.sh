#!/usr/bin/env bash
# Race conditions, which a single session structurally cannot find (SHR-238
# follow-on; "true concurrency" in every QA pass so far).
#
# supabase/test/*.test.sql run in ONE psql session. That proves constraints,
# policies and retry idempotency, and it cannot prove anything about two
# clients acting at the same instant -- the case where each transaction reads a
# snapshot taken before the other committed. This runs real concurrent psql
# sessions against a database built from supabase/migrations.
#
# Each race starts both sessions together, has them pause mid-transaction so
# the two genuinely overlap, and asserts on the state left behind.
#
#   PGHOST=/var/run/postgresql PGUSER=postgres scripts/verify-concurrency.sh
set -euo pipefail

ADMIN_DB="${PGDATABASE:-postgres}"
DB="rokda_concurrency_$$"
fail=0

psql -d "$ADMIN_DB" -v ON_ERROR_STOP=1 -q -c "create database \"$DB\";"
trap 'psql -d "$ADMIN_DB" -q -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true' EXIT

echo "verify-concurrency: building $DB from supabase/migrations"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f supabase/test/platform-shim.sql
for file in supabase/migrations/*.sql; do
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$file"
done

seed() {
  psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
set client_min_messages = warning;
truncate household_members, households, accounts, categories, transactions, intake cascade;
delete from auth.users;
insert into auth.users (id, email) values
  ('0a000000-0000-4000-8000-00000000000a', 'o1@example.test'),
  ('0b000000-0000-4000-8000-00000000000b', 'o2@example.test');
insert into households (id, name) values ('d1000000-0000-4000-8000-000000000001', 'Race household');
insert into household_members (id, household_id, user_id, display_name, role) values
  ('e1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000000a', 'Owner one', 'owner'),
  ('e1000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-00000000000b', 'Owner two', 'owner');
SQL
}

# Run a transaction that pauses before AND after its write, so two of them
# started together are guaranteed to overlap.
overlap() {
  psql -d "$DB" <<SQL >/dev/null 2>&1 || true
begin;
select pg_sleep(0.4);
$1
select pg_sleep(0.6);
commit;
SQL
}

check() { # name expected actual
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 (owners=$3)"
  else
    echo "  FAIL $1 — expected owners=$2, got $3" >&2
    fail=1
  fi
}

echo "verify-concurrency: last owner, two sessions deleting different owners"
seed
overlap "delete from household_members where id='e1000000-0000-4000-8000-00000000000a';" &
overlap "delete from household_members where id='e1000000-0000-4000-8000-00000000000b';" &
wait
check "two concurrent owner deletes cannot empty the household" 1 \
  "$(psql -At -d "$DB" -c "select count(*) from household_members where role='owner'")"

echo "verify-concurrency: last owner, a demotion racing a delete"
seed
overlap "update household_members set role='member' where id='e1000000-0000-4000-8000-00000000000a';" &
overlap "delete from household_members where id='e1000000-0000-4000-8000-00000000000b';" &
wait
check "a demote racing a delete cannot empty the household" 1 \
  "$(psql -At -d "$DB" -c "select count(*) from household_members where role='owner'")"

echo "verify-concurrency: two sessions approving the same intake"
seed
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
insert into accounts (id, household_id, name, type) values
  ('f1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Current', 'checking');
insert into categories (id, household_id, name, kind) values
  ('c1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Groceries', 'expense');
insert into intake (id, household_id, source, raw_text, parsed_amount, status, member_id) values
  ('a1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'telegram', 'spent 45', 45, 'pending', 'e1000000-0000-4000-8000-00000000000a');
SQL
APPROVE="select approve_intake('a1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',45,'2026-09-14','expense','c1000000-0000-4000-8000-000000000001','AED','Coffee',true,'e1000000-0000-4000-8000-00000000000a');"
overlap "$APPROVE" &
overlap "$APPROVE" &
wait
txns=$(psql -At -d "$DB" -c "select count(*) from transactions")
if [ "$txns" = "1" ]; then
  echo "  ok   a double approval yields exactly one transaction (transactions=$txns)"
else
  echo "  FAIL a double approval yielded $txns transactions, expected 1" >&2
  fail=1
fi

echo "verify-concurrency: two deliveries of the same Telegram update (SHR-303)"
# Telegram retries a webhook it thinks failed, so the same update_id can arrive
# while the first delivery is still being processed. Exactly one may claim it;
# the other must be told it is busy -- never fresh, and never "completed",
# which would make the caller answer 200 and end Telegram's retries.
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'SQL'
set client_min_messages = warning;
create table if not exists race_claims (result text);
truncate race_claims;
delete from telegram_update_log;
SQL
CLAIM="insert into race_claims select claim_telegram_update(9100001);"
overlap "$CLAIM" &
overlap "$CLAIM" &
wait
outcome=$(psql -At -d "$DB" -c "select string_agg(result, ',' order by result) from race_claims")
if [ "$outcome" = "busy,claimed" ]; then
  echo "  ok   concurrent claims of one update: exactly one claimed ($outcome)"
else
  echo "  FAIL concurrent claims of one update gave '$outcome', expected 'busy,claimed'" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "verify-concurrency: FAILED" >&2
  exit 1
fi
echo "verify-concurrency: ok"
