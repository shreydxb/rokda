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
client" happens first, the other breaks immediately.

## What changed instead, and a correction to this doc's own earlier claim

The migration is now additive: `priced_at` is added alongside
`last_refreshed` (not renamed), existing rows are backfilled
(`priced_at = last_refreshed` wherever `last_refreshed` is set), and a
`before insert or update` trigger (`holdings_sync_priced_at`) keeps a
genuine new-client valuation also visible to a legacy reader.

**This document previously claimed the migration and the client deploy
could then "land in either order" — that is false, and a 762a6c4 QA recheck
caught it.** The trigger only ever solved compatibility for the *old*
client (which keeps reading/writing `last_refreshed`, untouched by this
migration). It does nothing for the *new* client if the new client deploys
first: this repository's holdings editor sends `priced_at` in every
insert/update **unconditionally**, and if that column doesn't exist yet,
every one of those writes fails outright. The migration must be applied
**before** this client build is deployed — there is no safe "either order"
here, only "migration first."

## This is true of every pending migration, not just this one

At this commit there are five migrations not yet applied anywhere:
`account_archival`, `holding_valuation_dates` (this one),
`account_balance_confirmation`, `intake_atomic_approval`, and
`transactions_kind_refund`. This repository's current client code already
depends on every one of them unconditionally:

| Migration | Column/function the client already assumes exists |
| --- | --- |
| `account_archival` | `accounts.archived_at` (`src/lib/accounts.js`) |
| `holding_valuation_dates` | `holdings.priced_at` (`src/screens/wealth/HoldingEditor.jsx`) |
| `account_balance_confirmation` | `accounts.balance_as_of` (`src/lib/balance.js`) |
| `intake_atomic_approval` | the `approve_intake` RPC (`src/screens/money/Inbox.jsx`) |
| `transactions_kind_refund` | `transactions.kind` (`src/screens/money/TransactionEditor.jsx`, `approve_intake`) |

None of these five is optional or deferrable relative to the client: **all
five must be applied, in filename order, before this repository's build is
deployed anywhere.** Deploying the client against a database that is missing
any of them means every write that touches the missing column/function
fails immediately (a genuine error, not silent corruption — but a full
outage of that feature until the migration lands). This is not a new
constraint this pass invented; it is simply what "the client's code already
uses this" has always implied. It is written down explicitly here because
the earlier "either order" claim for `holding_valuation_dates` specifically
was wrong, and the same reasoning generalises to the other four.

## Deployment order

1. **Apply all five pending migrations, in filename order, before deploying
   this client build.** They are additive (no column is renamed or
   dropped), so applying them changes nothing for the client that is
   currently live (the old holdings editor, pre-`9bd6a59`) — it keeps
   reading/writing `last_refreshed` exactly as before.
2. **Deploy the new client.** It writes `priced_at`, `archived_at`,
   `balance_as_of`, `kind`, and calls `approve_intake` — all of which now
   exist. The old client, if anything is still running it, is unaffected by
   any of this.
3. **Once no client still writes `last_refreshed`**, a follow-up migration
   can drop it (and `holdings_sync_priced_at_trigger`). Not included here —
   dropping a column is a one-way decision that shouldn't be bundled into
   the migration that makes the transition possible; write it as its own
   step once step 2 is confirmed complete everywhere.

## The sync trigger is one-directional, not bidirectional — a second recheck correction

An earlier version of `holdings_sync_priced_at` propagated a write in
**either** direction: touch `last_refreshed`, and `priced_at` followed it,
and vice versa. The 762a6c4 QA recheck caught that this resurrects exactly
the bug SHR-245 fixed: the legacy client writes `last_refreshed` on *every*
save — a rename, its own non-repricing "Refresh" action, anything — because
it cannot tell those apart (that conflation is the whole reason SHR-245
exists). Mirroring every one of those writes onto `priced_at` means a
legacy rename or refresh would falsely certify a stale valuation as current
again, just relocated from one column to the other during the migration
window.

The trigger is now one-directional: a write to `priced_at` (only ever a
genuine, confirmed valuation from the new client) is copied onto
`last_refreshed`, for any legacy reader's benefit. A write to
`last_refreshed` never moves `priced_at`. This means the legacy client's
compatibility is preserved in the sense that matters — its reads and writes
of `last_refreshed` keep working, unmodified — without its writes being
mistaken for a confirmed reprice.

## Rollback

- **Rolling back the client** (step 2 → 1): safe at any point. The old
  client keeps writing `last_refreshed`, unaffected. `priced_at` simply
  stops advancing for holdings nobody edits through the new client, which
  is correct — no confirmed reprice happened.
- **Rolling back a migration itself**, before the follow-up drop migration
  exists: for `holding_valuation_dates`, drop the trigger and function
  (`drop trigger holdings_sync_priced_at_trigger on holdings; drop function
  holdings_sync_priced_at();`) and optionally drop the `priced_at` column.
  Because `last_refreshed` was never touched (only added to), the old
  client's data path is completely unaffected. The other four migrations
  are each independently additive in the same sense (a new column, a new
  RPC) — rolling one back only requires deploying a client build that
  doesn't depend on it, or dropping what it added, whichever is available.
- **Rolling back after a future drop migration** (once written for
  `last_refreshed`) is harder: the column would need to be re-added and
  backfilled from `priced_at`, and the trigger reinstated. This is the
  reason that step is kept as a distinct, deliberate migration rather than
  folded into this one — do not write and apply it until the old client is
  confirmed gone.

## Verified

- `scripts/verify-migrations.sh` builds a fresh database through all five
  pending migrations (and everything before them) with no errors, on local
  PostgreSQL 16.
- `supabase/test/migration-behaviour.test.sql` (SHR-254 section) proves the
  sync trigger's corrected, one-directional behaviour: a legacy write to
  `last_refreshed` leaves `priced_at` untouched; a genuine `priced_at` write
  still updates `last_refreshed` for a legacy reader.
- Not yet verified: an actual two-client rollout (old client + new client
  against the same hosted database at once), and applying these five
  migrations in the stated order against a real hosted project. Both need
  the isolated Supabase environment described in `docs/environments.md` —
  no such environment exists yet, and provisioning one is a deployment
  decision outside this correction pass.
