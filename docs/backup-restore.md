# Backup and restore

**Status: the commands below are verified; the household's real data has never
been exported or restored.** The procedure in §3–§4 was executed end to end on
13 September 2026 against a synthetic household in a local PostgreSQL built
from `supabase/migrations` — dump, restore, fingerprint diff clean, no dangling
memberships. What that establishes is that the commands work and the
verification detects failure. What it does not establish is that *this
project's* data can be got back, which needs the drill run against a real
export (§4).

That distinction is the point of writing this down: every QA pass so far has
been able to say the migrations are green, and none has been able to say the
data can be got back.

A green migration pipeline is not a backup. It reproduces the *schema* from
`supabase/migrations`; it reproduces none of the household's ledger.

## 1. What would actually have to come back

Rokda's data is small and almost entirely unreconstructable. As of
13 September 2026 the live project (`erggbzbbutsvhleqcddq`, PostgreSQL 17.6,
`ap-south-1`) holds roughly 657 rows across 22 tables:

| Table | Rows | Reconstructable from elsewhere? |
| --- | --- | --- |
| `budgets` | 336 | No — hand-set per category per month |
| `holding_value_history` | 190 | Partly, and only approximately: prices could be re-fetched, but not the dated valuations actually recorded |
| `categories` | 41 | No — customised |
| `holdings` | 39 | No — positions and cost basis |
| `transactions` | 18 | No — the ledger itself |
| `accounts` | 9 | No — balances are manual confirmations (`docs/decisions.md`) |
| `intake` | 9 | No — Telegram-created items |
| `goals`, `recurring` | 4 each | No |
| `household_members`, `households`, `fx_rates` | 1–2 | No |

The remaining tables are empty today and will not stay that way.

Four things live outside the `public` schema and are missed by the obvious
`pg_dump` of it. Three of them break the app if they are absent:

- **`auth.users`** (1 row). `household_members.user_id` references it, and
  `useHousehold()` resolves the household by exactly that column. Restore the
  public schema alone and every membership points at nothing: the owner signs
  in successfully and the app reports they are not in a household.
- **`vault.secrets`** (2: `telegram_webhook_secret`, `service_role_key`).
  Encrypted with a key that does not travel with a dump. These are
  **re-provisioned, not restored** — see §5.
- **`cron.job`** (3: `daily-fd-accrual` 23:00, `daily-recurring-nudge-check`
  05:00, `weekday-price-refresh` 23:00 Sun–Thu). Recreated by the migrations,
  but their bodies read the vault secrets above, so they are inert until those
  are back.
- **`storage`** (1 bucket, 0 objects). Nothing to lose today; check again
  before trusting that.

Edge Functions and the schema itself are in git and are not part of this
problem. `npm run compare:migrations` and `npm run verify:functions` already
prove that half.

## 2. What the platform gives you

Supabase takes its own backups, and the retention and point-in-time recovery
available depend on the project's plan. **Confirm what this project actually
has** (Dashboard → Database → Backups) rather than assuming: on the lower tiers
retention is short and PITR is not included, which is precisely the case where
an independent export matters most.

Platform backups also share a failure mode with the thing they protect: they
are administered through the same account. An account-level mistake or loss
takes both. The export below exists to be somewhere else.

## 3. Taking an independent export

Runs from any machine with `pg_dump` 17+ and the project's connection string
(Dashboard → Connect → Session pooler / direct). At this size it takes seconds.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# The application data, complete, restorable on its own.
pg_dump "$SOURCE_URL" \
  --format=custom \
  --no-owner --no-privileges \
  --schema=public \
  --file="rokda-public-$STAMP.dump"

# The logins. Separate because auth is Supabase-managed: restoring the whole
# schema over a live project's auth is not something to do casually, but
# without these rows the memberships dangle.
pg_dump "$SOURCE_URL" \
  --format=custom \
  --no-owner --no-privileges \
  --table='auth.users' \
  --file="rokda-auth-users-$STAMP.dump"

# What the data SHOULD look like, captured at the same moment.
psql -At -f scripts/data-fingerprint.sql "$SOURCE_URL" > "rokda-fingerprint-$STAMP.txt"
```

Keep the three files together: a dump whose fingerprint was taken at a
different moment proves nothing about that dump.

Store them off the platform they came from — a different provider, or local
disk with its own backup. Treat them as containing the household's complete
financial history, because they do.

**Cadence.** Weekly is proportionate to this data's rate of change, with an
extra export before any migration that rewrites rows. A monthly export of a
ledger that gains transactions daily is a month of typing at risk.

## 4. The restore drill

**This is the part that makes the rest true.** A dump nobody has restored is a
hypothesis.

Restore into somewhere that is *not* production: a scratch Supabase project, or
a local PostgreSQL 17 (`docker run --rm -e POSTGRES_PASSWORD=... -p 5433:5432
postgres:17`). Match the major version — see the fingerprint script's caveats.

```bash
createdb rokda_restore_drill            # or create a scratch Supabase project

