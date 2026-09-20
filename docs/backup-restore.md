# Backup and restore

**Status: verified against the real household data (SHR-285, 19 September
2026).** A real export of production (`erggbzbbutsvhleqcddq`) was taken,
restored into a scratch Supabase project, and diffed — clean. See the
drill-history table in §4 for the result, and the note under "Restoring into a
real Supabase project" for a real correction this run surfaced: `pg_restore
--disable-triggers` (as originally written below) only works against a
self-hosted Postgres where the connecting role is a true superuser. It is
not — a hosted project's `postgres` role cannot disable the system foreign-key
trigger objects, so the drill had to switch to `session_replication_role`
instead. That fix is now the documented method for restoring into a real
Supabase project.

A green migration pipeline is not a backup. It reproduces the *schema* from
`supabase/migrations`; it reproduces none of the household's ledger. That is
what §3–§4 below actually exercise, and now have, for real.

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

Several things live outside the `public` schema and are missed by the obvious
`pg_dump` of it. Most of them break the app if they are absent:

- **`auth.users`** (1 row). `household_members.user_id` references it, and
  `useHousehold()` resolves the household by exactly that column. Restore the
  public schema alone and every membership points at nothing: the owner signs
  in successfully and the app reports they are not in a household.
- **`auth.identities`** (1 row). The link between a login and the provider that
  authenticates it. This was missed entirely until the QA #1 review — not
  exported, not fingerprinted. Whether GoTrue can complete a password sign-in
  without it is not something this document can settle by reasoning; §5 now
  rehearses an actual login instead.
- **`vault.secrets`** (2: `telegram_webhook_secret`, `service_role_key`).
  Encrypted with a key that does not travel with a dump. These are
  **re-provisioned, not restored** — see §5.
- **Edge Function environment secrets** (`TELEGRAM_BOT_TOKEN`,
  `OPENROUTER_API_KEY`, `TWELVEDATA_API_KEY`). Not in any dump, not in git, and
  not in the vault either — they are set on the platform, per function. Without
  them the functions deploy and run and every outbound call fails. Also
  re-provisioned, see §5.
- **`cron.job`** (3: `daily-fd-accrual` 23:00, `daily-recurring-nudge-check`
  05:00, `weekday-price-refresh` 23:00 Sun–Thu). All three are created by the
  migrations now — `daily-fd-accrual` was scheduled by hand and existed in no
  migration, so a rebuilt project simply never accrued fixed-deposit interest
  (QA #1). Their bodies read the vault secrets above, so they are inert until
  those are back, **and they carry the project URL they were built with**, so
  they need retargeting in a replacement project. One call does it; §5 makes it
  a step and `scripts/verify-cron-targets.sql` checks it.
- **`storage`** (1 bucket, **1 object** — a Telegram receipt, referenced by
  `intake.photo_path`). This section said "0 objects, nothing to lose today"
  while that receipt was already there: nothing noticed, because nothing looked.
  Object bytes are in no `pg_dump`; §3 exports them separately and the
  fingerprint now digests their metadata.

Edge Functions and the schema itself are in git and are not part of this
problem. `npm run compare:migrations` and `npm run verify:functions` prove that
half before a deploy; `npm run verify:release` proves it against live state
after one.

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

# The logins, and the identities that authenticate them. Separate because auth
# is Supabase-managed: restoring the whole schema over a live project's auth is
# not something to do casually, but without these rows the memberships dangle.
# auth.identities was missing from this command until QA #1 — auth.users alone
# may not be enough for GoTrue to complete a sign-in, and a restore is the
# wrong moment to find out.
pg_dump "$SOURCE_URL" \
  --format=custom \
  --no-owner --no-privileges \
  --table='auth.users' --table='auth.identities' \
  --file="rokda-auth-$STAMP.dump"

# The receipt files. No pg_dump contains object BYTES — the database holds only
# the paths, and intake.photo_path pointing at a file that is not there is a
# receipt gone for good.
#
# `supabase storage` has no --project-ref: it acts on the LINKED project, and
# is behind --experimental. The flag was silently wrong here, which is the
# worse direction of the two -- a backup you believe you have is not one.
# Check what is linked before trusting the copy, and check the copy after.
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase storage cp --recursive --experimental \
  "ss:///telegram-receipts" "rokda-storage-$STAMP/"
test -d "rokda-storage-$STAMP" && find "rokda-storage-$STAMP" -type f | wc -l

# What the data SHOULD look like, captured at the same moment. Now covers the
# auth columns a sign-in depends on, auth.identities, and the storage objects'
# metadata — not just public rows and a list of user ids (QA #1).
psql -At -f scripts/data-fingerprint.sql "$SOURCE_URL" > "rokda-fingerprint-$STAMP.txt"
```

