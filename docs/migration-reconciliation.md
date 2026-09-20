# Migration reconciliation (QA-12 / SHR-253)

## The finding

At 9bd6a59, all 13 local migration version identifiers differed from their
applied counterparts on the live database (`erggbzbbutsvhleqcddq`), despite
matching names. Matching names and columns prove nothing about contents, so the
question "is the repository the same as what is running?" had no answer.

## What was compared

Applied SQL was read **read-only** from `supabase_migrations.schema_migrations`
on the live project. Nothing was applied, reset, or reapplied.

Both sides were normalised the same way — strip SQL comments, lowercase,
collapse whitespace — and fingerprinted. `scripts/compare-migrations.mjs`
does this and is wired into CI.

## The result

**All 13 applied migrations are semantically identical to the repository's.**
The only differences were comments (the repository's files are commented; the
applied statements are not) and the version identifiers themselves. Two
migrations — `planning` and `settings` — matched byte for byte even before
normalisation.

The version drift is explained by how the migrations were applied: the
identifier was assigned at apply time rather than taken from the local
filename, so each applied version is a few minutes off its local one. The
sequence of names is identical on both sides, so the order was never in doubt.

## The reconciliation

The **live database's history is authoritative**: it is what actually ran. The
repository's file contents are authoritative for the SQL, being a superset
(same statements, plus comments).

So the repository's files were renamed to carry the applied version
identifiers, keeping their contents:

| Migration | Was | Now |
| --- | --- | --- |
| baseline_schema | 20260903063800 | 20260903063647 |
| recurring | 20260903090000 | 20260903083752 |
| budgets | 20260903091500 | 20260903084323 |
| intake | 20260903093000 | 20260903085026 |
| net_worth_snapshots | 20260903100000 | 20260903103555 |
| account_credit_card_fields | 20260903101500 | 20260903104347 |
| holdings | 20260903103000 | 20260903104705 |
| planning | 20260903120000 | 20260903115800 |
| debts_original_amount | 20260903120500 | 20260903120014 |
| settings | 20260903130000 | 20260903124126 |
| holding_pricing_fields | 20260905150000 | 20260905151410 |
| household_inr_rate | 20260905153000 | 20260905151910 |
| holdings_commodity_class | 20260905160000 | 20260905171120 |

The order of names is unchanged, so nothing about the sequence moves. Nothing
was applied or reapplied to the live database, and no migration was rewritten.

`node scripts/compare-migrations.mjs docs/applied-migrations.json` now reports
zero drift.

## Reproducibility

`scripts/verify-migrations.sh` builds a throwaway database from
`supabase/migrations` alone and fails on the first error.
`supabase/test/platform-shim.sql` supplies the two platform objects the
migrations reference (`auth.users`, `auth.uid()`) so this runs on a plain
PostgreSQL.

Verified locally against PostgreSQL 16.13: 17 migrations applied, 16 public
tables, all 16 with row-level security enabled. CI runs the same against
PostgreSQL 17, plus `supabase/test/migration-behaviour.test.sql`, which asserts
what the new migrations guarantee (an account with transactions cannot be
deleted; approving the same intake row twice yields one transaction; a rejected
row cannot be approved; a duplicate source message cannot be enqueued; closing a
month twice leaves one point; two valuations give two dated points; new
holdings and accounts start unconfirmed).

## Still outstanding

- The five new migrations in this correction pass are **not applied anywhere**.
  Applying them is a deployment decision and is deliberately not part of this
  handoff.
- Row-level security policies are not exercised by the local harness, which runs
  as a superuser. Verifying RLS, and two-user access, needs a hosted environment
  — see `docs/environments.md`, which records that none is isolated yet.
