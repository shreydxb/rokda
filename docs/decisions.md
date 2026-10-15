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
  now also require `private.mfa_satisfied()`: the session is aal2, or the
  caller has no authenticator yet. So a password alone reads nothing through
  the API either, once a member has one. A member with none is not refused:
  refusing first would lock everyone out before they could add one. The app
  has every member add one before it shows anything, so that window closes at
  each member's next sign-in.
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