Keep the four outputs together: a dump whose fingerprint was taken at a
different moment proves nothing about that dump, and a database without its
receipts is not the household's records.

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
  -d rokda_restore_drill "rokda-auth-$STAMP.dump"
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

### Restoring into a real Supabase project instead of a bare PostgreSQL

The commands above were only ever proven against a local, self-hosted
PostgreSQL, where the connecting `postgres` role is a genuine superuser and
`ALTER TABLE ... DISABLE TRIGGER` on the system foreign-key trigger objects
just works. **It does not work the same way against a real Supabase
project.** Measured running the SHR-285 drill: `pg_restore --disable-triggers`
against a live Supabase project's `postgres` role fails with `must be owner of
table users` and `permission denied: "RI_ConstraintTrigger_..." is a system
trigger` — that role is not a true superuser there, so it cannot disable
those triggers, and the restore silently falls back to the exact
foreign-key-ordering failure §4 already documents above (a database that
looks restored and contains no ledger).

There is no schema first-then-`platform-shim` step either when the target is
a real Supabase project — it already has real `auth`, `storage`, `vault` and
`cron` schemas; just apply the repository's migrations directly:

```bash
for f in supabase/migrations/*.sql; do
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
```

Then restore data with foreign-key and trigger enforcement turned off at the
*session* level instead of per-table — this is the Supabase-documented
pattern for bulk loads, and it works with the privileges a project's
`postgres` role actually has:

```bash
pg_restore --data-only --no-owner --no-privileges -f auth-users.sql "rokda-auth-$STAMP.dump"
pg_restore --data-only --no-owner --no-privileges -f public.sql "rokda-public-$STAMP.dump"

{
  echo "SET session_replication_role = replica;"
  cat auth-users.sql public.sql
  echo "SET session_replication_role = DEFAULT;"
} > combined-restore.sql

psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f combined-restore.sql
```

`auth.users` restores fine even with the plain `pg_restore -d` form above —
its own disable/enable-trigger wrapper statements fail the same permission
way, but `pg_restore` reports them as "errors ignored" and the actual `COPY`
underneath still runs, so it is only `public`'s foreign-key-heavy tables that
actually need the `session_replication_role` route.

### Verifying it

```bash
psql -At -f scripts/data-fingerprint.sql "$RESTORED_URL" > /tmp/restored.txt
diff "rokda-fingerprint-$STAMP.txt" /tmp/restored.txt && echo "restore verified"
```

A clean diff means every table has the same rows with the same contents, the
auth columns a sign-in depends on are unchanged, `auth.identities` came across,
and the storage objects' metadata matches. That is the claim worth making —
and it is a bigger claim than it was, because the fingerprint used to digest
`auth.users` ids **alone**. Ids matching proves memberships resolve; it proves
nothing about whether anyone can sign in, so a restore with a changed email or
a lost password hash passed with an identical fingerprint (QA #1).

It is still not a claim about a working project. The storage digest covers
object metadata, not bytes; nothing here exercises GoTrue, the bot, or a
scheduled run. Those are §5's rehearsal checklist, and they are the difference
between "the data restores" and "we can recover".

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
| 2026-09-19 | **Real export of `erggbzbbutsvhleqcddq`**, restored into a scratch Supabase project (`rokda-restore-drill-scratch`, deleted after) | Fingerprint identical across all tables and `auth.users`; 0 dangling memberships; total account balance figure matched production exactly. Surfaced the `session_replication_role` fix documented above — `--disable-triggers` doesn't work against a real Supabase project's `postgres` role. |
| 2026-09-20 | Scope of the drill re-examined after QA #1 | **Not a pass.** The 09-19 run is still valid for what it covered, and what it covered was narrower than it read: the export had no storage objects and no `auth.identities`, the fingerprint digested user ids only, a migration replay produced two of the three cron jobs and pointed both at the old project, and nothing exercised a login, a receipt, the bot or a scheduled run. All of that is fixed or written down above; none of it has been rehearsed yet. The next drill must run §5's checklist end to end. |

## 5. Recovering for real

Order matters, because the app fails differently at each stage and it is easy
to conclude the restore failed when it is merely incomplete.

The QA #1 review found this list short in ways that all pointed the same
direction: every step here used to be about database rows, and a working
project is more than its rows. The drill proved restoration of the data it
included. It did not establish working authentication, attachments, bot or
scheduled services — and a fingerprint match plus a correct headline total
cannot, because none of those four is a row in `public`.

1. **Restore schema then data** into the new project, using the "Restoring
   into a real Supabase project" method in §4 — the plain `--disable-triggers`
   form earlier in §4 does not work here.
2. **Restore the auth rows** from `rokda-auth-*.dump` (both `auth.users` and
   `auth.identities`). Without them every membership dangles and the owner
   signs in to a household the app says they are not in.
3. **Restore the receipt files** into the new project's bucket. The database
   holds paths; nothing in it holds bytes.

   `supabase storage` has no `--project-ref`: it acts on the linked project,
   and is still behind `--experimental`. Link first, and check what you
   linked before copying anything into it.

   ```bash
   supabase link --project-ref "$NEW_PROJECT_REF"
   supabase projects list        # confirm the bullet is on the NEW project
   supabase storage cp --recursive --experimental \
     "rokda-storage-$STAMP/" "ss:///telegram-receipts"
   ```

4. **Re-provision the vault secrets.** They are not in the dump.
   - `telegram_webhook_secret` — must match what Telegram sends. Re-run
     `setWebhook` with a new `secret_token` and store the same value in the
     vault; the two are one secret in two places. See `docs/environments.md`.
   - `service_role_key` — the new project's own key, not the old one.
5. **Re-provision the Edge Function environment secrets.** A separate place
   from the vault, and missed entirely until QA #1. Set on the new project
   (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
   - `TELEGRAM_BOT_TOKEN` — without it the bot cannot send a single message.
   - `OPENROUTER_API_KEY` — without it every parse and every question falls
     back to "check the Inbox".
   - `TWELVEDATA_API_KEY` — without it the nightly price refresh fetches
     nothing and holdings quietly stop moving.

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform;
   do not set those by hand.
6. **Redeploy the Edge Functions** from git, then prove it:
   `npm run verify:functions`. Do not assume a deploy landed. Deploying from a
   checkout applies `supabase/config.toml`, which is what keeps
   `telegram-webhook` on `verify_jwt = false`; deploying it any other way gives
   Telegram a gateway 401 on every call.
7. **Retarget the scheduled jobs.** The migrations create all three, with the
   URL of whichever project built them — so after a restore they call the OLD
   project using the NEW project's credentials, nightly, and cron reports a
   successful dispatch every time.

   ```sql
   select schedule_all_jobs('https://<new-project-ref>.supabase.co');
   ```

   Then check it, rather than assuming:

   ```bash
   psql -v base_url="https://$NEW_PROJECT_REF.supabase.co" \
        -f scripts/verify-cron-targets.sql "$NEW_PROJECT_URL"
   ```

   That fails on a job that is missing, inactive, aimed at another project, or
   no longer carrying the authentication its endpoint requires.
8. **Reconcile the migration history.** Applying the migrations with `psql`
   populates the schema and leaves `supabase_migrations.schema_migrations`
   empty, so the CLI believes nothing has been applied and
   `npm run compare:migrations` reads every migration as pending. Mark them
   applied without re-running them:

   `migration repair` takes a connection, not a project ref. `$NEW_DB_URL` is
   the new project's connection string -- the same one §3 uses.

   ```bash
   for f in supabase/migrations/*.sql; do
     supabase migration repair --status applied "$(basename "$f" | cut -d_ -f1)" \
       --db-url "$NEW_DB_URL"
   done
   ```

9. **Repoint the frontend** at the new project ref and publishable key
   (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) in both hosts'
   settings, and rebuild. `npm run verify:build` catches the build that
   silently ships no application at all when these are missing.
10. **Run the release check against the new project**:

    Set **both**. `verify:release` prefers `SUPABASE_DB_URL`, so a recovery
    shell that still holds the old one would read the OLD project's ledger and
    label the result with the new project's ref -- a recovery reporting success
    against the database it was replacing. The exporter now refuses when the
    two disagree, but the reason it could happen is that only one was ever set
    here.

    ```bash
    SUPABASE_DB_URL=$NEW_DB_URL \
    SUPABASE_PROJECT_REF=$NEW_PROJECT_REF \
      npm run verify:release
    ```

    This exports the new project's migration ledger fresh and requires every
    migration in this commit to be applied, every function declared in
    `config.toml` to be live and serving, and each one's `verify_jwt` to match.
    It replaces the old step 6, which re-ran `compare:migrations` against the
    *committed* snapshot file and so could not see the new project at all.

### Then rehearse the four things rows cannot prove

A matching fingerprint says the data came back. Each of these is a separate
claim, and each one has its own way of failing silently.

- [ ] **Sign in.** Not "the user row is present" — actually authenticate as the
      owner, in the rebuilt frontend, and land on a household with its data.
      This is the one the fingerprint genuinely cannot settle, since
      `auth.identities` may or may not be required for GoTrue to complete a
      password login.
- [ ] **Open a receipt.** Find the intake row with a `photo_path` and view the
      image through the app. A restored path pointing at a file that was never
      copied looks exactly like a working restore until someone clicks it.
- [ ] **Talk to the bot.** Send an expense from the linked Telegram account and
      confirm it records. This exercises the webhook secret, the bot token, the
      OpenRouter key and the function deployment in one message.
- [ ] **Watch a scheduled run.** Wait for (or trigger) one nightly job and read
      the function's logs, not `cron.job`. A successful pg_cron dispatch says
      the request left; it says nothing about what answered.

Until all four have been done once in a replacement project, the honest
statement is "the data restores", not "we can recover". Accepting an untested
cutover is a reasonable risk to take deliberately — it was not reasonable while
the omissions above were unknown.

## 6. What would make this stronger

Nothing below is required to run the drill; all of it is worth doing once the
drill has been run at least once.

- Automate the export on a schedule, to storage outside this Supabase account,
  and alert when one does not appear. An unmonitored backup job is a backup job
  that stopped some time ago.
- Find a way for the scheduled jobs to learn their own project URL. Postgres
  exposes nothing carrying the project ref, so `schedule_all_jobs()` takes it
  as an argument and a replay still seeds the URL of whatever project built the
  migration. One call fixes it and one script checks it, which is a long way
  from where this was — but a job that could not be aimed wrongly would be
  better than one that is checked.
- Keep the fingerprint from each export. A silently emptying table shows up as
  a shrinking row count long before anyone notices in the app.
- Re-run the drill on a calendar, not on alarm. The first time a restore is
  attempted should never be the day it is needed.