- `docs/applied-migrations.json` is a snapshot, so it goes stale, and a stale
  one does not fail loudly — it makes live migrations read as "awaiting
  deployment". That is exactly what happened: it covered 43 of 49 applied
  migrations, six deployed migrations printed as pending, and `--strict`
  accepted the run (QA #7). Two things changed as a result.

  Re-exporting is now one command, `npm run export:migrations` (needs
  `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`), and what it writes
  records `exportedAt` and `projectRef` — so the comparison prints how old its
  own evidence is instead of presenting a months-old file as the state of
  production.

  More importantly, the release gate no longer reads this file at all.
  `npm run verify:release` exports the ledger fresh into a temp file and
  compares against that, with `--require-applied` so a migration this commit
  has and the database does not is a failure rather than a note. This file is
  now only the offline, pre-merge comparison — where "pending" is a correct
  answer, because the deploy has not happened yet.

## Fingerprint version (762a6c4 recheck, SHR-253)

`normalise()` has been corrected twice since the snapshot above was taken —
first to stop lowercasing/stripping comment-like text inside string literals
and quoted identifiers, then to recognise dollar-quoted strings (`$$...$$`,
`$tag$...$tag$`) instead of falling through the same lowercase-everything
path. Both fixes changed what a fingerprint is *of*, not just its value: the
underlying SQL in `docs/applied-migrations.json` did not change, but the
hash of the same SQL is no longer comparable between the old and new rules.

The correct response to that is **not** to regenerate the applied side's
fingerprints from the repository's own SQL — that file is a read-only export
from the live database, and recomputing it locally would make the comparison
trivially "equivalent" regardless of what is actually applied there,
defeating the entire point of the check (a prior pass in this correction
series did exactly this, incorrectly; it has been reverted here).

Instead, `scripts/compare-migrations.mjs` now stamps every fingerprint it
computes with a `fingerprintVersion` (currently `2`, exported as
`FINGERPRINT_VERSION`). An applied entry recorded under a different (or
absent — legacy entries have none) version is reported as
`stale-fingerprint`: neither "equivalent" nor "differs", because neither is
actually knowable without re-hashing the original SQL under the current
rules. This is **not** counted as drift (`compare:migrations` still exits 0
for it) — it's a distinct, visible "unverifiable" bucket, currently all 13
already-applied migrations.

**To clear it**: run `npm run export:migrations`. That is
`scripts/export-applied-migrations.mjs`, which runs the export query against
the live database (through the Management API's read-only endpoint, so a
verification step cannot change what it verifies) and fingerprints every entry
with the *current* `fingerprint()` at `fingerprintVersion` 2. It replaced doing
those three steps by hand. Until then, "0 drifting" is
accurate but incomplete — it means no migration both sides can currently be
compared under the same rules shows a difference, not that all 13 have been
freshly re-verified.

**Cleared (81a6bb3 recheck).** A read-only re-export of
`supabase_migrations.schema_migrations` from the live project, fingerprinted
with the current (dollar-quote-aware) `normalise()`, confirmed all 13
already-applied migrations are genuinely equivalent to this repository's —
not merely "not yet found to differ" the way `stale-fingerprint` reports.
`docs/applied-migrations.json` now holds that fresh export
(`fingerprintVersion: 2` on every entry) and `compare:migrations` reports 0
unverifiable.

The next `normalise()` change will make these 13 `stale-fingerprint` again —
that's the design working as intended, not a regression. The same
re-export-and-refingerprint step above clears it each time.

## Strict vs. informational comparison (81a6bb3 recheck, SHR-253)

A green CI run under the plain command only established that nothing
*provably* differed — an unverifiable (`stale-fingerprint`) entry doesn't
fail it. That's an intentional default (an unverifiable entry is real
information, not something to hide behind a red build), but it means "CI is
green" was not by itself sufficient to call the migration comparison
*complete*. `npm run compare:migrations` now runs
`compare-migrations.mjs ... --strict`, which additionally fails (nonzero
exit) on any `stale-fingerprint` entry — so CI now only stays green when
every migration has actually been re-verified under the current rules, not
just not-yet-contradicted. Drop `--strict` for a purely informational run
(e.g. while investigating, before a fresh re-export is available) — it still
reports the same rows, just doesn't fail the process over staleness alone.

## Windows line endings and dollar-quoted literals (81a6bb3 recheck, SHR-253)

`normalise()` preserves everything inside a string/dollar-quoted literal
verbatim — including internal line endings — so it doesn't erase meaningful
content. That is exactly right for content, but line-ending *style* isn't
meaningful SQL: a file checked out with CRLF (Windows' git default,
`core.autocrlf=true`) fingerprints differently from the same file checked
out with LF, even though nothing about the migration actually changed. This
showed up as a false mismatch specifically in dollar-quoted PL/pgSQL
function bodies, which are long enough to make the line-ending style visible
to the tokeniser.

