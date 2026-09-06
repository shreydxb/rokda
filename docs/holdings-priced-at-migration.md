# holdings.last_refreshed → priced_at (SHR-254)

## Why this needed a second look

`20260905181000_holding_valuation_dates.sql` originally did:

```sql
alter table holdings rename column last_refreshed to priced_at;
```

That is not deployable on its own. The live inventory (read-only, checked
during the SHR-254 QA recheck) still shows `holdings.last_refreshed` and no
`priced_at` — this migration has not been applied yet, and there is a
currently-deployed client (the pre-`9bd6a59` holdings editor) that reads and
writes `last_refreshed`. Whichever of "apply the rename" or "deploy the new
client" happens first, the other breaks immediately:

- Rename first → the old client's writes to `last_refreshed` fail (column
  doesn't exist).
- New client first → it writes `priced_at`, which doesn't exist until the
  migration runs, and the old client never sees those values in
  `last_refreshed`.

## What changed instead

The migration is now purely additive:

1. `priced_at` is **added** alongside `last_refreshed` (not renamed).
2. Existing rows are backfilled: `priced_at = last_refreshed` wherever
   `last_refreshed` is set.
3. A `before insert or update` trigger (`holdings_sync_priced_at`) keeps the
   two columns equal from then on, regardless of which one a given writer
   touches: if a write changes `priced_at`, `last_refreshed` is copied to
   match, and vice versa.

This makes the migration safe to apply independently of the client deploy,
in either order, and safe with both the old and the new client running at
the same time (e.g. during a rollout, or if a rollback is needed).

## Deployment order

1. **Apply this migration first**, on its own. It adds a column, backfills
   it, and adds a trigger — no existing column is renamed or dropped, so
   the currently-deployed (old) client keeps working exactly as before.
2. **Deploy the new client** (this repository's holdings editor, which
   reads/writes `priced_at`). The old client, if anything is still running
   it, keeps reading/writing `last_refreshed`; the trigger keeps both
   columns showing the same value no matter which client wrote last.
3. **Once every client writes `priced_at`** (confirmed the old client is no
   longer deployed anywhere), a follow-up migration can drop
   `last_refreshed` and the trigger. That migration is deliberately **not**
   included yet — dropping a column is a one-way decision that shouldn't be
   bundled into the migration that makes the transition possible; write it
   as its own step when step 2 is confirmed complete.

## Rollback

- **Rolling back the client** (steps 2 → 1): safe at any point. The old
  client keeps writing `last_refreshed`; the trigger keeps `priced_at` in
  sync in case anything already reads it. No data is lost either way.
- **Rolling back the migration itself**, before the follow-up drop migration
  exists: drop the trigger and function
  (`drop trigger holdings_sync_priced_at_trigger on holdings; drop function
  holdings_sync_priced_at();`) and optionally drop the `priced_at` column.
  Because `last_refreshed` was never touched (only added to), the old
  client's data path is completely unaffected — this rollback loses nothing
  it didn't already have.
- **Rolling back after the follow-up drop migration** (once written) is
  harder: `last_refreshed` would need to be re-added and backfilled from
  `priced_at`, and any write that happened between the drop and the
  rollback under a reintroduced old client would need the trigger back too.
  This is the reason step 3 is kept as a distinct, deliberate migration
  rather than folded into this one — do not write and apply it until the
  old client is confirmed gone.

## Verified

- `scripts/verify-migrations.sh` builds a fresh database through this
  migration (and everything after it) with no errors.
- `supabase/test/migration-behaviour.test.sql` (SHR-254 section) proves the
  sync trigger works in both directions: writing `last_refreshed` updates
  `priced_at`, and writing `priced_at` updates `last_refreshed`, on the same
  row.
- Not yet verified: an actual two-client rollout (old client + new client
  against the same hosted database at once). That needs the isolated
  Supabase environment described in `docs/environments.md` — no such
  environment exists yet, and provisioning one is a deployment decision
  outside this correction pass.
