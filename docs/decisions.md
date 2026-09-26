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

## A household is a boundary the database enforces, not one the app remembers

Every reference from one household-scoped row to another carries `household_id`
through a composite foreign key, against a `unique (household_id, id)` on the
parent. A transaction in one household cannot point at another household's
account, category or member — the database refuses the write, whoever makes it.

This replaced 21 plain single-column foreign keys. Each of those proved the
referenced row *existed* and said nothing about whose it was, and row-level
security did not cover the gap: the policies test the row's own `household_id`,
so a row with a correct `household_id` and a foreign `account_id` satisfied
them. Until this landed, the only thing keeping the ledger clean was
application code getting it right every time.

The 10 September QA pass ran 25 integrity checks against production and found
nothing wrong. That was true and nearly uninformative: production holds one
household, so no cross-household check in that list *could* fail. The
regression suite now builds a second household specifically so those checks can
fail, and asserts they don't.

Two mechanics this depends on, both easy to get wrong:

- **MATCH SIMPLE** (the default) is what keeps optional references optional. A
  composite key with any NULL column is not checked, so an unset `category_id`
  still means unset. `MATCH FULL` would demand all-or-nothing across the pair
  and break every optional reference.
- **`ON DELETE SET NULL (column)`** — with the column list — is required. A bare
  `SET NULL` nulls every column in the key including `household_id`, which is
  `NOT NULL`, so removing a member would fail outright instead of clearing the
  owner. Needs PostgreSQL 15 or newer.

`approve_intake()` also checks its three id parameters against the intake row's
household before writing. The constraints already make a cross-household
approval impossible; the function's checks exist so the caller gets a sentence
naming the offending parameter rather than a foreign-key violation naming a
constraint.

Not yet covered: `transaction_edits` holds no `household_id` of its own, so its
`edited_by` and `transaction_id` could in principle disagree. Constraining it
needs a column added first, which is its own change.

## Budget totals are built from the rows they sit under

The Budget screen groups spending by top-level category, and a group row counts
everything spent in that group: its subcategories and anything posted to the
parent itself (`rollupActualsByGroup`). Every total on the screen is built from
those same group figures (`budgetGroupSpend`), so the month hero, the rows, the
footer and the year view all read one month identically, and each adds up:

- **Budgeted subtotal** is the sum of the group rows.
- **Outside budget** is everything else, including uncategorised spending.
- **Budgeted subtotal + outside budget = all spending**, always.
- **Net saved** is income minus *all* spending (QA-09, unchanged).

In the year view, a group with several budgeted subcategories shows each of them
plus an **Other** row for spend none of them holds, so the rows add up to the
group.

Per-category alerts (Telegram budget watch, Overview attention) still judge each
budgeted category on its own spend. That is a narrower question, "is DEWA over
DEWA's budget", and it agrees with the subcategory rows.

## Goals: one derivation, and a monthly figure with no assumed growth

Saved-so-far, status and ETA come from `scopedGoalRows` wherever they appear.
The Plan summary used to derive them separately and left out linked accounts
and holdings, so it disagreed with the Goals tab for any account-funded goal.

The "needs X a month" figure spreads what is left over the whole calendar months
to the target date. It assumes no investment growth: a goal carries no return
assumption, and a monthly figure that quietly counted on one would be a promise
the app cannot keep.

## Forecast figures follow the display currency

Every figure on Forecast is shown in the selected display currency, not only the
hero. A USD hero above AED detail lines read as two different targets. Stored
values stay in AED.

## Other income once working stops

`independence_income` holds money a household expects after it stops working,
other than its own savings: yearly (rent, part-time work) or a one-off sum (an
end-of-service gratuity, a planned sale). Amounts are AED in today's money;
timing counts from the first year of independence, not a calendar year.

- **Drawdown** spends it before the pot each year. Income above the year's
  spending, and every lump sum, goes into the pot.
- **The independence target** (Forecast, Drawdown, Plan summary, all through
  `independenceTarget`) drops only by yearly income that starts at
  independence and lasts for good. That income does exactly what spending
  less would. A later start, an end date or a lump sum has no honest place in
  a multiple-of-spend target, so those are counted on Drawdown and Forecast
  says how many were left out.
- Amounts are entered after tax. Nothing in the app models tax.

## Savings categories are targets, not spending

`categories.is_savings` marks an expense category that holds money set aside
rather than spent (a household's "Savings & Investments", say).

- **Its budget is a savings target.** The Budget screen shows it apart from the
  spending budget, against what the month actually saved: income less all
  spending, the same net saved shown everywhere else. It is never part of the
  budgeted subtotal, so a savings allocation cannot make a month look
  underspent.
- **Nothing is filed under it as spending.** The transaction, recurring, Inbox
  and rule pickers leave savings categories out, as do the Telegram bot's
  category lists (expense capture, parsing, category spend and budget status).
  A record already filed there keeps showing its category rather than silently
  losing it.
- Transaction arithmetic is unchanged: spend and income are still decided by
  `transactionKind.js` alone, in the app and the bot alike.