The fix is `.gitattributes`, not the tokeniser: `supabase/migrations/*.sql`
and `scripts/*.mjs` are now pinned to `text eol=lf`, so git always checks
them out with LF regardless of the platform or the user's `core.autocrlf`
setting. Trying to fix this inside `normalise()` instead (e.g. collapsing
`\r\n` to `\n` globally) would risk quietly eating a line-ending difference
that genuinely is part of a literal's content elsewhere — `.gitattributes`
removes the platform variable at its source instead.

## Second reconciliation: six migrations, and "pending" meaning two things (QA re-run, 10 Sep 2026)

The 10 September QA re-run read the comparison output

    38 migrations; 0 drifting, 6 awaiting deployment, 0 unverifiable (applied
    fingerprint predates the current normalise() — re-export needed, …)

as evidence that the migration identity problem had returned. Two separate
things were wrong, and neither was drift.

**The snapshot was incomplete, not stale.** Every one of the 32 entries in
`docs/applied-migrations.json` was already recorded at `fingerprintVersion`
2, so nothing was unverifiable — the count said `0`. The "re-export needed"
parenthetical printed unconditionally as part of the summary string, so a
perfectly clean run still advised a re-export. That wording is why a complete
comparison read as a stale one. The summary now names each state on its own
line and only mentions a re-export when something actually is unverifiable.

**"Awaiting deployment" was covering two unrelated situations.** `compare()`
pairs by name, so the six were reported as `not-applied` purely because the
committed snapshot didn't list them — not because production lacked them. All
six were in fact live:

| migration | repo version | applied version | how it diverged |
| --- | --- | --- | --- |
| `price_refresh_weekday_schedule` | 20260906180000 | *(unrecorded)* | applied, never written to `schema_migrations` |
| `price_refresh_schedule_timeout` | 20260906181700 | *(unrecorded)* | applied, never written to `schema_migrations` |
| `forecast_scenarios` | 20260909100000 | 20260909120108 | applied under a different version id |
| `transaction_confidence` | 20260909110000 | 20260909135324 | applied under a different version id |
| `recurring_interval_count` | 20260909120000 | 20260909140133 | applied under a different version id |
| `budget_alerts_enabled` | 20260910090000 | 20260910155345 | applied under a different version id |

The two `price_refresh` rows were the worse case: their effects were plainly
present in `cron.job` (the weekday schedule and the 120s `pg_net` timeout)
while no ledger row claimed them. A migration whose effects exist but whose
record does not is invisible to every check built on `schema_migrations`.

### What was done

1. The two unrecorded migrations were backfilled into
   `supabase_migrations.schema_migrations` — recording history only; the SQL
   was not re-run, since `cron.job` already showed it had been. Each row's
   stored `statements` was then read back and its md5 compared against the
   repository file to prove the recorded SQL is the applied SQL. (The first
   attempt differed by one byte — an em dash transcribed as `--` — which is
   why the read-back check exists rather than trusting the write.)
2. The four renumbered migrations were renamed in `supabase/migrations` to the
   version ids production actually assigned them. Relative order is unchanged,
   so `verify-migrations.sh` (which globs in filename order) builds the same
   schema.
3. `docs/applied-migrations.json` was extended to all 38 entries, with each
   new fingerprint computed from the **live** `statements` column — never from
   repository SQL, per the rule above.
4. `classify()` now separates the four states a release decision turns on:
   `applied-equivalent`, `version-mismatch`, `drift`, and `pending` (plus
   `unverifiable`). `isDrift()` is unchanged, so CI accepts exactly what it
   accepted before — only the report's wording changed. A migration that is
   live in production can no longer print as "awaiting deployment".

Verified afterwards: 38 migrations, all `applied-equivalent` with matching
version ids. Replaying the pre-fix filenames against the current snapshot
reports 4 × `version-mismatch` and 0 × `pending`, which is the distinction the
QA re-run asked for.
