# Product decisions

Decisions the QA review asked to be made explicitly, so screens and maths can
rely on one answer rather than mixing two.

## Account balances are manual snapshots

A balance is **what a household member last confirmed it to be, as of a date**.
It is not derived from an opening balance plus transactions, and the two models
are never mixed.

Consequences, all implemented:

- `accounts.balance_as_of` records the confirmation. Null means nobody has
  confirmed it: the balance is **unknown**, not zero.
- The account editor asks for the confirmation explicitly, including for a zero
  ("Confirm this balance — including that it is zero"). Editing a name or a due
  day leaves the existing as-of date alone.
- Unconfirmed accounts render as "Balance not set" / "Set balance" rather than
  as AED 0, and a credit card cannot say "Nothing owed" until someone says so.
- Net worth is labelled **provisional** while any contributing account is
  unconfirmed, and Overview's headline cannot read "All caught up" in that
  state — the gap appears in the attention list instead.
- A confirmation older than 45 days is shown as stale. Stale is not unset: the
  figure is still a stated fact, just an ageing one.

Transactions remain the record of what happened; they do not move a balance.
Changing that would be a different product, and would need its own decision.

## Holding valuations are dated, and only confirmed valuations are fresh

`holdings.priced_at` is the date a stored value is a valuation *as of*.
`updated_at` is when the record was last edited. Reloading the Investments
screen changes neither; renaming a holding changes only the second. A holding is
stale until someone confirms a valuation, and confirming one writes a dated
point into `holding_value_history`.

There is no live price or FX feed, and none is a prerequisite for a reliable
manual ledger.

## Closed accounts, not deleted ones

An account with transactions is closed, never deleted — the ledger outlives the
account. Hard deletion stays available only for an account that was never used,
and the `transactions.account_id` foreign key enforces that independently of the
UI.

## Planned versus posted

A transaction dated after today is **planned**. It is excluded from actual
spend, income, averages and the running chart column, and its date is never
rewritten to make that true. Overview reports the newest *posted* record and
says how many records are planned.
