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

- The four new migrations in this correction pass are **not applied anywhere**.
  Applying them is a deployment decision and is deliberately not part of this
  handoff.
- Row-level security policies are not exercised by the local harness, which runs
  as a superuser. Verifying RLS, and two-user access, needs a hosted environment
  — see `docs/environments.md`, which records that none is isolated yet.
- `docs/applied-migrations.json` is a snapshot taken on 2026-09-05. Re-export it
  after any future deployment.
