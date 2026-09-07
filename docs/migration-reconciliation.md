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
- `docs/applied-migrations.json` is a snapshot taken on 2026-09-05. Re-export it
  after any future deployment.

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

**To clear it**: someone with read access to the live database re-runs the
export query in `scripts/compare-migrations.mjs`'s header comment, regenerates
each entry's fingerprint with the *current* `fingerprint()` from that raw SQL,
and adds `"fingerprintVersion": 2` to each entry. Until then, "0 drifting" is
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
