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

## Life plan: one timeline, from today to the last life expectancy

An adviser's "cash adequacy" sheet answers one question: does the money last?
Forecast and Drawdown each answered half of it, and goals sat on a screen of
their own. The Life plan tab puts them on one timeline (`lib/lifePlan.js`).

- **One formula for every year.** While working, the pot grows at the real
  return and the year's saving is added at the end, exactly as Forecast
  projects. Once work stops, spending comes out at the start of the year, other
  income first, exactly as in Drawdown. A goal is paid at the start of its
  year. The pot never goes below zero, and the first year it cannot pay is the
  year the plan runs out. The adviser's sheets computed some years differently
  from their neighbours; a single loop cannot.
- **Ages are per member** (`member_life`: birth year, age to plan to), kept
  apart from `household_members`, which carries roles and ownership guards. A
  person is planned for to the end of the year they reach that age; the plan
  ends when the last of them does.
- **Stopping work is a year**, saved as `planning_assumptions.retirement_year`.
  The screen's stepper is a what-if until "Make this the plan". Until a year
  is saved, 60 is assumed and the screen says so.
- **After work stops:** spending (`retirement_annual_spend`, today's money),
  the return (`retirement_return_pct`, which moves with the scenario) and
  spending once one person remains (`survivor_spend_pct`) are optional. Blank
  means the same as now.
- **Goals:** a dated goal is paid out of the pot in its year, and its target is
  taken as the cost on that date, brought back to today's money.
  `goals.counts_in_life_plan` marks a goal that is money kept rather than spent,
  such as an emergency fund. Undated goals are listed but not on the timeline.
- **What it would take** gives three levers: the earliest year work could stop,
  extra saving a month, and the most that could be spent. When a goal falls
  short while still working, stopping later does not help, so the screen names
  the goal and the gap instead.
- **Today's money by default.** "Future money" shows the same figures grown at
  the scenario's inflation, the way an adviser's sheets show them.
- The maths reproduces the adviser's retirement corpus to the rupee (a test
  pins it). Not yet modelled: a separate inflation rate per goal, dated changes
  to cash flow such as a loan ending, and tax.

## A budget stands in for spending history, until three months close

Forecast, Drawdown and the Plan summary estimate a year's spending from the
average of at least three closed months. A household that has only just
started recording has none, and saw "Not enough to project" on all three for
months.

- **Until three months close, the budget stands in** (`budgetPlan`,
  `forecastInputs`). Spending is the monthly spending budget, not counting
  savings categories. Saving is the savings target. Both are averaged over the
  budgeted months from this one forward, up to a year out, or else the latest
  twelve budgeted months.
- **It is the household's own stated plan, not a figure the app made up**,
  which is the line the empty state has always held. Every screen that uses it
  says so, in the same note (`BudgetBasis`), and the Plan summary card adds
  "from your budget".
- **It steps aside on its own.** Once the third month closes, recorded spending
  is used and the note goes away.
- A budget has no income in it, so income is taken as spending plus the savings
  target. Nothing else reads it.

## Drawdown tests a market fall, early or late

A steady return every year hides the biggest risk to a pot being spent: a
fall in the first years, when selling to live locks the loss in. Drawdown
offers one fall, not a simulation.

- **The fall.** −20% then −10% real, in two consecutive years, and the
  scenario's steady real return every other year (`MARKET_FALL`,
  `marketReturns`). It is roughly what a mix of investments and cash lost
  after inflation in a stretch like 2008. It is illustrative, not a forecast,
  and the screen says so.
- **Year 1 against year 10.** The two choices are the same set of returns in
  a different order, so any difference between them is sequence risk and
  nothing else. A comparison row shows all three outcomes, and picking one
  sets the rest of the screen.
- **Everything follows the choice:** how long the pot lasts, the KPIs, and
  "Make it last", which then answers what spending survives that fall. With a
  fall, the solvers use bisection on `drawdownPath` itself, since the
  closed-form annuity only holds for a steady return.
- No Monte Carlo. Random runs would give a probability that looks precise
  but rests on a guessed distribution. One named, repeatable fall is easier to
  reason about and to check.

## Edge Functions pin their Supabase imports to an exact version

All three Edge Functions import `jsr:@supabase/supabase-js@2.117.2` and
`jsr:@supabase/functions-js@2.117.2`, not `@2` or an unversioned
specifier.

- **Why.** Deno will not resolve a package published less than 24 hours ago.
  Supabase publishes each release to JSR about two minutes before its npm
  dependencies (`@supabase/auth-js` and the rest). With `@2`, a `deno check`
  that runs inside that window takes the new JSR release, then cannot resolve
  its npm dependencies. That broke main's CI for #47: the check ran 24h 0m 22s
  after `supabase-js` 2.117.2 reached JSR and 1m 40s too early for `auth-js`.
  An exact version resolves the same way every time.
- **What it costs.** A new Supabase release is no longer picked up by the next
  deploy on its own. To take one, change the version in all three
  `index.ts` files together. Keep the two packages on the same version, and
  wait until the release is more than a day old.
- The age check itself stays on. It is a supply-chain guard, and turning it
  off to get green would trade a real protection for a timing race.