# Schema first, from the repository, exactly as CI builds it from zero.
psql -d rokda_restore_drill -v ON_ERROR_STOP=1 -q -f supabase/test/platform-shim.sql
for f in supabase/migrations/*.sql; do
  psql -d rokda_restore_drill -v ON_ERROR_STOP=1 -q -f "$f"
done

# Then the data.
pg_restore --data-only --disable-triggers --no-owner --no-privileges \
  -d rokda_restore_drill "rokda-auth-users-$STAMP.dump"
pg_restore --data-only --disable-triggers --no-owner --no-privileges \
  -d rokda_restore_drill "rokda-public-$STAMP.dump"
```

**`--disable-triggers` is not optional, and leaving it off fails in the worst
possible way.** A `--data-only` restore loads tables in alphabetical order, so
foreign keys fire before the rows they point at exist. Measured on this schema,
restoring the same dump without it:

```
pg_restore: error: COPY failed for table "accounts": violates foreign key constraint "accounts_household_id_fkey"
pg_restore: error: COPY failed for table "categories": ... "categories_household_id_fkey"
pg_restore: error: COPY failed for table "household_members": ... "household_members_household_id_fkey"
pg_restore: error: COPY failed for table "transactions": ... "transactions_account_id_fkey"
pg_restore: warning: errors ignored on restore: 4
```

leaving `households=1, accounts=0, transactions=0` — a database that looks
restored and contains no ledger. `pg_restore` exits `1`, but it does not stop:
it reports "errors ignored" and carries on, so a script with `|| true`, or an
operator reading the last line rather than the exit code, gets a silently
gutted restore. This is the single most likely way a recovery goes wrong.

The flag also preserves recorded values that the schema would otherwise
recompute. `compute_account_derived_fields` derives an FD's `balance` from
elapsed time and sets `fd_status` from `current_date`, so restoring a
month-old dump with triggers live would overwrite the balance that was
recorded with one calculated for today. Verified: with the flag, an FD
recorded at `10123.45 / active` restores as `10123.45 / active`.

Note that the local shim supplies `auth.users`, `auth.uid()` and the API roles
so the migrations apply to a bare PostgreSQL. It is a test harness, never
applied to a real environment.

### Verifying it

```bash
psql -At -f scripts/data-fingerprint.sql "$RESTORED_URL" > /tmp/restored.txt
diff "rokda-fingerprint-$STAMP.txt" /tmp/restored.txt && echo "restore verified"
```

A clean diff means every table has the same rows with the same contents, and
`auth.users` carries the same ids. That is the claim worth making.

Then check the things a fingerprint cannot see:

1. **Referential integrity across the two dumps.** Every membership must resolve
   to a real login:
   ```sql
   select count(*) from household_members m
   where m.user_id is not null
     and not exists (select 1 from auth.users u where u.id = m.user_id);
   ```
   Must be `0`. A non-zero result is the dangling-membership failure in §1, and
   it is silent in the app until someone signs in.
2. **The invariants still hold.** Run the repository's own suites against the
   restored database — `supabase/test/migration-behaviour.test.sql` and
   `supabase/test/rls-policies.test.sql`. Both roll back, so they are safe
   against a restore you intend to keep. This proves the restored schema still
   refuses cross-household writes and still keeps an owner.
3. **A figure a human recognises.** Read the net worth or this month's spend off
   the restored data and compare it with the live app. Row counts can match
   while a numeric column has been truncated; a wrong headline number is the
   one error a person spots immediately.

**Record the date the drill last passed, here:**

| Drill run | Scope | Result |
| --- | --- | --- |
| 2026-09-13 | Synthetic household, local PostgreSQL 16 | Fingerprint identical; 0 dangling memberships; `--disable-triggers` failure mode measured |
| _pending_ | **Real export of `erggbzbbutsvhleqcddq`** | — |

## 5. Recovering for real

Order matters, because the app fails differently at each stage and it is easy
to conclude the restore failed when it is merely incomplete.

1. **Restore schema then data**, as in §4, into the new project.
2. **Re-provision the secrets.** They are not in the dump.
   - `telegram_webhook_secret` — must match what Telegram sends. Re-run
     `setWebhook` with a new `secret_token` and store the same value in the
     vault; the two are one secret in two places. See `docs/environments.md`.
   - `service_role_key` — the new project's own key, not the old one.
3. **Redeploy the Edge Functions** from git, then prove it:
   `npm run verify:functions`. Do not assume a deploy landed.
4. **Check the cron jobs exist and are active** (`select jobname, active from
   cron.job`). The migrations create them; their bodies read the secrets from
   step 2, so an untouched-looking job can still be doing nothing.
5. **Repoint the frontend** at the new project ref and publishable key
   (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) in both hosts'
   settings, and rebuild. `npm run verify:build` catches the build that
   silently ships no application at all when these are missing.
6. **Re-run `npm run compare:migrations`** against the new project. A recovery
   that leaves migration history disagreeing with the repository has recreated
   the drift problem while the data was still warm.

## 6. What would make this stronger

Nothing below is required to run the drill; all of it is worth doing once the
drill has been run at least once.

- Automate the export on a schedule, to storage outside this Supabase account,
  and alert when one does not appear. An unmonitored backup job is a backup job
  that stopped some time ago.
- Keep the fingerprint from each export. A silently emptying table shows up as
  a shrinking row count long before anyone notices in the app.
- Re-run the drill on a calendar, not on alarm. The first time a restore is
  attempted should never be the day it is needed.
