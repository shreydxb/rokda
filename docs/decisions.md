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

## Goals: today's cost, their own inflation, and funding in priority order

A goal years away is easier to state at today's cost, and different goals rise
at different rates. Education and medical costs rise faster than prices in
general, and a UAE goal slower than an Indian one.

- **`goals.cost_today`:** the target is today's cost and grows at
  `goals.inflation_pct` (or the household's general inflation when blank)
  until its date (`goalCostAtDate`). Otherwise the target is already the amount
  on the date, as before. A rate on an amount-on-the-date is refused by the
  database.
- **Progress is measured against the cost on the date**, on Goals and the Plan
  summary alike. Today's price saved is not shown as funded, and the monthly
  figure spreads the grown amount.
- **The Life plan** moves a today's cost by its own rate less general
  inflation, so a goal rising faster than prices costs more of today's money
  each year it waits.
- **Funding in priority order** (`fundInPriority`) is the financial plan's
  view. What each dated goal needs set aside today (its cost on the date,
  discounted at Forecast's expected return) is covered first by money already
  earmarked for that goal. The rest of net worth then covers goals in priority
  order, unnumbered goals last and earliest first; what is left is the top-up.
  It is household-wide, so it shows for Both only. The sum of what is needed
  today is the adviser's "Financial Freedom Number" without retirement, which
  is on the Life plan.

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

## One answer to "when can we stop working"

Forecast and the Plan summary used to answer with the year net worth reaches
25× spending, money that lasts forever. The Life plan answers with the first
year the money lasts to the last life expectancy. For this household that was
2068 against 2058, on three screens that looked like they were asking the same
question.

- **Once ages are set, the Life plan is the answer.** The Plan summary's card
  becomes "Stop working", with the Life plan's earliest year and the ages then,
  and links to the Life plan. Forecast shows the same year above its figures
  and links to it. Before ages are set, both keep the 25× year.
- **Forecast keeps its target** as the stricter comparison, relabelled "Lasts
  forever by": a pot that never shrinks, where the Life plan's may be spent
  down to zero at the end.
- **One basis.** All three screens build the plan with `lifePlanBasis`, so
  they cannot drift on returns, spending, goals or other income. Forecast runs
  it on the scenario it has selected; the Plan summary on the baseline.

## Forecast leads with the stop year

With ages set, Forecast still opened on the lasts-forever target, with the
Life plan's year in a box below it and a third year, the lean number, beside
the bar. Each was defensible; the reader had to work out which one answered
"when can we stop working" (QA re-review, 17 Oct).

- **The Life plan's year is the headline,** with the ages then, the spending
  after work stops it assumes and how it was chosen (as today, less what
  stops, your plan, essentials only), and the year the money lasts to. The
  first figure under it says whether the plan's own stop year lasts, or the
  year it runs out.
- **The lasts-forever target folds away** under "Other ways to look at the
  plan", with the lean number, the progress bar and the year it is reached,
  and a line on why it is stricter. Nothing is removed. The sections below
  (what it would take, the projection, scenarios) still measure against it,
  and now say "lasts-forever target" rather than "independent by".
- **The Plan summary puts Stop working first,** ahead of goals and debt, and
  names the spending it assumes.
- **Before ages are set, nothing changes:** the independence target is the
  answer, as it was.

## A debt's balance lives in its loan account

Debt payoff kept its own balances, and accounts kept theirs. A loan entered
only on Debt payoff never reached net worth; one entered in both drifted
apart.

- **`debts.account_id`** links a debt to a loan or credit card account in the
  same household (tenant foreign key, one debt per account, a trigger refusing
  asset accounts). Deleting the account unlinks the debt rather than deleting
  it.
- **The account's balance is the amount owed.** Debt payoff and the Plan
  summary read it (`debtsWithAccounts`). A new balance entered on the debt is
  written to the account and dates its confirmation. An account in another
  currency is updated in Wealth, where its currency is.
- **A new debt creates its loan account by default**, so net worth counts it
  from the start. "Not linked" is still offered, and such a debt is marked
  "not in net worth".
- The debt keeps what an account has no place for: the rate, the minimum
  payment and the original amount.

## Reminders that end, and reminders in rupees

- **`recurring.ends_on`** is the last date a schedule falls on (the last EMI,
  premium or deposit). Nothing after it is shown, totalled, flagged as missing
  on Overview, or nudged by the bot.
- **`amount` stays AED.** A schedule set in INR or USD keeps its own figure in
  `native_amount`, and a trigger computes `amount` from it: the peg for USD,
  `households.inr_per_aed` for INR. When the rate changes, the INR rows follow
  it. Every screen and the bot already read `amount` as AED, so none of them
  needed a conversion of their own. A rupee reminder is refused until a rate
  exists, rather than guessed.

## Sums paid in a set year

A policy maturing in 2044 pays in 2044 whatever year work stops, so other
income timed "N years after work stops" cannot place it.

- **`independence_income.in_year`** marks a lump sum paid in a fixed calendar
  year. Its amount is what will be paid then, like a goal's amount on its
  date. `currency` lets any row be in rupees or dollars.
- **Only the Life plan counts it.** The plan runs by calendar year, so it adds
  the sum to the pot at the start of that year, working or not. It converts at
  today's rate and brings the sum back to today's money at the plan's
  inflation. Drawdown and the independence target count only income timed
  from the stop year.
- **The rupee's drift against the dirham is not modelled.** A maturity in 20
  years converted at today's rate probably overstates it in dirhams. The note
  under the plan says so. A currency assumption would be one more guess
  presented as precision.

## Spending after work stops leaves out what will have stopped

Today's spending includes rent and loan instalments. Copied unchanged into
retirement, it pushed the stop year later than the household's own plan
would.

- **`categories.stops_after_work`** marks spending expected to have ended by
  then. The Life plan's editor lists the spending categories with a year's
  spending in each, and hints at names like rent or EMI. It never ticks them
  by default: which home will be owned is the household's call.
- **"Less what stops" becomes the default** spending after work stops,
  whenever something is marked. It is today's spending on the same basis
  (budget or closed months) less those categories, and the screen names what
  it left out. A figure saved in the plan still wins.

## Drawdown is the Life plan's stress test

Drawdown and the Life plan both answered "does the money last", from
different starting points. Drawdown started from the 25× target, ran for 40
years whatever the ages, and could not see goals or policy maturities.

- **Once ages are set, Drawdown starts where the Life plan leaves off**
  (`lifePlanHandover`). It takes the pot on the day work stops, the plan's
  spending after, and the years to the plan's end. It also takes the plan's
  other income from that year, with a policy maturing after the stop as a lump
  sum in its year. It uses the scenario Drawdown has selected.
- **What stays Drawdown's own:** the market fall early or late, the return
  after independence, and "Make it last". They answer how much room the plan
  has, which the Life plan does not.
- The target and "stopping today" stay as choices. Spending for one, and goals
  after the stop, are counted only on the Life plan, and the screen says so.

## Goals shows one monthly figure

Goals said a goal needed its whole remainder spread over the months left,
with no growth, while the priority table below said the same goal was already
covered by other savings. Both were called a monthly need.

- **For the household, the monthly figure is the priority plan's.** It is the
  top-up still missing after what is set aside and the rest of net worth cover
  goals in priority order, saved each month to the goal's date at the
  expected return. Valued today, those payments equal the top-up exactly. The
  summary, each goal and the table's "Or a month" column all show it.
- **For one person it stays the plain remainder over the months left.** Net
  worth is not split by person, so there is no priority plan to take it from.

## Salary arrives on a moving date

Payday moves with bank holidays and payroll cut-offs, sometimes into the next
month.

- **Income gets a wider window.** An expected-income reminder counts as
  received within 10 days either side of its date (`matchWindowDays`).
  Bills keep 5 days. Until the window has passed, income shows as
  "Expected", not "Late". Overview only calls it missing, and the bot only
  nudges, after that.
- **A salary counts in the month it is for.** Say an income transaction
  matches an expected-income reminder: same account and category where the
  reminder names them, amount within 20%, and inside the window of one of
  its dates. It is then counted in the month of that date
  (`payMonthTransactions`), not the day it landed. A salary paid on 1 Oct
  for 30 Sep counts in September. Otherwise one month would show no salary
  and the next two, which swings every average built on a few closed
  months.

## One assumptions bar for the planning views

Forecast, Life plan and Drawdown each placed the scenario, today's or
future money, growth and spending differently, and called them different
things ("Nominal" on one, "Future money" on another). The reader had to
reread each tab to know what it assumed (QA re-review, 17 Oct).

- **The same bar, first, on all three:** Scenario, Show, Growth, Spending,
  then one line saying which assumptions are the household's saved ones and
  which scenario is a look for now. Edit assumptions is on every one.
- **Shared means shared.** Return, inflation and the withdrawal rate are the
  household's saved assumptions; the bar on each view shows the same figures
  and edits the same row.
- **A scenario follows you between the tabs.** Picked on any of the three, it
  holds on the others until changed, and is never saved. So does today's or
  future money; Drawdown, which is today's money only, says so in the same
  place.
- **Each view's own controls stay with it:** the Life plan's stop year,
  Drawdown's starting pot, markets and return after independence. Spending
  moves into the bar on all three, because it is what each figure rests on.

## Statements read card by card, figures first

The statements page was one long list mixing every card's statements, each
row a name and up to five lines of small grey text, with the buttons in a
column on the right that moved from row to row and stacked when there were
two. The comparison that decides a statement was a sentence, and a card's
statements to check looked like its settled ones (SHR-338).

- **One section per card,** saying when it closes and is due. What is still
  to check comes first; what is settled folds under "Checked", so a card
  with nothing to do takes a line.
- **Three figures, side by side:** in Rokda, on the statement ("Not entered"
  until it is), and the difference, in words and colour ("AED 0.01 lower in
  Rokda", "Matches").
- **Buttons in one place:** a row under the figures, the action that settles
  the statement first, its transactions next, and "Reopen…" last and quiet.
- **Nothing about the checking changed:** the same statuses, notes, bot
  prompts and records.

## The monthly review ends in what to do next

The review made a month's records right and closed it, then stopped. Nothing
said what the month meant for the plan, or what to do about it, so the review
was something to admire rather than act on (SHR-301).

- **One next step, first.** The first check still holding the month up, with
  its link; once they are all done, the first action. A check settled on
  another page leaves a "Back to the review" link there, carried in the
  address (`reviewing=YYYY-MM`), so the next check is one tap away.
- **What goes into history, before it goes.** Income, spending, saving and
  its rate, and the net worth a close would record against the last month
  closed. A close records today's balances, so the figure is today's, and it
  says so; open checks are named as a reason the figures may still move. Once
  closed, the figure is the one recorded.
- **A few actions, most pressing first, worked out from the records:** bills
  due in the next 30 days that pay expected and the current and savings
  accounts won't cover, goals behind the pace their date needs, spending over
  its budget, saving short of its target. Each goes once it no longer
  applies, so nothing is stored. Stale balances aren't repeated here: they
  are a check, and the next step names them.
- **Not yet:** explaining the net-worth change by contributions, markets and
  FX needs SHR-232's ledger first; accepting a new plan baseline and a
  Telegram summary are left for later.


## A phone opens on the page, not the controls

A layout audit at 390px (21 Oct) found the phone header taking about a third
of the first screen: the nav, then the household and currency switches,
light mode, the login and the build. Overview's title counted the decisions
waiting, but they sat under the figures and the chart, about 1,000px down.
Budget's Pace column ran past the margin, and the holdings table scrolled
sideways with value and profit off the screen.

- **The controls fold behind one button** that says what is chosen ("Both ·
  AED ▾"). It opens the household and currency switches, light mode,
  sign-out and the build, and closes when a page is picked. The bar with the
  nav stays pinned to the top, now with the page's ground behind it. On a
  desktop nothing changes.
- **Decisions before the chart.** On a phone, Needs attention comes straight
  after the period's figures; on a desktop it stays beside the chart.
- **Tables fit rather than scroll.** Budget's pace moves under its row, full
  width; the household share's columns may shrink. Each holding becomes two
  lines: name and value, then profit, today's move and every other column,
  labelled and smaller. Nothing is dropped.
- **The skill's app-screen rules were the checklist** (CLAUDE.md), and Rokda's
  own look stayed as it was.

## Recurring and Debt payoff read like Statements

The same audit found both pages placing things the way Statements did before
it was redone. Recurring's amounts sat about 900px from their names, each
status had a line to itself, and "Mark paid" appeared under one row only,
stacked. Debt payoff ended each debt in three unlabelled numbers, and on a
phone squeezed the name to one word a line.

- **Recurring: what needs doing first.** Late bills, then those due soon,
  then the rest by next date; ended schedules fold under "Ended". A late
  bill says when it was due, not only when the next one is.
- **One line of terms, one place for the action.** Name and amount, then the
  status chip with the cadence, dates, owner and autopay, and "Mark paid" in
  a column of its own, kept for every row once one row needs it so the
  amounts line up. The page is capped so the amount sits near its name.
- **Debt payoff: every figure labelled** (owed, rate, minimum); on a phone
  they move under the name. The order sits on the left and "+ Debt" on the
  right, the total owed on its own line.
- **The projection says what it is missing.** "Neither is set" showed even
  with one of the two set; it now names the missing one, and an extra
  payment of 0 counts as not committed.

## Labels and toolbars say one thing one way

The rest of the layout audit: stored values reaching the screen, and every
toolbar built its own way.

- **Account types are words.** One map (`ACCOUNT_TYPE_LABELS` in
  lib/accounts.js) names every type the database allows: "Credit card",
  "Fixed deposit", never "credit_card" or "fd". Net worth, Accounts, the
  account editor and the account pickers all use it, and Accounts groups by
  type in its order, cash-like accounts first. Compounding and the Inbox's
  source get the same treatment, and a card's due day is an ordinal ("1st",
  not "1th").
- **One rule for toolbars.** Filters and view switches on the left; actions
  in a group at the right end, the one "+ Add …" last; every control in a
  toolbar the same 30px height. A button that cannot be pressed looks it.
  "Show closed" was a page tab in a row of buttons; closed accounts now fold
  under "Closed (n)" like ended bills and checked statements.
- **One way to re-read a page.** Investments had Reload beside Refresh
  prices and the page's own Refresh; Reload did what Refresh does and is
  gone. "Nothing to bulk-approve" was a disabled button standing in for a
  sentence; the Inbox now offers bulk approval only when something read
  cleanly.
- **Finished things fold.** The monthly review folds finished checks away so
  what is still open leads. Its label counts them the way the progress line
  does, "Done (3)", with the suggestions that found nothing apart ("Nothing
  to do (2)"); "Checked (5)" under "3 of 5 done" read as everything done.
- **On a phone,** an Activity record is two lines (merchant and amount, then
  date, category, account and owner) and tabs scroll sideways in their row,
  the open one kept in view and the edge faded while more lie beyond it,
  rather than wrapping.
- **Left for a decision:** chips. `design/` draws status chips in capitals;
  most of the app's are sentence case and a few are capitals. They need one
  answer before they are changed.
## One history for linked records

A purchase, its refunds and the two sides of a transfer change together, but
each record's history listed only its own rows. "Why did this refund's
category move?" meant opening the purchase to find out (QA re-review, 17 Oct).

- **The editor's history covers the linked records too:** a refund shows its
  purchase's edits, a purchase its refunds', a transfer both sides. Each line
  names its record when there is more than one.
- **Grouped into saves.** Edits by the same person within a minute are one
  save, which is how a purchase's category change and the refund that
  followed it appear together. Saves are listed newest first.
- **Nothing new in the database.** It reads `transaction_edits` for each
  record. Two gaps are closed in the app: a transfer's change of amount or
  date is now recorded on both sides (`update_transfer` records nothing),
  and so is a record's change of date.
- **"Automatic"** is an edit with no member behind it: the bot, or a member
  since removed (their rows lose the name).

## Fewer rows that say nothing, and a clearer first choice

Three small changes from the QA re-review of 17 October.

- **Forecast's alternatives that change nothing fold away** into "3 make no
  change", which opens. A list of "no change" rows hid the one that moved the
  year.
- **Overview shows five recent records,** not eight, and links to the rest in
  Activity. Overview is a glance; Activity is where records are looked into.
- **The type choice explains itself.** Under Expense, Income, Refund and
  Transfer, one line says what each is for, with an everyday example, and
  what saving it makes. A new expense adds "Moved money between your own
  accounts? Choose Transfer.", the mistake that turned card payments into
  spending. The wording lives in one place (`lib/entryTypes.js`), so the
  transaction and transfer editors say the same.

## Income says when pay is still to come

Overview's Income is what has been recorded so far this period. Pay lands
late in the month, so from the 1st to payday Income read 0, every month, with
nothing to say a salary was on its way.

- **Under Income, the pay still expected:** "Pay expected 25 and 30 Oct ·
  18,000", or "More pay expected…" once some has arrived. It lists each date
  of an expected-income reminder inside the whole month, quarter or year that
  has no income recorded near it, by the same rule a reminder is marked
  received (within its window, amount within 20%).
- **The figure itself does not change.** Income stays what has been recorded;
  adding pay that has not arrived would make "income less spending" and the
  savings rate claim money the household does not have yet.
- **A date past its window is left out:** it is late, not expected, and Needs
  attention already says so.

## A month-end balance check-in over Telegram

Balances are entered by hand and never derived from transactions. Without a
prompt they go stale, and net worth and every plan start from them.

- **On the 1st** (Dubai), the daily job sends each linked member the
  accounts they look after: shared ones, their own, and those of a member
  with no Telegram link, so no account is left unasked. Each line shows what
  is on record and when it was last confirmed. It asks for the closing
  figures, once per household per month (`brief_sends`, kind
  `balance_checkin`). It can be switched off in Settings → Telegram.
- **Any message stating balances proposes them**, on any day
  (`update_account_balances`), and a "yes" saves them (see "The bot asks
  before it changes a balance or a goal" below). A name resolves the way a
  card does in an expense. When two members have an account with the same
  name, "<partner> Bank" picks the partner's and a bare "Bank" picks the
  sender's own. A card or loan is stored as the amount owed. The question
  lists every change with its old figure, so a misread shows before it is
  saved, and anything it could not match is named rather than guessed.
- The question and the answer are written from the figures, not paraphrased
  by the model: they are about a write, and a write is stated exactly.

## Whose cost a category is, and the household share

Two earners on very different salaries, with some costs that are plainly one
person's (his car loan, her family remittance) and the rest the household's.

- **A category belongs to someone or to the household**
  (`categories.owner_member_id`, null for shared). It is set in Settings →
  Categories. A subcategory with no owner of its own follows its group, so
  marking a group as his covers every line under it. The budget shows the
  owner beside each such line.
- **Shared costs are split in proportion to income**, read from the income
  reminders (salaries), so each person gives the same fraction of what they
  earn and keeps the same fraction for themselves. With no income on record
  the split is even. There is no manual override yet. The split follows the
  salaries as they change.
- **The Household share section** on the month's budget shows each person's
  plan (their own lines plus their split of the shared ones, savings
  separately). Below that it shows what each has paid against their part of
  what was spent and the one transfer that evens it up. Paid is spending from
  the person's own accounts and cards. Spending from a joint account counts by
  the split, and uncategorised spending counts as shared. It is always
  household-wide, whatever the Both/Me/Partner scope, because a split is
  between the two people.
- The existing Me/Partner scope still halves shared rows. Scope answers "what
  is mine to look at" while the share answers "who pays what", so the two
  are kept apart.

## The household plan is written down in the app, not the repository

The figures (goals, budgets, owners) live in their tables, but the reasoning
behind them (why this split, why this goal first, what is still open) had no
home except a chat. It goes in **Planning → Notes** (`household_notes`):
titled notes in plain text with light markdown, readable and editable by the
household only. It is not stored in the repository because the repository is
public. Notes are rendered as elements, never as HTML, so a note can hold
anything without it being run as markup.

## A pasted SMS with no date is not dated today

Some bank SMS carry no date. Pasted into the bot days later, each one used to
be dated the day it was pasted, and a "yes" recorded it that way.

- The parser returns a date only when one is written in the message or on
  the receipt ("yesterday" and "on Friday" count). It says where the text
  came from: a bank SMS, a receipt, or something typed.
- **Typed with no date** ("12 coffee") is still today. That is almost always
  when it was spent, and it keeps the one-word confirm.
- **A bank SMS or receipt with no date** is dated the day it was forwarded,
  when Telegram says, or else today. It is marked `date_guessed`, and is
  never offered for a "yes" or bulk approval. The reply says it had no date.
  The Inbox flags the date and opens the editor when Approve is pressed.

## Today is Dubai's day, wherever the code runs

Six forms offered today's date as `new Date().toISOString().slice(0, 10)`,
which is the UTC date: until 04:00 in Dubai it is still yesterday. An
expense, a bill marked paid, an Inbox item with no date, a new reminder, a
new deposit term or a goal contribution entered after midnight was dated a
day early. Fixed deposits accrued to the database's `current_date`, also UTC,
so the nightly run at 03:00 Dubai valued each one as of the day before and
matured it a day late. The bot's answers about bills and spending read the
UTC day too.

- **A day taken from a moment names its zone.** Forms and as-of fields use
  `householdToday()`. The bot hands `householdDay()` to the date helpers it
  shares with the app. The database uses `household_today()`, which is
  `now()` read in Asia/Dubai, for deposit interest and for a transaction
  saved with no date. A stored date such as `occurred_at` is already a
  calendar day and needs no zone.
- **Screens still read the browser's clock** for "this month" and "due soon".
  In Dubai that is the household's day. A member looking from another zone
  sees their own day there, but the dates the forms offer are Dubai's.
- **Price history is dated the Dubai day it was fetched.** The weekday run at
  03:00 Dubai used to be dated the day before. The month-end check-in shows
  the Dubai date a balance was confirmed.

## Rupee balances follow the rate

An account held in rupees keeps its AED value in `balance_aed`, and that was
worked out only when the account was saved. The rupee rate refreshes every
weekday, and holdings and rupee reminders already followed it. Net worth
therefore added rupee accounts, valued at whatever rate applied when each was
last edited, to holdings valued at today's.

- **When a household's rupee rate changes, every rupee account in it is
  re-valued** at the new rate, whether the feed changed it or a person did.
  The trigger re-runs the same calculation that values an account when it is
  saved, so there is one formula. Dollar accounts need nothing, since the peg
  does not move.
- **No rate means no AED value.** If the rate is cleared, rupee accounts show
  as not converted and every total says so. A missing rate is never treated
  as 1:1.
- **Re-valuing is not editing.** It leaves `updated_at` alone.
- **Closed months are not rewritten.** A net-worth snapshot keeps the totals
  it was closed with.
- Converting when read, rather than storing the AED figure, would have meant
  every screen and the bot fetching the rate. All of them already read
  `balance_aed`.

## One household per Rokda, and no sign-ups

Rokda is one household's ledger. Its logins are made by hand in the Supabase
dashboard (Authentication → Users → Add user), and new sign-ups are switched
off there (Authentication → Sign In / Providers → "Allow new users to sign
up"). The publishable key ships in every build, so with sign-ups on, anyone
could have made a login with it.

A login alone could not read the household's records, but it could call
`create_household()`, the way the first owner founds an empty database, and
get a household of its own to write into. That function now founds the
household only when there is none: once any household exists it refuses
everyone, and it still refuses someone who already belongs to one. Two first
sign-ins racing on an empty database are serialised, so only one founds it.

People join the existing household the way they already did: an owner adds
them in Settings → Household (as a placeholder until they have a login), and
their login is linked to that member row.

`supabase/config.toml` records `enable_signup = false` and the redirect URLs,
but the hosted project is not known to read its `[auth]` section. The
dashboard is what is live; `docs/environments.md` lists what to check there.

## A reset link asks for a new password before anything else

"Forgot password?" emails a link that signs the person in. It used to do only
that: the link opened the app with the old password still unknown and no way
to set another. It also pointed at `/login` on the host's root, which is
outside the app on GitHub Pages, where Rokda lives under `/rokda/`.

Now the link lands on the app's own root, base path included, and the app
shows **Set a new password** and nothing else until a new password is saved
(`supabase.auth.updateUser`) or the person signs out.

- Recovery starts on supabase-js's `PASSWORD_RECOVERY` event, or as soon as
  the page sees `type=recovery` in the link, so the ledger does not flash
  first.
- It survives a reload of that screen (sessionStorage), and ends only when
  the password is saved or the person signs out. `SIGNED_IN` does not end it:
  supabase-js emits that on every reload and whenever the tab regains focus.
  supabase-js relays auth events to every open tab. A Sign in tab that asked
  for the link shows the screen too when it shares the session ("Keep me
  signed in" on), and saving the password in either tab (`USER_UPDATED`)
  ends it in both and opens the app. For these two events the app reads the
  tab's own session, never the relayed one, and acts only when the event is
  about the user that tab is signed in as. With "Keep me signed in" off each
  tab has a session of its own: a tab with none stays on Sign in, and a tab
  signed in as another member is not moved by someone else's reset.
- It is a prompt, not a lock. The link's session is a real session either
  way; the screen exists so the person leaves with a password they know.
- A link that has expired or was already used signs nobody in. Supabase sends
  the person back with the reason in the address, and Sign in opens on
  **Reset password** saying so, ready to send a new link. The wording is the
  app's own: the description in the address is never shown, because anyone
  can write a link that carries one. The message is gone once anyone signs
  in.
- The redirect has to be on the project's allow-list (Authentication → URL
  Configuration → Redirect URLs), or Supabase silently sends the link to the
  Site URL instead. Both hosts are on it: the Netlify site, which is the main
  address, and the GitHub Pages fallback.

## Membership checks live outside the API schema

Every row-level policy asks one of two questions: is the caller a member of
this household (`is_household_member`), or an owner of it
(`is_household_owner`). Both are SECURITY DEFINER, because they read
`household_members`, which is itself behind RLS. They used to sit in
`public`, the schema the REST API serves, so any signed-in user could call
them as RPCs. That leaked nothing, since they only answer about the caller,
but a definer function in the API schema is one careless edit from leaking
something, and the security advisor flagged it on every run.

They now live in `private`, which the API does not serve, with an empty
`search_path` and fully qualified names. The move left every policy as it
was: a policy stores the function it calls by identity, not by name, so the
policies followed the functions without being rewritten.

Two function bodies call them by name (`generate_telegram_link_code()` and
the roster role guard), so `public` keeps thin wrappers with the old names.
They run with the caller's rights and only pass the question on.

New policies call `private.is_household_member(...)` and
`private.is_household_owner(...)` directly; the behaviour tests refuse a
policy that calls a wrapper. `create_household()` and
`generate_telegram_link_code()` stay in `public` on purpose. They are the
RPCs, and the advisor's note on them is expected.

## A guessed date is set or confirmed before it is approved

An SMS or receipt with no date waits in the Inbox dated the day it was sent
(see above). A backlog pasted in one sitting would all land on that day if it
were approved as read.

- **The queue marks each one** "No date", and the summary counts them.
- **Approve opens the editor** for such an entry. The editor approves it once
  a date has been picked, or "Paid on this day" ticked for the one shown.
  "Approve N confident" leaves these entries out. There is no date picker in
  the review pane itself; the editor is one more click per entry.
- **The database refuses it too.** `approve_intake` takes `p_date_confirmed`
  (default false) and refuses a `date_guessed` entry without it, checking its
  own copy of the entry, so a screen showing an older copy, or a bot "yes",
  cannot record a guess. Only the Inbox editor sends it, and only once a date
  was picked or ticked there; bulk approval and the bot never do.
- The entry keeps `date_guessed` and `parsed_date` as the bot wrote them, a
  record of what it guessed. The transaction carries the day that was
  confirmed. A correction sent to the bot that gives the date clears the flag,
  as it already did.
- This guards against an accident, not against a member: any member can
  edit an intake row, the flag included.

## The Netlify site: headers, deep links, and builds only when the site changes

Until `netlify.toml`, the main address served no security headers and had no
fallback for client-side routes, so opening a link such as `/money` directly
got Netlify's 404. Each published production deploy also costs 15 of the free
plan's monthly credits, and in September they ran out: the site stayed on a
10 September build for three weeks while `main` moved on, and only GitHub
Pages showed the current app.

- **The Content-Security-Policy is a `<meta>` tag in the build**
  (`scripts/csp.mjs`, added by `vite.config.js`), not a Netlify header. GitHub
  Pages cannot send headers, so this is the only way both addresses get it,
  and the browser suite serves the same build, so a policy that blocks
  something the app needs fails the suite. Scripts come only from the app
  itself. The app may connect to, and show images from (receipt photos are
  signed Storage URLs), only the Supabase project it was built against, not
  `*.supabase.co`: after an injected script, a wildcard would
  let the page send data to any project, including one made for the purpose.
  `npm run verify:build` fails a build without the tag.
- **What a meta tag cannot carry is a header** in `netlify.toml`:
  `frame-ancestors 'none'` and `X-Frame-Options` (never framed), `nosniff`,
  a referrer policy, a permissions policy and HSTS. GitHub Pages goes without
  these; it is the fallback, not the main address.
- **Every unknown path serves `index.html`** with status 200, as Pages' 404
  copy already did.
- **Netlify builds only when the site changed** (`scripts/netlify-ignore.sh`):
  the files the site is built from, compared with the last commit Netlify
  built. A merge that changes only migrations, Edge Functions, docs or tests
  builds nothing. Any doubt builds. `[skip netlify]` in a commit message still
  skips a build that would otherwise run, for batching site changes into one
  release.
- **The build checks itself**: `npm run build && npm run verify:build`. A
  build without the Supabase variables used to publish a blank app. Now it
  fails, publishes nothing, costs nothing, and the site keeps the last good
  version.

## Who may run an Edge Function

`price-refresh` and `fd-accrual` were deployed with `verify_jwt = true`, which
proves only that a token was issued by this project. The publishable key's
anonymous role and any login passed that too, and both functions then worked
as the service role: one rewrites every fixed deposit, the other spends the
price feed's daily quota and sets every household's rupee rate.

- **`fd-accrual` runs only for the daily job.** Nothing in the app calls it.
- **`price-refresh` runs for the weekday job or a signed-in household
  member**, since Investments has a Refresh button. A user token is checked
  with the Auth server, not only decoded, and then looked up in
  `household_members`. It answers the browser's CORS preflight without
  doing anything, and its replies carry CORS headers. Before, every request
  was treated as a refresh, and no reply carried the headers a browser needs
  before it lets the page read the answer.
- **How the jobs are recognised** changed with the next section: they used to
  send the vault's `service_role_key`, a legacy JWT, and the functions read
  its role from the claims, trusting `verify_jwt` for the signature.
- **Every shared secret is compared in constant time.** `!==` returns at the
  first differing character, so an endpoint anyone can reach would leak the
  secret a character at a time to someone patient enough to time it. The
  comparison walks the whole expected secret whatever is presented. It
  stays synchronous: a first version hashed both values with
  `crypto.subtle`, whose answer arrives from another thread at an
  unpredictable moment, and the handler test of two concurrent deliveries
  of one update began failing about one run in twenty.

## The nightly jobs carry their own secret

The weekday price refresh and the daily fixed-deposit accrual authenticated
with the vault's `service_role_key`, a legacy JWT. Supabase stopped issuing
legacy keys to projects created or restored from 1 November 2025, and lists
deleting them altogether for late 2026. After that, both jobs would fail every
night, here and in any restored project, and nothing would say so except
balances and prices that stop moving.

- **A secret of their own.** The vault holds `scheduler_secret`, 64 random
  hexadecimal characters. Both jobs send it as `X-Rokda-Scheduler-Secret`,
  read from the vault when the job runs (`get_scheduler_secret()`), so
  rotating it needs no reschedule. Both functions read the same value
  through the same function, with the service-role client they already use,
  and compare it with `secretsMatch`. This is the webhook's pattern.
- **One place, so one value.** The secret is not also an Edge Function
  environment variable. Two copies of one secret can disagree, and the jobs
  then fail every night while each copy looks right.
- **Fails closed.** An unset secret, one shorter than 32 characters, or a
  lookup that fails refuses every scheduled call. An empty header, which is
  what a job sends while the secret is unset, matches nothing. A request
  without the header costs no database lookup.
- **`verify_jwt = false` for both.** The jobs send no JWT, so the gateway
  must not ask for one. Nothing trusts an unverified token instead: the
  functions no longer read claims at all, and `price-refresh` sends a
  member's token to the Auth server, which checks its signature. A request
  that carries the scheduler header is judged on that alone, so a wrong
  secret is refused even beside a valid login.
- **Nobody signed in can read it.** `get_scheduler_secret()` is executable by
  the service role and the database owner only, with an empty `search_path`.
- **The owner makes the value**, in the SQL Editor, from
  `gen_random_uuid()` inside the database, so it never appears in this
  repository, a chat or a terminal. The steps are in
  `docs/backup-restore.md` §5 (a restored project) and the pull request
  that introduced this (production).
- **Deploy checks know the difference between a change and drift.**
  `verify:functions` treats `verify_jwt` disagreeing with `config.toml` as
  drift, which always blocks. A commit that changes `verify_jwt` differs
  from production until it deploys, as a source change does, so the check
  now reads `config.toml` at the base too (main for a branch, the previous
  commit on main). When production still has the base's value, the
  difference is that commit's change: advisory on a branch, waited for on
  main.
- **Still open.** The functions' own database client uses
  `SUPABASE_SERVICE_ROLE_KEY`, which the platform injects. Whether that keeps
  working when legacy keys are deleted is the platform's to settle, and is
  not changed here.

## The bot asks before it changes a balance or a goal

The bot used to write an account balance or a goal contribution the moment
the model read one from a message. One misread figure changed net worth, and
the figure it replaced survived only in the chat. Expenses never had this
problem: they wait in the Inbox, or for a "yes".

- **A proposal, then a yes.** The bot saves what it read (`bot_proposals`)
  and replies with the change: "Bank: AED 9,000.00 → AED 10,000.00", or
  "Record AED 500.00 toward House, dated …". Nothing is written until the
  sender answers that message: "yes" or 👍 saves it, "no" drops it. A bare
  "yes" counts when it is the only thing waiting from the last 20 minutes;
  with an expense or a second proposal also waiting, the bot asks which one
  is meant instead of guessing. A proposal lapses after a day. A figure the
  model read as negative keeps its minus sign in the question, and a card
  or loan stored as negative reads "in credit" rather than "owed", so a
  sign misread cannot look like no change. The bot sets cards and loans
  only as an amount owed; a card in credit is set in the app.
- **Saved once, in one transaction** (`apply_bot_proposal()`, service role
  only). A second "yes" changes nothing more: as a reply to the question at
  any time, or bare within five minutes, it repeats what was saved, so a
  "yes" Telegram delivers twice is not taken for a new message. A 👍 on a
  question already answered changes nothing and says nothing. A bare "no"
  names what it dropped, and counts only when nothing else waits for an
  answer.
- **The question and the saved change match.** A proposal whose question
  did not reach the member is deleted, and Telegram delivers the message
  again; the retry proposes what it reads then, which may differ. A
  question whose message id could not be recorded is withdrawn before the
  retry asks again, so an answer cannot land on a question that no longer
  says what will be saved. A redelivered message never makes a second
  proposal: one already asked about is left alone, and one never asked
  about takes the new reading before it is asked. The one gap is the bot
  stopping between sending a question and recording it; the retry then asks
  again, and the reply to the first question is refused as one the bot no
  longer tracks.
- **Only over the figure the member saw.** Each balance is set only if it
  still holds the figure shown in the question. If someone changed it in the
  app in between, that line is left alone and the reply says what the app
  shows now.
- **Every balance change is kept** (`account_balance_events`), written by a
  trigger on `accounts`, so the app, the debt editor and the bot all record
  one: the old and new figures, the source (app, bot or system) and the
  member. Members can read their household's history; nothing can write or
  edit it through the API. Fixed deposits are left out, because their
  balance is recomputed every day rather than entered.
- Goal contributions confirmed this way keep the Telegram message as their
  delivery key, so a message the bot recorded directly before this change is
  not recorded a second time.

## What came over from the older finance app

Rokda replaced an older household finance app whose design notes set out rules
for money data. Before that app is retired, each rule was checked against
Rokda. Most were already here: a missing rate is unknown, never 1:1; the
household's day is Dubai's; amounts are stored in AED when they are saved,
and saving one without a rate is refused (the app's editor, and
`approve_intake` for the bot); membership is the only authorization; delivered
messages have one effect; the bot asks before it changes a balance or a goal.

Four rules were missing and are adopted in the sections below: a holding's
cost comes from its units, a price is as old as its quote, a month closes on
complete totals, and a savings rate needs income.

Not adopted, deliberately:

- **Soft-deleted transactions.** Rokda records every edit in
  `transaction_edits`, and an account with history cannot be deleted.
- **Typed transfers and category splits.** Wanted, and already their own
  backlog items (SHR-234, SHR-233), not something to copy wholesale.
- **A daily, server-captured net-worth close with publication policies.**
  Built for an automated daily series. Rokda closes a month, by a person; the
  rule that matters, no partial totals in history, is kept below.
- **An immutable audit log for every action, an economic-party model and
  category system codes.** Sized for many people and many households. Rokda is
  one household, and `transaction_edits` and `account_balance_events` keep the
  history that matters to it.

## A holding's cost is its units at their average price

A holding's cost was a fixed AED figure, typed in or worked out at the rupee
rate of the day it was entered, while its value follows today's rate. The gain
on a rupee holding therefore mixed share performance with however far the rate
had moved since.

- **With units and an average price, the cost is worked out, not entered**
  (`holdings_derive_cost`): units × average price in the holding's own
  currency, converted the way its value is. AED as is, USD at the peg, INR at
  the household's current rate. The editor shows "Units × avg price" instead
  of a box the save would overwrite.
- **Rupee holdings follow the rate** (`holdings_follow_inr_rate`), as rupee
  accounts do: when the rate changes, their cost and their value from the last
  price move with it. That is not a reprice, so `priced_at` and the value
  history stay as they are.
- **No rate, no cost.** If the rupee rate is cleared, a rupee holding's cost is
  unknown and its gain is not shown. The value keeps its last figure.
- **Without units, or in a currency Rokda does not convert**, the cost is what
  a person entered, as before.
- The gain shown is now in today's dirhams: what the holdings are worth less
  what they cost, both at today's rate. Currency movement is not counted as
  gain or loss.

## A price is as old as its quote

`priced_at` is how old a holding's value is, and staleness is measured against
it. The price feed used to set it to the moment it ran, so a price the exchange
quoted days earlier (a suspended share, a fund whose NAV had not been
published) looked fresh.

- **The feed writes the provider's quote time into `priced_at`**: the last
  trade time from Yahoo and Twelve Data, CoinGecko's update time, and for a
  fund the NAV's date at the Indian market close.
- **A quote with no usable time leaves `priced_at` where it was.** The price is
  still stored, and the holding keeps ageing rather than looking new. A time
  more than an hour in the future is treated as unusable.
- **When the feed ran is kept separately** in `price_fetched_at`, which is what
  Investments shows as when prices were last refreshed.

## A month closes on complete totals

A closed month is compared against for years. Closing one used to start from
today's totals even when they left something out: an account with no AED value,
or a holding never valued. Confirming those as they stood stored a partial
balance sheet as history.

- **A total with a gap is not offered.** The review names what is missing and
  leaves the figures empty. The month stays open until the gaps are fixed, or
  someone types what it actually closed at.
- **A missing figure is refused, not stored as zero** (`closeRowFor`).
- An account whose balance is unconfirmed is still counted, as zero, and says
  so. That is a figure someone can confirm, not a missing conversion.

## A savings rate needs income

A savings rate is what was kept out of what came in. With nothing coming in, it
is unknown, not 0% and not a large negative percentage. The period figures
already said so; the cash-flow chart's monthly figure now agrees, so no column
shows a rate the headline refuses. Amounts are already in AED when saved, so a
missing exchange rate cannot reach the rate.

## Autopay bills are confirmed, not entered

A bill on autopay, such as a loan instalment taken from a bank account every
month, leaves the account on its own. Nobody types it in, so Rokda waited for an
entry that never came, and the missed-bill nudge, three days late and once only,
asked about a payment that had most likely gone through.

- **The bot asks on the due date** (the daily check, 09:00 Dubai), and every
  morning after, until someone answers or the next due date arrives: "Has it
  been deducted from the account?". It applies to an outgoing bill marked
  autopay that names the account it leaves from. Everyone the bill belongs to
  is asked; the first answer settles it for both.
- **Answers are read generously, and only as whole messages**
  (`applib/autopay.js`): "yes", "paid", "deducted", "done", "it's paid",
  "already paid", "EMI deducted", 👍, ✅ or 👌 record it; "not yet", "no",
  "pending" or 👎 mean ask again tomorrow. Anything with another word in it
  ("paid 40 for lunch") is not an answer, and goes on to be an ordinary
  message. A "not" anywhere makes it "not yet", which is the safe direction:
  a missed confirmation costs another question tomorrow, a wrong one records
  a payment that did not happen.
- **Any of the messages counts.** A reply to, or a reaction on, the first
  question or any morning's reminder, or a bare answer at any time that day,
  as long as nothing else is waiting for an answer. "paid 2,050" records the
  amount given.
- **Recorded once** (`apply_bot_proposal`): one expense on the bill's account
  and category, dated its due date. A second "yes", another member's answer,
  or the bill already logged another way (a pasted bank SMS, the app) records
  nothing more. The bot stops asking as soon as it sees the payment in Rokda,
  however it got there.
- These bills are no longer nudged once, three days late; Needs attention says
  the debit is waiting for its confirmation rather than that it has not
  posted.

## Needs attention shows the most pressing first

Overview listed every open item, and with several holdings or accounts to
look at the list pushed the rest of the page out of sight. It now shows the
four most pressing, with a payment due ahead of a warning and a warning ahead
of something stale, and "Show all N" opens the rest. The count beside the
heading is still the whole number.

## A statement is reconciled, and Rokda records it

Card statements are where Rokda's record of spending is checked against the
bank's: missing entries added, doubles removed, the balance corrected. That
check happened when someone remembered it, and nothing recorded whether it had.

- **One record per card per statement** (`statement_reconciliations`): the
  period it covers, its due date, the statement's own figures when someone
  records them, and a status. *Waiting* until someone checks it; then
  *confirmed* (a member says it is done), *reconciled* (checked line by line
  and the figures agree) or *mismatch* (checked, and they do not).
- **The bot asks from the day after a statement closes**, every morning, until
  it is no longer waiting or the next statement closes. Not on the closing day
  itself: its last day's spending can still post. "done", "reconciled",
  "checked" or a 👍 settle it; "not yet", or "sent" without "checked", asks
  again tomorrow (see "A statement answer belongs to the chat it was asked
  in"). A reply or a
  reaction to any of its questions counts. A bare "done" counts only when
  exactly one statement is waiting and no other question is, and a bare
  "yes" never does: that belongs to the expense and balance questions.
- **The record is the state.** No bot proposal: nothing is applied on a
  "done" except marking the statement, so the question's messages are kept on
  the statement's own row. Members can mark one done from Wealth ->
  Statements too. Nobody can delete one.
- A statement covers the day after the previous close through the closing
  day, as the banks print it ("29 Mar to 28 Apr"), and is due on the first due
  day on or after it closes, so a card paid in full on its statement day is
  due that same day.
- On by default, switched off in Settings -> Telegram like every other nudge.

## The bot categorises from the household's own history

The bot already preferred how the household had categorised a merchant before
over the model's guess, but it read only the latest 200 transactions, and
statement names never matched what people type: "EPPCO SITE 1077" against
"eppco", "NOON MINUTES LLC DUBAI ARE" against "noon minutes". The rules in
Settings -> Categories & rules were used by the Inbox only.

- **A rule wins**, because someone wrote it on purpose. Then the category
  used most for the same merchant across all of history, the most recent on a
  tie (`merchant_category_counts()`, grouped in the database and callable by
  the bot only). Only then the model's guess.
- **Names are compared without what statements add** (`applib/merchants.js`):
  store numbers, the city and country, the legal form, a payment processor's
  prefix. Whole words only, and still one-directional: a shortened name
  inherits from a fuller one, but a brand never inherits from its own
  sub-service ("Careem" is a ride, "Careem Food" is not).

## A screen reads every row, a page at a time

The Supabase API returns at most 1,000 rows per request and says nothing when
it stops there. Screens read whole tables, so a household past 1,000
transactions would have lost its oldest spending from Budget and Insights, and
past 1,000 days of holding prices, its newest. Every source the screens load
is now read a page at a time until a short page comes back
(`src/lib/pagedRead.js`), each query ending in a unique column so the pages
cannot overlap or skip a row. A failed page fails the read; it is never shown
as a shorter list.

## The bot says when an expense is not recorded

"du wifi paid today using marriot card 204.38" went to the Inbox: the parser
named no merchant, and without one the bot does not offer its quick "yes".
Its reply, "Got it — check the Inbox to review", read as if the payment had
been recorded, so it was sent again.

- **The parser is told what a merchant is**: whoever was paid, named even in
  passing and in lower case ("du" in "du wifi paid"). When nobody is named it
  gives a short description of what was paid for ("Flight ticket"), so a
  typed payment is not held back for want of a name.
- **A single expense that is not recorded says so** (`inboxReason`): "Not
  recorded yet: I couldn't tell who was paid, so it's in the Inbox", naming
  what was missing (the amount, who was paid, the card or account, the
  category, an AED amount), or that it looks like one already recorded.

## The bot reads every row, and says when it cannot

The screens were made to read past 1,000 rows (above); the bot was not. It
read each source in one request, so with more than 1,000 transactions its
monthly total, budget alerts and unusual-spend check summed whichever 1,000
came back first, often none of this month's, and its portfolio change read
part of the price history. A failed read came back as no rows, so a database
hiccup was stated as "AED 0 spent" or a net worth with nothing in it.

- **Only the window a figure needs, a page at a time.** A month's total reads
  that month; a category's spend, the months its periods cover; the unusual
  spend check, this month and the six before it. Each is filtered by the
  database and read in pages in a stable order (`applib/pagedRead.js`, the same
  helper as the screens). Accounts, holdings, categories and bills are paged
  too, so nothing depends on them staying small.
- **"Was it paid?" is asked as "is there one".** The daily missed-bill and
  autopay checks used to read a bill's window and look for the payment in
  what came back, which was only the first page. They now ask the database
  whether a record within 20% of the amount exists in the window, so the
  answer doesn't depend on how many other records the window holds (QA,
  17 October).
- **A figure read in part is not stated.** A failed read stops the answer:
  the bot says it could not read the figures and asks to be asked again, and
  does not hand the model anything to phrase. The brief and the monthly
  review keep what they could read and say "couldn't be read just now" on
  the line they could not. Budget alerts, unusual spending and the "did you
  pay this?" nudge skip a household or category whose figures failed, and the
  next morning's run tries again.
- A duplicate check that cannot read leaves the entry in the Inbox rather
  than offering a quick "yes".

## A statement answer belongs to the chat it was asked in

The bot kept only the message ids of its statement questions, and took a reply
or a reaction to any message with one of those ids as an answer. Telegram
numbers messages per chat, so each member's chat has its own message 42: a
"yes" to an expense question in one chat could settle a statement asked about
in the other. A refused write was still answered "marked as reconciled", and
"sent to Claude" ended the reminders before anything had been checked.

- **Each question is kept with its chat and member** (`asked_prompts`). A
  reply or a reaction is an answer only in the chat the question was sent to.
  A bare "done" counts only for statements this member was asked about.
  `asked_message_ids` is no longer used; it is left in place rather than
  dropped. Questions asked before the change are not matched to a chat, so a
  reply to one of those is not taken as an answer; the next morning's
  question is.
- **A question counts once it is tied to its statement.** The daily run saves
  each question's chat and message on the statement after sending it. If that
  save fails (after one retry), or the statement stopped waiting in the
  meantime, the question is deleted from the chat rather than left where
  "done" would settle nothing, and the next morning asks again (QA,
  17 October).
- **Sent is not checked.** "Sent", "uploaded" or "shared" keeps the statement
  waiting: the bot thanks the member and asks again the next morning until
  someone says it is done. "Sent and checked" is done; "sent, not checked" is
  not yet.
- **Thanked only for what was saved.** The bot replies that a statement is
  done only once the write has gone through. If it was refused, the bot says
  so and the statement stays waiting. If someone settled it first, the bot
  says what it is now: done, reconciled, or checked and not matching. A
  member's "done" is recorded as *confirmed*, and the reply says "marked as
  done", not "reconciled": reconciled means the figures were compared.
- If the bot cannot read which statement a message answers, it says so and
  changes nothing, rather than treating the message as something else.

## A statement is compared to the cent

Wealth -> Statements showed Rokda's figure and the statement's with the
whole-number magnitude formatter used for budget bars. A net refund of 50.49
read "50", and totals of 100.01 and 100.02 both read "100" beside a "doesn't
match". A statement marked as not matching had no action at all, and one
marked done by mistake could not be opened again.

- **Signed, to the cent, in AED.** Figures keep their sign (a net refund is
  −50.49) and two decimals, labelled AED, which is how Rokda stores them,
  whatever the display currency. The difference is said in words: "Rokda is
  AED 0.01 lower". Showing a statement in its own currency waits on
  amounts in their own currency (SHR-321).
- **The comparison is spending in the period.** Rokda does not keep a card's
  balance on each day, only the one someone last entered, so it cannot say
  what the card owed at the close. A closing balance recorded from the
  statement is shown as the statement's, not compared.
- **A statement's transactions are listed on its row,** with each line signed
  as the statement prints it (a purchase positive, a refund negative), so a
  difference can be found without leaving the screen.
- **A mismatch is resolved, and anything done can be reopened.** "Resolve…"
  and "Reopen…" ask for an optional reason, kept as the statement's note.
  Resolving records who did it and when, as "Mark done" does; reopening sets
  it waiting again, and the bot asks about it the next morning if it is still
  the card's latest statement. Only the latest reason is kept, not a history.
- A write that changed nothing (the statement changed elsewhere) says so
  rather than reloading as if it had worked.

## updated_at is kept by the database

Fifteen tables have an `updated_at` column, and only `accounts` kept it
(`compute_account_derived_fields`). Elsewhere it moved only when a screen
remembered to send it. The transaction editor never did, so an edited
transaction kept its creation time, and the bot and intake approval never
set it either (SHR-307).

- **Every direct edit sets it** (`touch_updated_at()`, a trigger on each of
  those tables): whatever the client sends, the database's clock decides.
- **A re-valuation is not an edit.** A row changed from inside another
  trigger, such as a rupee bill or holding following the rate, keeps the
  time it had. That is the rule `accounts` already followed.
- Holdings now move it on a price refresh too. Nothing reads it for
  freshness: `priced_at` and `price_fetched_at` say how old a price is.
- A transaction's edit and its history rows (`transaction_edits`) are still
  two writes. The editor says so if the second fails. Making them one write
  is a server function, left for when history needs to be trusted as complete.

The editor's history also compares the signed amount it saves. A refund is
stored positive, but the history diffed it as negative, so saving an
untouched refund recorded "+75 → −75". A change of type (a refund turned into
income) is recorded too, since its amount and sign can stay the same.

## The browser checks run in CI

The Playwright suite (`e2e/`) renders every route and tabbed view on a
desktop and a phone viewport against a stubbed Supabase. It checks for
console errors, raw values such as "NaN" in the page, and sideways scrolling,
plus focus, theme, the Content-Security-Policy and the receipt viewer. It was
only ever run by hand. It now runs on every push and pull request (the
`browser` job), and keeps its screenshots for a week. In CI a failing test is
retried once and reported as flaky if the retry passes; locally there is no
retry.

## Every foreign key has a covering index

The advisor flagged four foreign keys added since the last re-audit, each
`(household_id, member or account)` with no index leading on those columns:
`categories` owner, `household_notes` author, and a statement's account and
closer. Each now has one. Removing a member or an account no longer scans the
whole table to find what to null out or cascade.

A behaviour test now fails on any public foreign key without a non-partial
index whose leading columns are its own, so the next table cannot wait for
the advisor to be noticed. The advisor's "unused index" findings are still
left alone, for the reason given in the SHR-149 re-audit: the tables are too
young and too small for usage statistics to mean anything.

## A month that has not closed says so

Months close by hand, on purpose ("A month closes on complete totals"), and
nothing reminded anyone to do it. Production had no closed month at all, so
Net Worth had no history and never would have from waiting.

Needs attention now lists the month that just ended until it is closed
("September 2026 hasn't been closed"), and opens Wealth, where Net Worth
closes it. It is a warning, after anything due: a payment matters more than
history. Only the newest completed month is asked about. An older month left
open stays open, because asking for a backlog of closes on balances that have
since changed would only invite figures nobody can vouch for. A household with
no open accounts has nothing to close and is not asked.

## The browser checks fail a read and a save

The browser checks only ever saw data that loaded and writes that succeeded,
so nothing showed what a person sees when either fails. The stub can now fail
any table's reads or writes the way PostgREST does, and the checks cover a
failed read on Overview, Wealth and Planning, and a failed save on Statements
and in the transaction editor: each must name what failed, offer "Try again"
or keep the editor open, and never show the empty or saved state in its
place.

Running them found two gaps, both fixed:

- Five sources had no name to fail with, so a failed statements read said
  "Couldn't load statementReconciliations." Every source a screen loads now
  has one, and a unit test fails on a new source without a label.
- Planning's sources were still read in one request each. "A screen reads
  every row, a page at a time" said every source was paged; Planning's now
  are, so goal contributions past 1,000 cannot drop off unseen.

## A backup is recorded, and an old one says so

The household's data has one copy unless someone exports it
(`docs/backup-restore.md`), and the record of when that last happened was a
table in that document, where nobody would notice it going stale (SHR-238).

- **Each export and restore drill is recorded in the app**
  (`backup_records`): what was done, the day, whether it passed, and a note.
  Settings → Backups shows the latest of each and the history. The member who
  recorded it is set by the database, not taken from the client. A record is
  never edited or deleted: a mistake is corrected by recording again.
- **Needs attention says when one is late or failed.** An export is due every
  35 days. With none recorded, or the last passing one older than that, it
  says so; if the newest export failed, it says that, whatever passed before.
  A household with no open accounts is not asked.
- **This is what someone says they did, not a check the app ran.** The export
  itself is still by hand. Automating it, to storage outside this Supabase
  account, needs somewhere to put it and credentials for it, which is a
  decision of its own (SHR-238, item 1).

## Signing in takes a password and a code

Rokda signed in with a password alone. The household's financial records now
need a second factor, as the older finance app required (SHR-312).

- **A code from an authenticator app**, through Supabase Auth's TOTP factors.
  After the password, a member with an authenticator enters its 6-digit code.
  A member without one is shown a QR code (and the key, for an app that
  cannot scan) and confirms it with its first code. An attempt left
  unconfirmed is removed before a new one is offered.
- **Nothing of the household renders until the session has passed** (aal2).
  The gate is the first thing `App` checks, so no screen, and none of the data
  hooks behind them, makes a single read before it. The browser checks
  assert that a password-only session makes no request to the data API at
  all. It comes before a reset link's new password too: Supabase refuses to
  change the password of a member with an authenticator until they have
  entered its code.
- **The database holds the same rule.** Every household policy calls
  `private.is_household_member()` or `private.is_household_owner()`, and both
  require `private.mfa_satisfied()`: the session is aal2. So a password alone
  reads and writes nothing through the API either, including a member's own
  roster row. A member with no authenticator yet was let through at first, so
  nobody was locked out before adding one; the QA re-review (17 October)
  showed that left a new login, or one whose factor had been reset, open to a
  password alone. Nobody needed it: adding an authenticator goes through
  Supabase Auth, which reads no household table, and the app has every member
  add one before it shows anything (`20261017100000_code_always_and_owner_removal`).
- **The check is asked of the server.** Whether a code is needed comes from
  the session's own token and the user as the server has them now, not from a
  copy cached in the tab, so an authenticator the owner has removed is not
  still demanded. If the check fails, nothing is shown and the screen offers
  "Try again".
- **A lost phone:** the owner opens the Supabase dashboard, Authentication →
  Users, opens the member, and deletes their MFA factor. (Or, in the SQL
  editor: `delete from auth.mfa_factors where user_id = '<their user id>';`.)
  The member signs in with their password and adds a new authenticator. Losing
  the owner's own phone needs someone with dashboard access, so keep the key
  shown at setup somewhere safe, or add the same key to a second device.

## The same money reads the same on every screen

A product review (15 October) found views of the same records disagreeing. Each
consumer now uses the arithmetic Overview and Budget already used.

- **Activity's calendar** adds up a day the way the list's summary line adds
  up the whole list (`src/lib/activity.js`): the selected person's share, and
  refunds netted against spend. A shared expense of 100 and a shared refund of
  20 used to read, under Me, as 100 spent and 20 earned on the calendar and 40
  out, nothing in, above it. Both now say 40 spent. A day whose refunds
  outweigh its purchases shows the money back, not income.
- **Posted / Scheduled / All on Activity**, Posted by default. Its totals
  counted records dated next week, which no other screen does; the line says
  how many scheduled records it left out and switches to All on a tap.
- **A person's share is shown, not only used.** Under Me or the partner's
  name, totals counted half of each shared record while rows showed the whole
  amount. Rows keep the whole amount and show the share under it; the summary
  says shared records count half.
- **Top merchants follows the month Insights shows**, counts posted records
  only, and is net of refunds: the same basis as the category figures beside
  it. It ranked all of history, so changing the month changed nothing.
- **Overview converts every figure** to the display currency, as Forecast
  already did, at the rate it shows. Picking USD converted the net worth and
  left income, spend and the chart in AED, so a dirham figure read as dollars.
- **Money, Plan, Goals and Debt payoff stay in AED** and say so when another
  display currency is picked. They show what was recorded or entered in AED,
  and converting past spending properly needs each day's rate, which waits on
  rate history (SHR-321). Overview's conversion uses today's rate for past
  months, as net worth's history already does.

## Links keep their context

The product review (15 October) found summaries linking to a screen's first
tab, or to all of a category's history for a monthly figure. Every tab, and
Activity's filters, now live in the address.

- **Tabs are in the URL** (`/money?tab=recurring`, `/wealth?tab=accounts`)
  on Money, Wealth, Planning and Settings. A link opens the tab it means, and
  Back returns to the tab you came from. Settings used to read its tab from
  navigation state, which a reload lost.
- **Activity's filters are in the URL**: category, date range, search, needs
  review, which dates count, and list or calendar. Back, reload and a
  bookmark land on the same list, and the list keeps its filters around an
  edit. Typing a search replaces the history entry rather than adding one per
  letter.
- **Each summary opens its own records.** Insights' categories, cards and
  merchants open the month on screen. A budget's editor has "See the records"
  for its month and category. Overview's period and chart bars open their
  dates. Needs attention opens what resolves each item: Recurring for a bill
  that hasn't posted, the month's category records for one running high,
  Accounts for a card or an unset balance, Investments for a stale price,
  Backups for a backup.
- **The person and currency are not in the link.** They are the sidebar's
  and already apply on every screen, so a link made under Me opens under Me.
  The monthly review is the exception: it counts the whole household, so its
  links say `who=both` (see "Context survives Back, reload and a save").
- **A category includes its subcategories** in Activity, as Budget rolls them
  up, so a group's budget opens all of the records it counts.
- **A date range has no picker yet.** A link sets it and a chip clears it.
  Choosing dates by hand belongs with the Activity filter layout, which is
  still to be decided.

## Open pages stay fresh

Pages read the household's records when opened and after their own saves, so
an expense the bot logged, or the other member's edit, stayed invisible on an
open page until a reload by hand (product review, 15 October).

- **Read again on return.** When the tab comes back into view, or the browser
  comes back online, a page reads again if what it shows is more than a
  minute old (`src/lib/useSources.js`).
- **Read again every five minutes while in view**, so an open page is never
  more than about five minutes behind. A hidden tab doesn't poll. Supabase
  realtime subscriptions would be quicker, but would need replication set up
  per table and an open socket per tab; five minutes is enough for a ledger
  two people keep.
- **"Loaded 14:32 · Refresh"** at the top of every page says when the page
  last read, and reads again on request. It is the page's read time only: a
  balance keeps its "as of" date and a price its "priced" date, and reading
  again changes neither.
- **Only the first load shows the skeleton.** Every later read, including the
  one after a save, keeps the figures on screen and swaps them when the new
  ones arrive, so an open editor and what has been typed into it are left
  alone. If two reads overlap, only the newer one lands.
- A failed read still keeps what was last shown and says which source failed
  (QA-10), so a refresh that fails never blanks a page.

## Activity's filters

Activity lacked the controls needed to explain a particular total (product
review, 15 October). The layout decisions, made on the household's behalf:

- **One date select, with presets**: All dates, This month, Last month, Last
  90 days, This year, and Custom dates, which shows two date fields. A range
  set by a link that isn't a preset shows by name ("August 2026") in the same
  select. This replaces the chip from "Links keep their context". All dates
  stays the default, so nothing disappears from the list unasked.
- **Two rows.** Search, dates, list or calendar, and Add sit on the first.
  Category, account, type (expenses, income, refunds), Posted / Scheduled /
  All, Needs review and sort sit on the second. On a phone the second row
  folds behind "Filters (n)", which counts the filters set. It starts open
  when a link arrives with one of them set. "Clear filters" resets all of them
  but keeps the view and the sort.
- **The summary splits net spend**: "Net spend AED 40 (purchases 50 less
  refunds 10) · Income AED 0", and names the date range when there is one.
  Gross purchases and net spend are both real figures; the line shows how one
  becomes the other rather than choosing.
- **200 rows at a time**, with "Show 200 more". The totals always cover every
  matching record, not just the rows on screen. A new set of filters starts
  again from the first 200.
- **Dates carry the year** once they aren't this year's. Rows read the stored
  day as a local calendar day, as everything else does (QA-06), instead of
  parsing it as UTC.
- **Not done here:** an amount range and a merchant filter separate from
  search. Search already matches merchant, note and amount; neither seemed
  worth another control yet.

## The dashboard leads with the month and what needs doing

Net worth led Overview and data quality took a screen's height, while the
month's money and the action list came lower (product review, 15 October). The
layout decisions, made on the household's behalf:

- **Order**: the period's figures; the cash-flow chart beside Needs
  attention; the next 30 days; net worth; data quality; categories, recent
  activity and accounts. Net worth is smaller and still says which balances
  it rests on.
- **Each figure against the same days of the period before**: month to date
  on the 15th against the 1st to the 15th of last month, never against a
  whole month. Money moves are shown as a difference in the display currency
  ("▲ 6,855"), not a percentage, because against a month's first quiet days
  an ordinary week reads as +2,000%. The savings rate moves in points.
- **Names say what is counted**: "Net spend" (after refunds) for "Spend", and
  "Income less spending" for "Saved". The headline "On pace to save 60%" read
  as a forecast; it now says "Saved 60% of income so far this month".
- **The chart says what it shows.** Its title names the grouping, since the
  period toggle switches it between months, quarters and years while the
  figures above stay period to date. It shows the figure at the top of its
  scale, marks the running period "so far" and draws it lighter, and a
  period with no records says "no records" instead of drawing nothing, which
  read as a verified zero.
- **Data quality is one line** ("2 of 4 checks need a look") that opens to
  the four checks.
- **Not done:** a cumulative-spend-against-budget view, and a separate net
  cash flow plot. Budget already shows the month against its plan; both can
  follow if the simpler chart proves too little.

## Transfers are neither income nor spending

Moving money between the household's own accounts (paying the card from the
current account, putting money into savings) was recorded as an expense on
one side and income on the other, so it inflated both, and the savings rate
with them (product review, 15 October; SHR-234).

- **A transfer is its own kind**: two transactions, money out of one account
  (negative) and the same money into another (positive), joined by a row in
  `transaction_links`. `transactionKind.js` (and the bot's copy) counts
  neither side as income or spending, so every total that goes through it
  (Overview, Budget, Insights, Activity, the calendar, Forecast, the bot)
  leaves transfers out. Activity says how many it left out.
- **The database keeps the pair whole.** A transfer row always has exactly one
  other side, on a different account, the other way, for the same amount to
  the cent, in the same household. The checks run at commit, so any write path
  (the app, the bot, the SQL editor) that would leave half a transfer, or two
  sides that disagree, is refused. The app writes through functions that
  change both sides at once: `record_transfer`, `update_transfer`,
  `unlink_transfer`, `delete_transfer` and `link_transfer`.
- **Same amount, or it isn't a transfer.** A fee or an exchange difference is
  real money gone, so it is recorded as its own expense rather than hidden as
  a gap between the two sides.
- **Existing records can be joined.** Opening an expense or income whose other
  side is already in the ledger (the same amount the other way on another
  account, within four days) offers "Make these one transfer". Each side keeps
  its date, account, merchant and note; only its type changes, and the change
  is in its edit history. Unlinking reverses it: an expense on the first
  account and income on the second.
- **Editing a transfer edits both sides**: the amount, the day and the note
  are the transfer's. Its accounts stay put; to move one side, unlink it.
  Deleting a transfer deletes both sides.
- **A transfer has no category.** It is neither income nor spending, and it is
  left out of the categorisation figure in data quality.
- **Not yet:** a refund linked to the purchase it reverses, remembering a
  confirmed duplicate (both use `transaction_links`, SHR-234), turning a
  single record into a transfer whose other side was never recorded, and
  transfers from the bot.

## A transaction can be split across categories

A supermarket receipt of 400 groceries and 100 household goods had to be filed
under one of them, so one category read 100 too high and the other 100 too low
in Budget, Insights, Overview's categories and the "running high" check
(SHR-233).

- **One record, several lines.** A split keeps the one transaction (the money
  that left the account, as the bank shows it) and adds lines in
  `transaction_splits`: a category and an amount each, signed like the record.
  The record itself then has no category.
- **The database keeps the lines honest.** A split record has at least two
  lines, one per category, each the same direction as the record, adding up to
  its amount to the cent. A transfer is never split. A record that isn't split
  has no lines. The checks run at commit. `split_transaction` sets the lines
  and, when given, the new total in one call; `unsplit_transaction` goes back
  to one category. Both write the change to the edit history.
- **Every total by category goes through one helper**, `categoryParts` in
  `lib/splits.js` (and the bot's copy). An ordinary record is one part; a
  split record is one part per line. Budget, Insights and its evidence,
  Overview's categories, Forecast's spending by category, the "running high"
  check, the household share and the bot all count the lines. Totals that
  aren't by category (income, net spend, the savings rate) are unchanged: the
  lines add up to the record.
- **Whose spending.** The Me / Partner view still follows the record's owner,
  as before. In the household share, each line's category decides whose
  responsibility it is, so one receipt can be partly shared and partly one
  person's own.
- **Activity** shows a split record once, at its full amount, with its
  categories ("Groceries + Household"). Narrowed to one category, it shows the
  line in that category under the amount, and the summary and calendar count
  only that line.
- **In AED.** Lines are entered in AED, the currency the record is stored in,
  so they can be checked against it to the cent.
- **Not here:** a refund against a split purchase takes one category of its
  own; netting it line by line belongs with refund linking (SHR-234).

## A month is reviewed, then closed

Closing a month was one button under Wealth → Net Worth, and nothing asked
whether the month's records were right before its totals went into history.
Money → Review is the list of what to settle first, in the order it is worth
doing.

- **Worked out, not ticked.** Each check is computed from what is recorded:
  flagged records in the month, records with no category (a transfer has none
  to give, and a split record's are its lines), card statements that closed in
  the month and aren't settled, open accounts whose balance nobody has
  confirmed since the month ended, and whether the month is closed. Fixing
  something anywhere ticks its check off, so nothing extra is stored and no
  migration was needed. The close is the one recorded act, and it is what
  marks the month reviewed.
- **The order is the work's order.** Records first, then statements, then
  balances, then the close, because the close records the balances and the
  balances should be right first. Once a month is closed it no longer asks
  about balances.
- **Suggestions never hold a month up.** Pairs that look like one transfer
  recorded as two (the same amount out of one account and into another within
  a few days) are listed with "Make one transfer", but two records can match
  by chance and there is nowhere to record "not a transfer", so they aren't
  counted in "N of M done" and get no tick. The same goes for an earlier month
  that was never closed: a close records today's totals as the month just
  ended's, so it can't be closed now, and the review says so rather than
  asking for it.
- **The whole household.** A month closes for the household, so the review
  counts both people's records whoever is selected in the sidebar.
- **Statements, by the month they closed in.** A refund often lands on a later
  statement than the purchase it returns (a card refund posts when the shop
  processes it, sometimes weeks later), so the review says so beside an
  unsettled statement rather than treating a difference as an error.
- **Links go where the work is.** Flagged and uncategorised records open
  Activity for the month with that filter ("Uncategorised" is a new category
  filter, `cat=none`). Statements, balances and the close open their Wealth
  tab. Overview's "hasn't been closed" item now opens the review rather than
  Net Worth.
- **Not here:** a recurring bill that didn't arrive in the month (Overview
  already flags it while it is current), and a saved "reviewed" mark separate
  from the close.

## A refund is linked to its purchase

A refund was an island: positive, kind `refund`, netting against spend in
whatever category someone gave it. Nothing said which purchase it returned,
so a refund filed under the wrong category (or none) made one category read
too low, and the purchase looked unreturned (SHR-234).

- **A link, from the purchase to the refund**, in `transaction_links` (kind
  `refund`). A refund returns one purchase; a purchase can have several
  refunds (a partial return, then the rest).
- **Linking files the refund where the money was spent.** `link_refund` gives
  the refund the purchase's category. For a split purchase it gets a line in
  each of the purchase's categories, in proportion, cut to the cent, with the
  largest line taking what is left so the lines add up exactly. Both changes go
  in the refund's history. Unlinking leaves the category as it is, and it can
  be changed like any other.
- **Totals don't change shape.** A refund already nets against spending in its
  own category (`transactionKind.js`), so no total needed a new rule; the link
  only makes sure that category is the right one.
- **The rules hold through every edit, not just the link** (QA re-review,
  17 October). Editing a linked refund's amount is checked against the cap
  as linking is; the purchase is locked for that check, so two refunds
  edited at once are counted together. A linked refund's categories follow
  its purchase's: recategorising or splitting the purchase, or changing the
  refund's amount, sets the refund's allocation again, with the change in its
  history. Filing a linked refund elsewhere on its own is refused; the editor
  shows its category as following the purchase, and unlinking is the way to
  move it.
- **To the cent, not only by category** (QA re-check, 17 October). Checking
  only that a refund's lines were among the purchase's categories let a
  refund of 20 on a 75/25 purchase be re-split 5/15 through the API: the
  total and the categories were right, and each category's spending was
  wrong. One function now works out the allocation; the sync writes it and
  the commit check requires exactly it, so any other split, a single
  category for a split purchase, or a line edited by hand is refused
  (`20261017160000_refund_allocation_exact`). The editor sends only a
  linked refund's amount and leaves its lines to the database, which shares
  them out again; it used to hold the old lines to the new amount, so a
  linked split refund's amount couldn't be changed (QA regression check,
  17 October).
- **A refund counts in the month it arrives**, as the card statement and the
  bank show it. A September purchase refunded in October lowers October's
  spend in that category, not September's, so a closed month never changes
  after the fact.
- **The database keeps it honest**, checked at commit: a refund link joins an
  expense to a refund; the refund is dated on or after the purchase; while
  linked, neither changes type; and a purchase's refunds come to no more than
  it cost, plus 5% for a refund converted at a different exchange rate than
  the purchase was. A refund for a purchase that was never recorded, or that
  can't be told apart, stays unlinked, which is allowed.
- **Suggested, never guessed.** A refund's editor offers up to three earlier
  purchases (within four months) from the same shop or on the same account,
  with enough not yet refunded, the same shop first. A refund that matches
  neither isn't suggested anything, and nothing is linked without someone
  choosing it. A card refund usually lands on the same card, often on a later
  statement; one paid to a replacement card or as store credit won't match by
  account, so the shop's name still finds it.
- **Shown both ways.** Activity labels a linked refund "refund for Shop,
  20 Sept" and its purchase "refunded" or "part refunded"; the purchase's
  editor lists its refunds. The monthly review notes refunds not yet linked,
  without holding the month up.
- **Not here:** remembering a confirmed duplicate pair, and transfers recorded
  from the bot (the rest of SHR-234). The bot records refunds as before; they
  are linked in the app.

## A pair confirmed as two real records stays confirmed

Two records on the same account, at the same shop, for the same amount within
a few days, were flagged only while the second was being entered (the record
editor, the Inbox, the bot). "Both are real" dismissed the warning for that
moment and was forgotten. Nothing looked at records already saved, so a charge
entered twice by two routes (the bot and by hand) stayed counted twice
(SHR-234).

- **The monthly review asks about records already saved.** "Possible
  duplicates" lists pairs in the month: same account, same merchant, same
  direction, same amount to the cent, within three days, never a transfer.
  Each pair offers "Both are real" or "Delete one" (the one recorded later,
  after a second press). This check holds the month up, because unlike a
  transfer suggestion it can always be settled.
- **"Both are real" is remembered** as a `transaction_links` row of kind
  `duplicate_confirmed`, the lower id first so the same pair always makes the
  same row. A confirmed pair is never asked about again. The editor and the
  Inbox save the same row when "Both are real" was pressed for the record being
  entered: the Inbox only if the entry still matches that record when it is
  approved.
- **No migration.** `transaction_links` already allowed the kind, with
  household-scoped policies and foreign keys, when transfers added it.
  Deleting either record removes the row with it.
- **The bot is unchanged.** It checks a new message against what is already
  recorded, before there is a second record to pair with, and sends a likely
  duplicate to the Inbox.

## The bot records transfers

"Paid the card 3,000 from the current account" sent to the bot was captured as
an expense, so it counted as spending until someone changed it in the app
(SHR-234).

- **Proposed, then recorded on a yes.** The bot has a `log_transfer` tool. It
  matches both accounts the way it matches a card named in an expense, and
  only when each names exactly one open account; otherwise it says which one
  it couldn't find and records nothing. The proposal states the amount, both
  accounts and the date, and is recorded by `apply_bot_proposal` on a "yes"
  or 👍, like a goal contribution or a balance. Amounts are AED.
- **Never twice.** A transfer already recorded between the two accounts, for
  the amount, within four days, is not recorded again: confirming in the app
  and on Telegram leaves one transfer.
- **A side already recorded is joined, not copied.** The card payment is often
  in the ledger already, pasted from the bank's SMS as an expense; the money
  arriving on the card may be there as income. Such a record (on the right
  account, the same amount, within four days, not split and linked to nothing)
  becomes that side of the transfer, with the change in its history, and only
  the missing side is added. This is also how a single record becomes a
  transfer whose other side was never recorded.
- **The rules are the transfer rules.** Both sides and the link are checked at
  commit by the transfers migration's triggers, whichever path wrote them.
- **The proposal kinds grew by one**, which meant replacing
  `bot_proposals_kind_check` (`20261016160000_bot_transfers`); nothing else is
  dropped.

## A second member signs in as a member

One member signed in; the other was a placeholder row that owned records and
had Telegram linked but no login (SHR-314).

- **The owner makes the login by hand.** Sign-ups stay closed. The owner adds
  the user in the Supabase dashboard and attaches it to the member row that
  already exists, so everything recorded against that row stays theirs. The
  member then sets their own password through the reset link and enrols an
  authenticator, as two-step sign-in requires. The steps are in
  `docs/second-member.md`, with no names or addresses in the repository.
- **They join as a member, not an owner.** The database already made the
  roster owner-only (`owner_role_authorization`): a member can't add, change or
  remove anyone else, or change any role, their own included. A member can't
  remove themselves either: that took their name off everything recorded as
  theirs, so it is an owner's act (QA re-review, 17 October). Everything else
  is shared, as it is between two people keeping one ledger: every money
  record, account, budget, plan and setting, including the household's name
  and rupee rate.
- **A member links only their own Telegram.** `generate_telegram_link_code`
  checked only that the caller was in the household, so a member could make a
  code for the owner, send it from their own phone, and be treated by the bot
  as the owner. Now the code is for the caller's own row, or the caller is an
  owner (`20261016114323_link_code_self_or_owner`). An owner still links a
  member who has no login, which is how such a member is linked at all.
- **The screen says what the database will refuse.** Settings → Household's
  member editor offered rename, role, remove and "Generate code" to everyone,
  so a member was shown a raw policy error. A member now sees others read-only
  ("Only an owner can change or remove another member"), and edits their own
  name with the role chips disabled.
- **Not here:** an invite email sent from the app. Sign-ups are closed, and a
  two-person household adds a login once; the dashboard steps are enough.

## A payment in rupees keeps both amounts

Money sent home is agreed in rupees and debited in dirhams. A transaction held
only the AED, so the rupee figure went into the note, and every conversion
used the latest rate because `fx_rates` keeps only the latest (SHR-321).

- **AED is still the amount that counts.** `transactions.amount` stays the AED
  every total reads. `transactions.currency` now means the currency the
  payment was made in, as `recurring.currency` already did, and
  `native_amount` is the amount in it, signed the same way. An AED payment has
  none. The database holds the two together: a foreign payment always has its
  own amount, and an AED one never has another.
- **The AED debited, or an estimate that says so.** The statement shows the
  AED that actually left the account, with any card or transfer markup; this
  app can't know that markup. When it isn't known yet, the AED is estimated
  from the rupee amount at the payment date's rate and marked
  `aed_estimated`. Activity shows "INR … · AED estimated" under the amount and
  can filter to such records, and the monthly review asks for the AED debited
  in any month that had a foreign payment. Entering it replaces the estimate.
  A missing rate is never one-for-one: with no rate, the AED debited is
  required.
- **A rate per day.** `fx_rate_history` keeps one rate per day per pair. The
  daily price refresh writes the day's rupee rate, and once fills the days
  before the history began from the ECB's reference rates (rupees per dollar,
  through the dirham's dollar peg). A day without a rate (a weekend, a failed
  refresh) uses the latest one before it. Before history reaches a date,
  today's rate is used and the estimate says it is today's.
- **Dollars convert at the peg** (3.6725), but are still estimates until the
  AED debited is entered, as a card adds its own markup.
- **The Inbox keeps both.** A rupee amount the bot read used to be blanked,
  and the reviewer typed an AED figure with the rupees lost. It now opens with
  the rupee amount and an "AED debited" field; `approve_intake` takes the
  native amount and the estimate flag. The bot says the entry is in rupees and
  that it can be approved with the AED debited or as an estimate.
- **Bills set in rupees are paid in rupees.** Recurring's "Mark paid" opens the
  editor in the bill's own currency.
- **Not here:** a rupee transfer the bot reads ("sent 40k INR home") as a
  transfer between the household's own accounts; it is recorded as an expense
  to the payee, as before, now with both amounts.

## Context survives Back, reload and a save

The QA re-review (17 October) found four places where a screen lost what it
was showing, and one where a failed save looked like a success.

- **The month is in the address** on Insights and Budget (`month=2026-09`),
  as it already was on the review. Back from a drill-down into Activity
  returns to the month it came from. Moving between months replaces the
  history entry rather than adding one, so Back leaves the screen instead of
  stepping through every month looked at, and the current month is left out
  of the address.
- **The person is remembered in this browser**, so a reload keeps the totals
  on screen. It is not in every address: it is the sidebar's, and a link
  shared or bookmarked opens under whoever is looking. A link can still
  choose it with `who=`, which the app applies and then takes out of the
  address, so the sidebar stays the one control for it.
- **The review's links open what it counted.** The review counts both
  people's records, so its links to Activity say `who=both`; one opened under
  Me used to show none of a partner's flagged records it had counted. Its
  statements link opens the statements that closed in the month reviewed
  (`month=` on Wealth → Statements, with "Show recent statements" to go
  back), not the six most recent, which for an old month did not include it.
- **A save has to change the record.** An edit that matches no row, because
  the record was deleted or changed elsewhere, returns no error from the
  database. The editor now reads back the row it changed and, when there is
  none, stays open and says the record wasn't saved rather than closing as
  if it had been.

## A correction can remember its merchant

Moving a record to the right category was the moment the household knew
where a merchant belongs, but saying so took a second trip to Settings to
write the rule by hand. The transaction editor now offers it, using the rules
that already exist (`category_rules`), so the bot and the Inbox use it with
no change of their own.

- **Offered narrowly.** Only for an ordinary expense already in the ledger,
  with a merchant, moved to another category. A split's categories are its
  lines, a refund follows its purchase, and a transfer has no category, so a
  merchant-wide rule says nothing true about them. It starts unticked: saving
  without it is the same save as before.
- **Shown before it is added.** The pattern starts as the whole merchant name
  and can be shortened; Contains or Starts with, as in Settings; the category
  is the one just chosen. The wording says what the rule matches, that letter
  case doesn't matter and that it is the household's. A pattern that would not
  match the merchant itself is refused before anything is written.
- **The record first, the rule after.** A failed save, or one that changed no
  row, adds no rule. A rule that fails after the record saved says
  "Transaction saved; merchant rule wasn't saved." and the editor then offers
  only "Try the rule again": the record and its edit history are not written a
  second time. The rules are read again before each attempt, so one added in
  the meantime, or by an attempt whose answer was lost, is not added twice.
  Nothing in the database forbids two equal rules; this check is the only
  guard, which is enough for two people.
- **Existing rules keep their place.** The earliest active rule that matches
  decides, in the app and the bot (`firstMatchingRule`), and a new rule goes
  last. So a rule that already files the merchant under the chosen category
  means nothing to add, and one that files it elsewhere would keep winning:
  the editor names it, links to it in Settings (in a new tab, so the record
  stays open as typed) and saves the correction without a rule. Changing
  which rule wins is done on the rule. Archived rules are ignored, as they are
  for matching, and stay archived.
- **Only the record changes.** Past records from the same merchant keep their
  categories; "Apply now" in Settings stays the one way to file them, and it
  still touches only uncategorised ones. After saving, Activity keeps its
  filters and person, and says what was remembered, with a link to the rule
  (`/settings?tab=categories&rule=<id>`, which opens its editor).

## A refreshed token keeps the page on screen

Supabase refreshes a signed-in member's token about hourly, and a refresh in
one tab reaches every tab of the same browser. Each new token was checked for
its second step from scratch: the app went back to "checking", which shows the
two-step screen in place of every page, so an open editor closed and whatever
had been typed in it was lost.

- **A member who has passed stays on screen** while their new token is
  checked. Only a different member, a new sign-in after signing out, or a
  session not yet through waits for the answer as before.
- **An answer still counts.** If the server says the refreshed session has
  not passed (a code is needed, or an authenticator must be added), the
  two-step screen takes over as it always did.
- **A check that could not be made** (the network, say) leaves a member who
  had passed where they were, rather than showing the error screen over their
  work. Nothing is weakened by it: the database refuses every read and write
  without the code (`private.mfa_satisfied()`), whatever the tab believes.

## Cloudflare Pages as a third host

Netlify's free plan allows about twenty production deploys a month and stops
publishing when its credits run out, which left the site on a mid-October
build. Cloudflare Pages has a free tier of 500 builds a month and no charge
for a static site's bandwidth, and can later put Cloudflare Access (an email
code for listed addresses) in front of the app on a custom domain.

- **Added, not swapped.** Netlify and GitHub Pages stay until the household
  decides which host to keep. Every copy can sign in to the live data, so
  each host is another account to secure; the fewest hosts is the safest end
  state, and GitHub Pages, which can send no security headers, the first to go.
- **One list of headers.** netlify.toml stays the source; the Cloudflare
  build translates it into `_headers`, and a test pins the result. The file is
  generated only in that build: Netlify reads a `_headers` file too and would
  send each header twice.
- **The host never holds the household's data.** It serves the app's code;
  the records come from Supabase to the signed-in browser. What a host can do
  wrong is serve altered code, which is why the hosting account needs a passkey
  and the page's Content-Security-Policy allows only the household's own
  Supabase project.
- **No previews.** Branch builds are off, as on Netlify, until a database
  holding only synthetic data exists for them.

## One locked address

Cloudflare Pages became a third host so the site would keep publishing when
Netlify's credits ran out. The household then gave it a domain of its own and
put Cloudflare Access in front: an email code, for listed addresses only,
before the app's code even loads. That is the address the household uses.

- **GitHub Pages is retired.** It could send no security headers and could not
  sit behind Access, so it was the weakest way in. Its workflow is deleted and
  the site unpublished; `vite.config.js` no longer builds for a `/rokda/` base.
- **Netlify stays for now,** deployed only by hand, until the household
  decides. `netlify.toml` remains the one place the security headers are
  written either way, since the Cloudflare build reads it.
- **The domain is not in the repository.** It carries a household member's
  name, and this repository is public. The docs say "the household's own
  domain"; the Cloudflare and Supabase dashboards name it.
- **Access adds a lock, it does not replace one.** It covers the app's code on
  that one hostname. The data stays guarded where it always was: Supabase's
  household rules and the authenticator code on every request.


## Cloudflare only

Once Cloudflare Pages served the household's locked address, Netlify was a
second way in: still on a mid-October build, reachable without the Access
lock, and spending credits the household had to ration. The household retired
it, leaving one host.

- **One host, behind one lock.** Every copy of the app can sign in to the live
  data, so each host was another account to secure and another address to
  lock. Cloudflare serves the household's domain behind Access and builds
  every merge, with no credits to run out.
- **The headers live in `public/_headers`.** netlify.toml was their source only
  so two hosts could not drift apart; with one host, Cloudflare's own file is
  the plain choice. Vite copies it into the build, `verify:build` fails a build
  without it, and a test pins every value. `npm run build:cloudflare` keeps
  its name so the Cloudflare dashboard's build command still works.
- **If Cloudflare ever fails,** the app is static files and any host can serve
  `dist/` with that `_headers` file. The data stays in Supabase whatever
  serves the code.
- **CI runs on pull requests and on `main`.** Branch pushes used to run it a
  second time for every pull request push, which costs nothing on a public
  repository but counts against the free minutes of a private one. A newer
  push to a pull request cancels the run it supersedes.


## The goal editor keeps what you type

A code review of Planning found the goal editor losing work. Enter after a
contribution amount saved the goal instead, so the drawer closed and the
amount was gone. Logging, linking and removing closed the drawer too, dropping
unsaved edits to the goal, and Remove deleted at once, failure or not.

- **One form per action.** The goal's own fields, a contribution and a link
  are separate forms in the one drawer, so Enter does the action of the field
  it is in. Logging, linking and removing keep the drawer open and the goal's
  unsaved edits; only Save and Delete close it. What was typed clears as soon
  as its write lands, and the drawer takes no second press until the records
  have reloaded, so nothing is sent twice.
- **Typed but not logged is unsaved.** An amount not yet logged, or a share
  not yet updated, shows the Unsaved chip; closing asks first, and Save says
  to log, update or clear it, rather than dropping it.
- **Remove asks first,** and a failure is said in the section it happened in.
  A linked share is changed on its own row, which the database always allowed;
  linking the same account again used to fail with a raw duplicate-key error.
- **Only money the household has can back a goal.** The link list offers open
  accounts that are not loans or cards, and holdings. A loan's or a card's
  balance is what is owed, so linking one counted debt as saved, and a closed
  account holds nothing. A link made before this rule counts as nothing, and
  its row says so; the database guard comes with the next goals migration.
- **Fields are labelled, and marked wrong only once a save is tried,** each
  with its own message, and focus goes to the first. Remove turns into
  "Confirm remove" on the same button, so focus stays on it, and Escape steps
  back out of a confirmation before it closes the drawer.
- **Every drawer's fields shrink to fit a phone** instead of running past its
  edge. A select whose words need the room (a holding's provider, a deposit's
  compounding) takes the whole row.


## What never loaded is not shown as none

A code review of Planning found it telling a household what it did not know.
With goals and debts unread, Plan showed no goals, no debts, "All clear" and an
earlier stop year under the banner that said they had not loaded; Refresh
blanked every page and lost a note being written; and Planning read the
household twice and eight tables it never used.

- **A source that never loaded is withheld, not shown as empty.** useSources
  names every source that has loaded at least once, and the household lookup
  counts as one. One that failed before it
  ever did still holds its empty placeholder, so a list built on it says
  "Couldn't load goals" with Try again, and a figure built on it is not worked
  out: Plan's cards, its stop year and "What needs a decision", which says
  "Not checked" rather than "All clear". A source that loaded before and fails
  on a refresh keeps its last records, which are still the household's own.
- **Refresh keeps the page.** The household lookup shows its loading state
  only the first time; a later one refreshes in place, and a failed one keeps
  the household it had. Every page used to fall back to its skeleton on
  Refresh, unmounting whatever was open.
- **One household lookup for the app.** The shell loads it and every screen
  reads that one, rather than each making the same two round trips before its
  own reads could start.
- **Planning reads its six tables, once.** It reads only the accounts,
  transactions, categories, recurring bills, budgets and holdings its tabs
  use. No read starts while one is on its way, so coming back to a tab, which
  fires two events, reads once; the household is read again on the same
  schedule as the records.
- **What each part rests on.** Goals rest on the assumptions too (inflation
  and return); Debt payoff's list does not, only its projection; the budget
  counts only until three months have closed. Plan offers each decision whose
  records loaded and names the rest once as not checked.
- **A note is not lost or overwritten.** Cancel, and closing or reloading the
  browser tab, ask before dropping a changed note. A save goes through only
  over the version the edit was opened from, kept by the editor however often
  the note is read again meanwhile, so one partner's edit no longer replaces
  the other's without a word.

## Planning editors check what they save

The Planning audit's code review found the editors saving what no plan can
use. A cleared field in the assumptions drawer was stored as 0%, so a
withdrawal rate left blank made the independence target 0 and read as
independence already reached; any number was taken, and inflation of −100%
made every projection infinite. A debt saved with its rate or minimum blank
was stored as 0, and Debt payoff then called both "Known". Nothing in the
database stopped any of it.

- **A blank is the default, never 0.** On Baseline a cleared return,
  inflation or withdrawal rate saves the default its placeholder names (6.0,
  2.5, 4.0). On Custom it saves nothing, and that figure follows Baseline's,
  then and after Baseline changes. A 0 that was typed stays 0.
- **Out of range is refused, in the editor and the database.** A return
  between −20% and 50% and inflation between −10% and 30%, the ranges the
  after-work return and a goal's rise already had; a withdrawal rate between
  1% and 10%; an essentials-only spend above zero; an extra payment of zero or
  more. Each field says what is wrong with it, the way the goal editor does.
- **A debt needs its rate and its minimum.** Neither is taken for 0 when
  left blank. Both can be 0, since an interest-free instalment or a loan from
  family is real, and Debt payoff names debts at 0 for checking rather than
  calling their terms known. The database keeps rates between 0% and 100% and
  balances and minimums at zero or more.
- **A balance changed elsewhere is not saved over.** The debt editor writes
  a linked account's balance only when a new one was typed, and only over the
  balance it showed; if the account changed meanwhile, here or through the
  bot, it says so and saves neither.
- **What the Life plan editor marks shows at once.** Which spending stops
  when work does is kept on the categories, so saving the plan reads them
  again too, rather than waiting for the next refresh.

## The planning engine's edge cases

The Planning audit's code review found the engine giving wrong figures at
its edges, each from data a household can reach.

- **Pay counts only inside recorded history.** A salary is counted in the
  month it is for (payMonthTransactions), but at the start of the records
  that made two months that are not the household's: pay for the month
  before the first record, counted as a month of saving with nothing spent,
  and a first month with its spending but not its pay. planningMonths never
  counts the first and leaves out the second. Spending by category is
  averaged over the very months the totals are, so "less what stops" is a
  share of the same year.
- **A pot below zero is debt, not a shortfall.** A loan larger than the
  accounts made the Life plan book a shortfall in its first year and then
  forget the rest of the debt. While working the pot can now be below zero:
  it earns nothing (the loan's cost is already in the recorded spending),
  saving repays it, and it cannot pay a goal. Once work stops nothing repays
  it, so what is still owed then is a shortfall. Figures below zero are
  shown with their minus sign, and "still owed" in words.
- **Why no year lasts is said from its cause.** Plan and Forecast blamed a
  goal whenever no stop year lasted. They now name the goal that falls
  short, say that more is spent than earned, say the saving is not enough,
  or say the plan has run its course.
- **This year counts only what is left of it.** The Life plan credited the
  current year with a whole year of saving and growth, so its answer was the
  same on 2 January and on 30 December, and moved a year overnight on
  1 January. The first year now gets the share still to come; every later
  year is a whole one.
- **A plan everyone has outlived asks for a later age.** With every person
  past the age the plan runs to, the Life plan threw and took the whole app
  with it.
- **One sign rule for cards and loans.** A card stored below zero is in
  credit and owes nothing, as net worth and the bot already read it; Debt
  payoff called it owed. A loan cannot be in credit, so the account editor
  asks for a loan's amount owed and stores it as positive.
- **Paid-off and very long debts are said plainly.** Paying the minimum on
  nothing owed read "clears in 1 mo", and a debt clearing after more than 50
  years read "revolves indefinitely", the words for one that never clears.
- **A linked debt belongs to whoever its account does.** The debt editor
  showed its own owner chooser, so Debt payoff could give a loan to one
  partner while net worth gave it to the other. While an account is linked
  the owner is the account's, changed in Wealth.
- **Income with no rate is named, not dropped.** Other income in rupees
  before the household sets its AED/INR rate is left out of every figure, as
  before; the income list, its editor and the Life plan now say so.

## Planning works its figures out once

Moving along the Life plan's chart rebuilt the whole page: a new number
formatter for each of a few hundred figures, the plan and its four solvers,
and the year-by-year table, though that sits closed by default.

- **One formatter per number of decimals**, made the first time it is asked
  for (lib/money.js). Building an Intl.NumberFormat costs some forty times
  what using one does.
- **The plan is worked out once for each change of input**, not on each step
  along the chart; missing props share one empty list, so a fresh one does
  not count as a change.
- **The year-by-year table is built when it is opened.**
- **Each figure is counted once**: Plan and Forecast take the month count
  forecastInputs already found, and the Life plan editor takes each
  category's year from the spending that stops rather than working it out
  again.

A chart step went from about 19 ms to about 8 ms in a test render with two
years of records.

## Drawers and controls for everyone

The planning screens worked with a mouse and good eyesight. A keyboard, a
screen reader or a thumb on a phone each met something that didn't.

- **An editor drawer is a real modal.** It said aria-modal, but focus stayed
  on the button that opened it and Tab walked on through the page behind.
  Every drawer now takes focus when it opens, keeps Tab and Shift+Tab inside
  it, makes the page behind inert, and gives focus back to its opener when
  it closes (lib/useDrawerFocus.js). The drawer itself takes focus rather
  than its first field, so a screen reader announces the dialog and a
  phone's keyboard stays closed until a field is chosen.
- **What is selected is said, not only shown.** The open tab carries
  aria-current; Planning's segmented choices (scenario, today's or future
  money, spending, start from, markets) carry aria-pressed and sit in a named
  group. Before, the choice was only an underline or a border.
- **A finger gets 44px.** On a phone, or under any coarse pointer, buttons,
  segments, tabs and the Inbox's field rows are at least 44px tall, and the
  drawer's close button and the solver's steps 44px square. Text links
  (Refresh, "Open Goals", a note's Edit) keep their size and reach 44px with
  an invisible margin, so the line they sit in keeps its shape. A tab grows
  upwards, so its label stays over its underline. The width test is there
  because some phones report a fine pointer.
- **Caveats are readable.** The muted lines that qualify a figure ("from
  your budget", "not counted: no rate yet"), Overview's quiet chips, Debt
  payoff's figure labels and chart table headings were --ink3, about 3.5:1
  on the ground and 10.5px in places. They are --ink2 at 11px or more, which
  clears 4.5:1 in both themes. This departs from design/, which sets them in
  --ink3; --ink3 stays for what is decoration, not information.
- **Plan's cards are buttons.** The whole card opened its tab on a click but
  was a div, so a keyboard could not reach it. It is a button named for where
  it goes, its figure and note read as its description, and the tab it opens
  takes focus.
- **Labels fit above their fields.** "Investment return (nominal %/yr)" and
  "Minimum payment (AED/mo)" wrapped to two lines in a two-column row and pushed their
  field below its neighbour's; they are "Return (%/yr)" and "Minimum
  (AED/mo)", and the assumptions editor says the return is before inflation.

## Plan tells the truth

Plan's cards and its list of decisions said more than the records support
(Planning audit, 1.1).

- **The debt card dates the debt.** It said "No payoff date set" until an
  extra payment was committed, though the minimums alone clear a loan on a
  date. It now says when the debts in view clear at their minimums, each on
  its own (lib/debt.js, minimumOnlyPayoff). A minimum freed when one debt
  clears is not assumed to move on to the next: nothing commits it there, and
  assuming it can bring the date years closer. With an extra payment
  committed and both of you selected, the card gives that plan's date
  instead. In one partner's view it used to show a household date that Debt
  payoff refuses to show.
- **The list holds checks that change what you do.** "N goals behind pace"
  went. It measured each goal by what was logged to it in the last 90 days,
  so goals with no date, or fed through a linked account, read as behind
  while Goals called them covered. The review's "Fund <goal>" actions used
  the same measure and went with it, so Money no longer reads the planning
  tables for the review. A goal check comes back with Goals' 3-year rule
  (1.5). The nudge to commit an extra debt payment went too: it pressed for
  prepaying a loan before any cash reserve was in place. New: balances not
  entered, by name, with a link to Wealth → Accounts, since every figure
  counts them as 0.
- **The stop card says what it assumes.** A stop year nobody chose was
  called "your plan's". It is now "assumed", with whose 60th birthday it is.
  That default is the eldest person's 60th, the first by name on a tie,
  rather than the first in a roster order the database doesn't fix. While
  balances are not entered the answer is provisional, and says so. A member
  with no ages is named as left out, here and on the Life plan. In one
  partner's view, the card says the year is the household's.
- **Plan's cards start at the top of their row.** As buttons they centred
  what they held, so a shorter card's label sat lower than its neighbours'.

## Your budget beside the records

Once three months have ended, the plan runs on recorded months and the
budget used to drop out of view, though it is the plan as the household wrote
it down. The first save of the assumptions also froze the recorded average as
the baseline, months recorded only in part included, and nothing could undo
it (Planning audit, 1.2).

- **Both answers, side by side.** Plan's stop card and the Life plan give the
  stop year on the budget's figures beside the one on recorded months
  (lib/forecast.js, budgetInputs). The Life plan also says what each basis
  spends and saves a month, and whether the chosen stop year lasts on the
  budget. Everything else still runs on the recorded months; choosing the
  basis, and when records start counting, is 2.9.
- **The baseline is the budget's savings target.** The first Baseline save
  takes the budget's monthly savings target as the saving the plan is
  measured against. With no savings target in the budget, no baseline is
  taken, and the editor says so, so a later save once there is one sets it.
  The return and inflation it records are unchanged.

## Defaults are called defaults

The planning assumptions read as the household's choice when nobody had made
one (Planning audit, 1.3).

- **A saved marker.** The database fills the return, inflation and
  withdrawal rate with its defaults whenever any editor first creates the
  row, the life plan's or the debt plan's included, so a row of 6%, 2.5% and
  4% showed as "Your saved assumptions". `assumptions_saved_at` (migration
  `assumptions_saved_marker`) is set when the assumptions drawer saves
  Baseline, and backfilled where a baseline was taken, since only that save
  ever took one. Until it is set, Baseline reads "Defaults, nothing saved".
  The figures don't change: the app's defaults are the database's.
- **One set of defaults in code**, lib/planningDefaults.js, in place of the
  copies six screens and two libraries kept. A test holds it to the
  database's column defaults.
- **Spending after work stops says how it was chosen.** Forecast called it
  "(your life plan)" whatever it was; it now says "your plan" only for a
  figure saved for the plan, and "today's, less what stops" and the rest for
  one the app works out, as Plan and the Life plan do.
- **A stop year left blank stays blank.** Saving the Life plan editor with
  the year empty wrote the suggested 60th-birthday year, which then read as
  chosen. It saves nothing, and the editor says the year is assumed until
  one is chosen.

## Debt payoff dates the loan

Debt payoff showed no date until an extra payment and a card-usage answer
were entered, though every loan clears on its own minimum (Planning audit,
1.4).

- **It leads with the date at the minimums** and the interest still to pay
  until then, worked out debt by debt (lib/debt.js, minimumOnlyPayoff), the
  same words Plan uses. Each debt in the list says when it clears.
- **An extra payment is a what-if.** It is optional; once set, the page gives
  its date and interest against the minimums', with a rule of thumb beside
  it: fill the cash reserve before paying extra on a loan at a low rate. It
  stays the household's, shown with both partners selected.
- **The card-usage setting is gone.** Its answer changed nothing the page
  worked out, but a date waited on it. The column is left as it was, unread.
- **The order is saved, and only offered when it matters.** Avalanche or
  snowball is kept for the household (migration `debt_order`), so it holds
  for both partners and Plan's projection follows it; it was forgotten on
  every reload and Plan always used avalanche. The switch shows from two
  debts owed, since with one it changes nothing. "Custom order" is gone until
  a debt's rank can be set.
- **A 0 rate or minimum is named for checking**, since every date rests on
  them and a 0 is also what a blank was once saved as.

## Goals: one honest number

Goals showed several figures a row, and covered a trip months away with
equities: "AED 0 a month, invested at 6%" (Planning audit, 1.5 and 1.6).
This reverses "Goals shows one monthly figure" above.

- **The 3-year rule.** A goal due within 3 years is paid from cash: what is
  logged to it and the current, savings and cash accounts linked to it (the
  accounts Overview's cash cover counts), never holdings, with no growth. Its
  monthly figure is plain cash, each goal's remainder spread to its own date,
  so the total falls as each date passes, and it sits beside the budget's
  planned saving. Many planners use 3 to 5 years; 3 is the shorter end.
- **Later goals are the Life plan's.** It pays every dated goal from
  everything, in its year, so a later goal's state, paid or short, is read
  from its timeline (lib/goals.js, goalStatuses; lifePlanStop returns its
  rows), and the two tabs can't disagree. Goals had called a goal covered
  that the Life plan found short.
- **One status per row,** from the rule for its kind; the 90-day pace and its
  projected date are gone from the row. Kept money, an emergency fund, is
  held in cash; a goal with no date is in no plan and says so.
- **The priority table covers later goals only,** closed, as "If your
  investments paid for these", with what would be left over.
- **The goal checks come back** on Plan (a goal due within 3 years short of
  cash, a goal with no date) and in the monthly review (set aside for a goal
  due within 3 years), from the same rule. Plan's Goals card leads with the
  next 3 years in cash.
- **Kept or spent is set in the goal editor** (1.6), not only on the Life
  plan.

## A goal can be done, and has a plan

A goal reached or spent could only be deleted, contributions and all, and
there was nowhere to say what the household means to put towards a goal each
month (Planning audit, 2.7).

- **Done, not deleted.** `goals.done_at` marks a goal done from its editor,
  at once and only with nothing unsaved. A done goal keeps its contributions,
  is listed apart on Goals, and is left out of every status, the Life plan's
  timeline, Plan's checks, the monthly review and the Telegram bot, which
  says the goal is done rather than that it does not exist. Reopen clears it.
  A goal proposed in Telegram before it was marked done is still recorded on
  a "yes": rare, visible on the goal, and not worth changing the proposal
  function for.
- **A planned monthly amount.** `goals.planned_monthly`: blank is no plan, 0
  is a plan of nothing. For a goal held in cash it is measured against what
  the date needs: covered on time ("Planned"), or short with the month it
  would get there ("Plan short"). A plan that rounds to the whole dirhams
  shown counts as on time. Plan's "short of cash" check leaves out a goal its
  plan covers, and the monthly review says what was planned. For a later or
  undated goal it is said, not measured: the Life plan pays a later goal from
  everything, and an undated one has no date to be on time for.
- **The bot reads goals in full** and says so when it can't, rather than
  answering that no goal matched.

## One source of saved, and a goal's pace

A goal linked to an account counted the same money twice when a transfer
into that account was also logged as a contribution, and the Telegram bot
made that easy. Its pace could only come from what was logged (Planning
audit, 2.8).

- **One source.** A goal with accounts or holdings linked to it counts what
  they hold; what is logged to it stays its record and is not added on top.
  A goal with nothing linked counts what is logged. The rule is the same for
  its cash (a goal due within 3 years, or kept money), for what a later goal
  shows as set aside and the priority table counts, and for Plan's Goals
  card. The
  goal editor says so once a link exists. A per-goal switch was not added:
  linking an account already says where the money is.
- **Pace from the same source,** for a goal held in cash: the change in its
  linked current, savings and cash accounts' balances at their share, or
  what was logged to it, over about the last three months. It is read from
  the balance changes the database records (`account_balance_events`, since
  October 2026), never from `balance_as_of`, which can be back-dated and is
  not stamped on every save. The balance before an account's first recorded
  change is not known to have held for any time, so the record starts there,
  and no pace is given until there is a month of it. Each change is converted
  at today's rate, so the rupee's drift is not money going in.
- **Pace is said, not judged.** It is a line under the goal ("Going in from
  its linked accounts: about X a month over the last 3 months"), with "below
  the X you plan" when it is. The chip stays the plan against the need (2.7):
  a pace is history, and three months of it is too short to overrule a plan.
  Fixed deposits and holdings give no pace: an FD's balance is worked out,
  not entered, and a holding moves with its market, and neither counts as
  cash for a goal due soon.

## The household chooses the basis

The plan used the budget until three months had ended, then switched to the
recorded months on its own, and a first month recorded only in part counted
like any other (Planning audit, 2.9). Saving on the recorded months can run
far ahead of the plan the household wrote down, and moves the stop year more
than any other input but the scenario.

- **A choice, saved with the assumptions:** `planning_basis` is the budget or
  the recorded months, and `records_from` the month the records count from.
  Both partners and every tab use the same choice.
- **Each stands in for the other only when it can't be used,** and the line
  says so: the records while no month has a spending budget, the budget
  until three months have ended. Blank keeps the old rule, said as not
  chosen.
- **One always-on line** on Plan, Life plan, Forecast and Drawdown says which
  figures the projection rests on, why, and since when, with Change basis.
  The Life plan's "budget beside the records" (1.2) stays while the records
  are the basis, without repeating the recorded figures the line gives.
- **Records counted from a month, not a day:** the months are what is
  averaged, and the drawer offers every month from the first recorded to
  this one.
- **Ended months, not closed months,** in what the tabs say.

## A loan is counted once

The plan took a loan's balance off the starting pot and kept its whole
instalment in spending until work stopped: the principal counted twice, and
saving never rose when the loan cleared, years before (Planning audit, 2.10).

- **Which loans:** those whose instalment is part of the spending the plan
  uses (`loansInSpending`). A card is left alone, since its purchases are the
  spending, and so is a loan paid by transfers into its own account in the
  last twelve months, which the records already count as saving. A loan its
  instalment never clears has no date and is left as it was.
- **Start from assets for those loans:** the plan starts from what the
  household owns before what they owe (only for a loan net worth counts),
  and the instalment repays it inside spending. The audit's other option,
  starting from net worth and counting only the interest, would have meant
  splitting every recorded instalment into interest and principal.
- **Saving rises once each one clears,** from the month after its last
  instalment at the minimum (Debt payoff's date), by the instalment in
  today's money then. A loan clearing after work stops lowers spending from
  then, when that spending is today's; a figure saved for the plan, or
  today's less what stops, is left as it is.
- **The Life plan says so** under its timeline, and a projection waits for
  the debts to load rather than counting the loan twice again.

## Plan's monthly check

Plan never said whether saving was on target, or how long the cash to hand
would last (Planning audit, 2.11). Three versions of that check already
existed: Review's saving check, the cash cover Overview and the bot use, and
the budget. Plan now shows the first two, reused rather than made a fourth
time.

- **Saving:** the month just ended, the one Review opens on, against the
  budget's savings target for it (`savingCheck`, which Review's "Catch up on
  saving" now uses too). A running month has its pay still to come.
- **Cash reserve:** the open current, savings and cash accounts (the
  cash-cover set), as months of the plan's spending on its chosen basis,
  against what the kept goals hold, like an emergency fund. Without a kept
  goal it says no target is set; without spending to divide by, it gives the
  cash alone.
- **The household's, whoever is shown,** as the review is, and the section
  says so. Each line says what it couldn't check when its records didn't
  load. The decisions list follows it.
