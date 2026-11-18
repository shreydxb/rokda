# What Rokda does

A map of the app as built: every screen, what the Telegram bot understands,
and what runs on its own. The reasons behind each piece are in
`docs/decisions.md`; open ideas are in `docs/ideas.md`. The household's own
plan (goals, split, open items) is kept in the app under Planning → Notes, not
here, because this repository is public.

## Every page

- The look follows `design/prototype/`: graphite and iris, in dark or light
  (a first visit follows the device; the choice is remembered), with Geist.
- The sidebar: "Showing: Both / Me / Partner" at the top, which applies
  throughout; Overview, Inbox (with how many wait), Money, Wealth, Planning
  and Settings; and the account at the foot, whose menu holds the display
  currency, light or dark, and sign-out.
- Each screen opens with its name as a title, and labels are in sentence
  case. The refresh button at the top right shows when the page last read
  the household's records ("14:32"; "Loaded 14:32" on hover) and reads it
  again. Pages read again when the tab comes back into view (if more than a
  minute old), every five minutes while in view, and on refresh, without
  closing an open editor.
- On a phone the top bar holds the menu, as one line that scrolls sideways,
  and one button showing the household scope and display currency ("Both ·
  AED ▾"); it opens the scope and the account. The build this is shows
  under Settings → Household → About.
- Longer explanations (how a figure is worked out, what a feed does) sit
  behind a small "How this is worked out" link that opens in place.

## Signing in

- Email and password, with "Keep me signed in". Sign-ups are closed: logins
  are added in the Supabase dashboard.
- Then a 6-digit code from an authenticator app. A member without one adds it
  first, from a QR code. Nothing of the household loads before the code, and
  the database refuses a password-only session for a member who has an
  authenticator. A lost phone: the owner deletes the member's factor in the
  Supabase dashboard (Authentication → Users), and the member adds a new one.
- **Forgot password?** emails a link that opens **Set a new password**; the
  app opens once the new one is saved. A link that has expired or was already
  used opens **Reset password** instead, saying so.

## Overview (`/`)

The cockpit (the revamp, November 2026; `design/prototype/`): what needs
doing, how the period is going, what the household is worth and whether the
plan holds.

- The header: the date, a "Data: N to check" chip that opens the four data
  checks in place, the title ("N things need a decision", or "All clear"),
  then Month / Quarter / Year, **+ Transaction** (the editor opens here) and
  refresh.
- **Net worth**: today's figure, its change this month, a trend of the closed
  months (up to twelve; pick a month to read it), and Provisional or
  Incomplete when a balance is not confirmed or a value not converted, in
  words and as chips.
- **This month** (or quarter, or year): income (with any pay still
  expected), spent and saved with the rate, the number of transactions
  (opening them in Activity), the display rate when not in dirhams, and in a
  month, for both of you, the budget's track against how far through the
  month it is.
- **To do**: the one list of everything waiting, in Today / Month end /
  Planning, six rows then "Show all". A record to review is categorised or
  marked reviewed in place; a late bill or an unconfirmed autopay is
  **Mark paid** (**Mark received** for pay; the editor opens filled from the
  bill, dated the day it was due); a balance to confirm,
  a card payment due, a holding to reprice, a dividend question, the latest
  statement to check on each card (with how many older ones wait), a month
  not closed, a backup due, a goal due within 3 years short of cash, and a
  yearly check each open their own place.
- **Next 30 days**: a dated strip of every bill and pay day (late or not
  confirmed on today), the next five as rows and the rest on request, rupee
  amounts in rupees as well, and whether the household's cash on hand covers
  what falls due from today, bills and cards included (never "Covered" when a
  bill has no dirham amount).
- **Income and spending** over six months, four quarters or five years:
  income and spent as columns, saved as a line, with an axis; a period with
  no records says so; pick one to read its figures.
- **Where it went**: this month's five biggest categories, net of refunds,
  each with a tick at its usual month (the six-month average Budget's Usual shows), and up to three
  running ahead of their usual pace (What changed); each opens the month's
  transactions in that category.
- **Plan**: when work can stop (Baseline and Conservative), the goals for the
  next 3 years in cash, the debts and when they clear, and the cash reserve
  in months of spending, in dirhams, each opening its Planning page; the same
  figures and warnings as Planning → Plan.
- **Recent**: the five newest transactions (a split one with its lines'
  categories, one needing review marked), each opening in its editor, with a
  link to the rest in Activity.
- The Both / Me / Partner scope in the sidebar applies throughout (shared rows
  split evenly between the two individual scopes).

## Money (`/money`)

- **Activity**: every transaction, as a table, a calendar or by merchant
  (List / Calendar / Merchants in the page header, beside the month stepper
  and + Transaction). It shows this month unless the address names another;
  the Dates filter also offers All dates and a custom range, and a link's
  range that is one whole month is that month. Posted / Scheduled / All
  (under More) picks which dates count, Posted by default like every other
  total; "N scheduled not counted" on the table shows them. Filters: search,
  dates, category (a group includes its subcategories, and "Uncategorised"
  shows records with none) and account in one row; type, which dates count,
  Needs review only and AED estimated only under More. Each filter set is a
  chip that takes it off, with Clear. They are all in the address, so Back,
  reload and a bookmark keep them. The table's card gives the count, Spent
  (purchases less refunds, its (i) says so) and Income; Date and Amount sort
  from their headings. A row says what it is with chips (Needs review, a
  low-confidence reading, Refund, Refunded, Scheduled, Possible duplicate),
  the owner's initial sits beside the account, and a record with no category
  gets one chosen in place, saved only while it still has none and written to
  its history. Under Me or the partner's name, totals are that person's share
  and a shared row shows their half with the whole beneath. The calendar
  follows the month stepper and adds up the same way; a day chosen lists its
  records beneath. Merchants is the month's spending by merchant, net of
  refunds, with how many payments each, how many merchants were paid and the
  top three's share; a merchant opens its records. The list shows 200 rows
  at a time; the totals cover everything matching. The month is shared with
  Budget: switching tab keeps it.
- **Remember this merchant**: moving an ordinary expense to another category
  offers, unticked, a household rule for its merchant. Ticked, it shows the
  rule before saving: the pattern (the whole merchant name to begin with),
  Contains or Starts with, and the category; matching ignores letter case.
  The record is saved first and the rule after it; a rule that fails says
  "Transaction saved; merchant rule wasn't saved." and can be tried again on
  its own. A rule already filing the merchant there adds nothing, and one
  filing it elsewhere is named, with a link to it in Settings, and the
  correction saves without a new rule. Not offered for splits, transfers,
  refunds, income or new entries. Only the record being edited changes;
  "Apply now" in Settings stays the way to file past records.
- **Payments in other currencies** (money sent home in rupees, a purchase in
  dollars): the record keeps the amount paid in that currency beside the AED
  that counts. The AED debited is entered when known; until then it is
  estimated at the payment date's rate (from the daily rate history) and
  marked "AED estimated", which Activity can filter to and Month end asks
  about. The Inbox takes a rupee entry from the bot the same way.
- **Splits**: one record across several categories ("Split across
  categories" in the editor), each line an amount in AED, adding up to the
  record. Every category total counts each line under its own category;
  Activity shows the record once with its categories.
- **Choosing the type** of an entry (Expense, Income, Refund, Transfer):
  under the choice, what it is for with an everyday example, and what saving
  it makes (one record, a refund linked to its purchase, or a transfer's two
  sides). A new expense also says "Moved money between your own accounts?
  Choose Transfer."
- **Transfers** between your own accounts (paying the card, saving): two
  sides, one out and one in, for the same amount, counted as neither income
  nor spending. Add one with Transfer on a new entry; an existing record whose
  other side is already in the ledger offers "Make these one transfer".
  Editing or deleting a transfer changes both sides; Unlink makes them an
  expense and an income again.
- **Refunds** are linked to the purchase they return: a refund's editor
  offers earlier purchases from the same shop or on the same account (within
  four months, with enough not yet refunded), and saving links the chosen one.
  Linked, the refund takes the purchase's category (its share of each line,
  for a split purchase). Activity labels it "refund for Shop, 20 Sept" and
  the purchase "refunded" or "part refunded"; a purchase's editor lists its
  refunds. A refund still counts in the month it arrives.
- **History** in a record's editor: every change, who made it and when, in
  saves ("15 Oct · Partner A"). A purchase's history includes its refunds'
  changes and a refund's its purchase's, each line naming its record, so a
  refund whose category followed the purchase shows both in the same save. A
  transfer's history shows both sides. Dates are recorded too. A change with
  no member behind it (the bot) reads "Automatic".
- **Budget**: month and year views (Month / Year, the stepper and
  + Budget in the page header). Spending is budgeted by subcategory and
  rolled up to its group. The month opens with the spent of budget, its bar
  ticked at how far through the month it is, and a verdict: over by an
  amount, over pace (more than ten points ahead of the month), on pace, or
  within budget once the month is over. By category is a table: a group with
  several budgeted lines has a header row, and Other holds what none of them
  does; a group with one budgeted line is one row counting the whole group.
  Each line gives what was spent, its limit (typed in place; a whole year or
  deleting is the editor's), its usual month (the average over up to six
  earlier months with records, with how far above it this month is once ten
  per cent or more) and its pace. A line opens its records beneath it, with
  All in Activity and Edit budget. Then Budgeted in all, and Outside budget,
  whose uncategorised part and Activity link open those records. Savings
  categories are savings targets measured against what the month actually
  saved (and its share of income), never counted as spending. One person's
  own lines carry their initial. **Household share** shows each person's plan
  (own lines plus their split of the shared ones, by income when salaries
  are set up), their part so far, what each paid, and the one transfer that
  evens it up. The year is a grid of months, months ahead in italics.
- **Recurring**: bills and expected income on a cadence, with an optional
  last date and amounts in AED, USD or INR. A strip gives Fixed a month,
  Variable (about) a month, Expected income a month and To mark paid: each
  schedule counts its share of a month (a yearly bill a twelfth), and ended
  and paused ones are left out. Bills and expected income are tables:
  status, name, every, next due (or when it was due, for one not yet
  marked) and how far off, owner, paid by (Autopay or Manual) or paid into,
  amount ("about" for a variable bill) and Mark paid. A bill reads Paid and
  income Received once recorded; an autopay bill past its date with nothing
  recorded reads Not confirmed, a manual one Late. Income is matched within
  10 days of its date, bills within 5, and a salary counts in the month it
  was due. What needs marking comes first, the rest by next date; ended
  schedules fold under "Ended" once nothing is left to mark, and a paused one
  reads Paused. Mark paid opens the payment filled from the bill, dated the
  day it was due when it is late. Under one person, the other's own schedules
  are left out and a shared one counts half. + Bill is in the page header.
- Money and the AED-entered plans (Plan, Goals & debts) stay in AED
  whatever the display currency, and say so when another one is picked.
- **Categories**: a record is filed under a category with no subcategories;
  pickers list them as "Group › Category" (Shopping, with none, stands
  alone). A record already under a group keeps it.
- **Inbox** (`/inbox`, its own page in the sidebar; `/money?tab=inbox`
  opens it): transactions the bot was not sure of, to confirm or fix. The
  title says how many wait. The list is newest first, each message tagged
  text or photo, with who sent it, when, and a chip: Already recorded, No
  date or Read cleanly. Beside it, the message chosen and what was read
  from it as fields edited in place: merchant, amount (and the AED debited
  for another currency), date, category, account, type and whose. An
  account the message did not name is chosen, never filled in, when the
  household has more than one. Approve and Reject; then the next message
  is chosen. A, R and the arrow keys do the same, except while typing in a
  field. "Approve N read cleanly" in the header approves the messages read
  cleanly and dated by the message itself. An entry whose message had no
  date is marked "No date" and is approved only once its date is set or
  "Paid on this day" is ticked, never in bulk. The undated entries of one
  message that read cleanly otherwise are offered together above the
  list: one date, given by hand, approves them all. An undated entry that
  repeats a record made in the two weeks before it was sent (same card,
  same amount, same merchant) is marked "Already recorded", left out of
  that, and "Set aside N already recorded" rejects them together.
  "Remember this merchant" is offered, unticked, for an expense with a
  category chosen whose merchant no rule covers: the entry is approved,
  then the rule is added.
- **Month end**: which page a month shows depends on where it is, with the
  month stepper in the header (never past the running month). It covers the
  whole household, whoever is selected.
  - **The running month** ("November is still running", closes after the
    30th): a strip of records with no category so far (Categorise →), card
    statements to check ("1 doesn't match") and balances not confirmed or
    not for 45 days (Accounts →), then every card statement still open.
    While the month just ended isn't closed, "Close October" opens it.
  - **The month just ended**, three steps, "n of 3 steps done", the step
    still open shown open and any other opened by a click (a link can name
    one, `step=2`). **Tidy transactions**: records with no category, each
    with a category chosen in place; possible duplicates ("Both are real",
    remembered, or "Delete one", which asks again); flagged records and AED
    estimates, linked to their records; transfer suggestions ("Make one
    transfer") and refunds to link, which never hold the step up; the checks
    that are clear fold under "Nothing to do (n)". **Check statements and
    balances**: the statements that closed in the month and the balances
    not confirmed since it ended, each with Confirm balance. **Close**:
    Income, Spent, Saved and its share of income, Net worth (Provisional
    while an account or holding has no value), a note when a step is still
    open ("you can close now and finish after"), then "Close October", which
    shows the Assets and Liabilities the close will record before Confirm &
    close. Not offered until the holdings have loaded.
  - **An earlier month never closed** has the first two steps, and says it
    can't be closed now: a close records today's totals as the month just
    ended's.
  - **A closed month**, the month on a page: Income and Spent with the change
    on the month before, Saved and its share of income, Net worth at close
    with the change on the close before; Biggest changes, the three
    categories furthest from their usual month (the six-month average), in
    that order, a tick at the usual, each opening its records; and Against
    budget, with a chip for each group over. Beneath it, its Checks: steps 1
    and 2, open at anything still to finish, so a month closed early can be
    finished and its statements reopened.
  - **Card statements** (one table, on the running month and in step 2): a
    row per statement under its card (Period, Due, In Rokda to the cent and
    signed, the statement's own total when one is recorded, the difference
    and which way it goes, Status), what is still to check first and the
    done ones under "Done (n)". "Mark done", "Resolve…" for one that didn't
    match (asking what was done) and "Reopen…" (asking why); tick boxes and
    "Mark n done" for several at once, though one that doesn't match is
    resolved on its own. A period opens its transactions, the statement's
    closing balance and who checked it. No statement total is typed here.
    The bot asks about each once and reminds once before it is due
    (`statement_reconciliations`).
  - Each link out of a step offers "← Back to Month end for October" on the
    page it opens, and links to Accounts and Budget open them for the whole
    household, as Month end counts it. Overview's "hasn't been closed" item opens the month;
    `?tab=review` and `/wealth?tab=statements` (with a month, its step 2)
    still work.

## Wealth (`/wealth`)

Three tabs: Net worth, Investments, Dividends. An old link to Accounts opens
Net worth, which holds the accounts.

- **Net worth**: the figure (Provisional while a balance isn't confirmed,
  with one line naming them and Confirm), "▲ {x} this month · {n}% in 12
  months", and Assets, Liabilities and Runway (months of spending the cash
  accounts cover) beside **How it has grown**: the trend of month-end net
  worth and today, "Close {month}" (to Month end) while the month just ended
  isn't closed, and the history as a table. History is the household's, so
  one person's view says to switch to Both. Below, the accounts ledger:
  **Assets** grouped By type or By owner (in the header, with + Account),
  each row with its owner, a status ("Not confirmed" with Confirm, or
  "Checked {n}d ago" after 45 days) and its amount, a group's total, the
  investments as one row that opens Investments, and Total assets;
  **Liabilities**, a card with "{x} this cycle · closes in {n}d" and the
  share of its limit used, a loan with its type, and Total liabilities, the
  closed accounts folded under "Closed (n)" with Reopen (they stay in
  history); and **What the assets are**, as shares.
- **An account** opens in a drawer from its row, or from its address
  (`/wealth?account={id}`, which Month end, To do and Needs attention link
  to): bank, card, loan, cash, investment, fixed-deposit and broker funds
  accounts (a broker's uninvested cash, which trades move). Balances are
  entered by hand and confirmed, never derived. Every change is kept with the
  figure it replaced, where it came from (app, bot or system) and who made it
  (`account_balance_events`). A balance in rupees is valued at the
  household's current rate, and moves when the rate does. Cards carry a
  limit, statement day and due day; a loan account can carry its debt terms.
  A **credit card** opens on **This cycle**: owed (and when checked), spent
  this cycle (from the day after its last statement through the next,
  counted as the statement will be), the limit used, the cycle's dates, the
  payment due (the latest statement's while it is ahead, with what it holds),
  the cycle's transactions and "All transactions on this card" (Activity);
  **Statements** lists its statements with the way to check them in Month
  end; **Details** is the editor, which asks before discarding changes when
  another tab is chosen. "+ Account" adds one, its type chosen in the drawer;
  Close account (or Delete for one never used) sits in its footer. Account
  types read as words ("Credit card", "Fixed deposit"), never as stored.
- **Investments**: holdings with prices pulled daily where a symbol is set,
  and FX rates for USD and INR. The header holds the groups (All, Global,
  India and the rest present), the Prices stamp (when the feed last ran; its
  pop-over gives the oldest valuation, the live feeds, any that failed, and
  that the page's own Refresh re-reads what is stored while "Refresh prices"
  fetches), a "{n} stale" chip opening the first, Refresh prices and
  + Holding. A failed refresh is a banner with Try again; holdings whose feed
  failed are named in a warning banner. Then one strip: Value, Invested,
  Profit not yet taken (and its share of cost), Profit on sales this year (in
  dirhams, a rupee sale at its own day's rate; how many sales, after tax, and
  any awaiting the broker's tax) and Change today. **Value over time** draws
  the daily value over 1W to 5Y (a "Partial history" chip names the holdings
  some days leave out), with the change over the range and today's value
  beneath, a day picked reading its own. **Allocation** stacks the holdings
  by asset class, and under it the largest concentration, a sector or a
  single holding, as a share of investments (cash left out) on a bar with
  the household's cap as a tick: "Above 25% cap" in warning colour, or
  within it, "{n} untagged" opening the holding most worth tagging, and "Set
  a cap" or "Change cap" in place, for the household. **Holdings**, largest
  first: name (Stale price and Untagged chips; class and sector beneath),
  owner, units, average price and price now in the holding's currency
  ("manual" where no feed sets it), invested, value (share of total), profit
  (share of cost) and today's change; a holding sold down to nothing moves
  to a "Sold" fold with what its sales made.
- **A holding** opens in a drawer from its row, or from its address
  (`/wealth?tab=investments&holding={id}`, which To do's Update price links
  to), on **Details**, **Trades** or **Dividends**, one editor behind the
  three tabs, so nothing typed is lost between them. A share or share fund
  is tagged with its sector once, in its details: one of the market
  sectors, or for an Indian holding the sector its broker's statement gives
  it (Defence, FMCG, Auto ancillary and the like); a fund spread across
  sectors is tagged so, and counts in no sector. Each holding's buys, sells
  and splits are kept as dated trades from its fresh start
  (`holding_trades`); its units and average price are worked out from them,
  and read-only in its details once it has them. A trade moves the broker's
  funds account and the holding's value together. The Trades tab lists a
  traded holding's trades, newest first, with brokerage, tax and what each
  sale made; "Record a trade" (buy, sell or split), "Fix" and "Delete" are
  checked by the database first, and saved exactly as shown.
  A US-listed or Indian share has a withholding rate on dividends (30% and
  20.8% by default) and a fee per share in its editor, and a broker fund
  says where its holdings' dividends are paid. Each night the dividend feed
  records what every holding earned on each ex-date, at the units its trades
  say it held (`holding_dividends`); a dividend paid into a bank account is
  presumed received 30 days after its ex-date. A share's Dividends tab lists
  its dividends, newest first: date and net, status (earned,
  received, presumed received and not checked, skipped), the sum it came
  from and where it goes, with the reason when the feed has flagged it.
  "Record", "Fix", "Skip" and "Restore" are checked by the database first,
  showing the net and what each fund gains or loses, and asking whether a
  receipt was already in a balance confirmed on its day; "Add a dividend"
  adds one the feed missed. A flagged one can be kept as it is or linked to
  the feed's dividend, and a feed dividend's one-off part given.
- **Dividends**: dividends as passive income, in dirhams and in the scope
  chosen, with **Income** and **Tax years** as two views in the header
  beside the Feed chip (when the feed last checked, amber naming a share
  whose check fails; behind it each market's last check). **Income**:
  "Needs you", a boxed card only while something waits (the flagged
  dividends, opening their holding to review; the one-off questions, "Yes,
  part was a one-off" / "No, all ordinary"; splits the trades don't show,
  opening the holding's trades; dividends to add by hand); then one strip:
  received over the last twelve months (or since the record starts, the
  presumed part as a chip, and behind its (i) what the figures leave out and
  where each market is counted from), expected over the next twelve (with
  its change on the last twelve once the record covers them, and how many
  holdings aren't projected), about so much a month, and against recorded
  spending. "By month" draws the last twelve months and the next twelve, a
  bar a month (received solid, presumed paler, expected outlined, today
  marked), switching between Received and Earned (a receipt with no
  ex-date is left out of Earned, and it says how many), with this year so
  far and next year's expected (named by the months the twelve ahead hold);
  beside it "Coming up", the earned and declared dividends still to come
  in, "Record" for one that arrived and Fix or Skip under "⋯". "By holding"
  is a table grouped by market (the group row giving what is withheld there
  and the market's received and expected): each share's sector, rhythm,
  last amount, received, expected, yield on value and on cost, and next
  payment, opening the holding on its dividends; a market whose holdings
  have no opening entry says nothing is recorded until one has; the shares
  that paid nothing, whose checks fail or that are not checked yet are
  folded with why. **Tax years**: each member's Indian dividends by tax
  year, in rupees, a row per member and year: the dividends and tax
  withheld, a provisional year marked, the check against the AIS and Form
  26AS as a chip ("Agrees", "1 difference", "26AS not added"), the return
  ("Filed 20 Jul") and the refund ("… credited 5 Oct", "… unexplained",
  before filing what could come back). A year opens in a drawer: where it
  stands in full (before filing, what could come back at that year's claim
  basis; after, the dividend tax surplus or shortfall and the refund), each
  share against both statements with any possible cause, its dividends with
  "Set tax year" (a final dividend declared in March counts in the March
  year), the return with "Edit" (claim basis, filed or revised, the
  dividend figures), and what happened to the refund with "Add", "Fix" and
  "Remove". Shared holdings are named apart, since a return is one
  person's.
## Planning (`/planning`)

Three tabs, as the prototype has them (the revamp, phase 6): Plan, Goals &
debts, Notes. Old links land where their content went: the Life plan,
Forecast and Drawdown on Plan, Debt payoff on Goals & debts. The Plan summary
went: Overview's Plan strip and To do say what it said.

- **Plan** (it was the Life plan): the household's whole financial life on
  one timeline, in dirhams, whoever is selected (a Household chip says so in
  one person's view). Edit plan sits in the page header.
  - **The strip**: the basis in a few words with its figures ("recorded
    months · spending 4,000 · saving 6,000 a month") and Change, which
    chooses the budget or the recorded months and the month records count
    from, saved for the household; why that basis and since when are behind
    its (i). A choice not in effect yet stays in view ("Recorded months: 1
    of 3 ended"). Then the scenario (Baseline, Conservative, Optimistic), the
    spending after work (Planned, Less what stops, Today's or Budgeted,
    Essentials, each with its figure) and the rates, with what the plan
    assumes (cash at its own return, loans counted once, the costs after
    work, sums paid in a set year) behind their (i). The scenario and the
    spending are what-ifs, never saved.
  - **When can we stop?**: the stop year (saved, being tried, or assumed)
    with the ages then; Baseline and Conservative at that year as chips;
    Pot in that year, Needed then, Goals on the way, and Short by (what is
    needed then less what the pot holds; for a goal the pot can't pay while
    still working, that goal's gap) or Left at the end. A stepper tries
    another year: "Not saved", Reset and Make this the plan. Warning rows
    say who isn't in the plan, what the start leaves out or hasn't
    confirmed, and income not counted for want of a rate. Beside it the pot
    year by year: a bar a year, paler once work stops, a grey band from
    Conservative to Optimistic, the stop year, the year the money runs out
    and a diamond for each goal the pot pays, with a readout of the year
    picked. Year by year folds every fifth year and the stop year;
    Goals on the timeline folds each open goal with how the plan pays it
    (Paid, From cash, Kept, No date, or Short), each opening the goal.
  - **What would it take?**: when the money runs short, stop in a later
    year, or save more a month, or spend at most a figure a year, each from
    the plan's own solver, the year with Try. When it lasts, "Nothing more
    is needed" with what is left, and how early work could stop, with Try.
  - **What could go wrong?**: a two-year market fall the year work stops,
    and, when anything is in rupees, the rupee losing 3% a year against the
    dirham. Each is on Baseline whatever scenario is shown, with its
    verdict, one line against the steady plan, how it is tested behind its
    (i), and its path against the steady one under "Show the path".
  - With not enough to project it lists what is missing, item by item, with
    where to add it; with no ages it asks who the plan is for; with everyone
    past the age the plan runs to, it asks for a later age.
- **The plan's drawer** (Edit plan) holds every planning assumption, a fold
  for each part: who the plan is for and the age to plan each person to, the
  year work stops, spending after it (a planned figure, essentials only, and
  the categories that stop), the costs that start when work stops, other
  income, and growth: the return, inflation, the return after work stops,
  which is a point below the return until one is set and moves with the
  scenario, and the return on cash, 3% until one is set. A cost or an income
  is added and edited in place inside its fold and saved as it is added.
- **Plan on a phone** stacks the stop year over the chart; the goal and
  debt tables scroll inside their cards.
- **Goals & debts**, like the prototype (the revamp, phase 6b), in dirhams.
  + Debt and + Goal sit in the page header.
  - **Goals**: a table card a group, each saying what it has saved of its
    target and needs a month. Next 3 years: paid from cash (the current,
    savings and cash accounts linked to a goal or, with none linked, what is
    logged to it; no growth), with the cash a month to its date. Kept, like
    an emergency fund: held in cash, with the cash reserve beneath (what
    the current, savings and cash accounts hold, in months of spending, and
    whether it covers the kept goals; the household's, so in Both). Later:
    paid by the plan, whose timeline says paid, short or beyond it. No date:
    in no plan. A row: the owner, the name and its note, the target and its
    date, what is saved and its share, what it needs a month, its pace over
    about three months (amber below what is planned, or with nothing going
    in), and one status chip whose tooltip is the sentence it rests on. Rows
    follow priority, then date. Done folds at the foot; a done goal is out
    of every plan and the bot, and can be reopened.
  - **A goal** opens through its address (`/planning?goal={id}`, from any
    Planning tab, To do's Open goal or Plan's timeline) in the kit's drawer:
    Details (the target, spent on its date or kept, name, date, what is
    planned a month, owner, note, priority and funding source),
    Contributions and Linked accounts as tabs, and Delete, Mark done or
    Reopen, Cancel and Save. A goal has one source of saved: its linked
    accounts and holdings, or, with none, what is logged to it.
  - **Debts**: how many, Avalanche or Snowball from two debts up (saved for
    the household), then Owed, when they clear (at the minimums, or with the
    extra) and the interest still to pay. A table gives each debt's owner,
    name and note, a Not in net worth chip with Link account when no valued
    account carries it, what is owed (or In credit), the rate, the minimum,
    when it clears at its minimum and how far it is paid down. A rate or
    minimum of 0 is named for checking. **Extra a month** is typed in
    place: it says at once when the debts clear and what it saves in
    interest against the minimums, and Make this the plan saves it (Not
    saved and Reset until then). In one person's view it is read only: the
    extra is the household's.
  - **A debt** opens through its address (`/planning?debt={id}`) in the
    kit's drawer: the balance, the account that carries it (or Create a
    loan account), name, note, rate, minimum, original amount and owner.
- **Notes**: the household plan in words, private to the household. The
  list of notes sits beside the chosen one, due checks first, then yearly
  notes, then the rest; the chosen note is in the address
  (`/planning?tab=notes&note={id}`). A note's body takes `#` headings, `-`
  bullets and `**bold**`, and is written in the kit's drawer (+ Note, or
  Edit on the note). A note can be checked once a year (insurance, wills,
  nominations): it says when it was last checked, "Checked today" records it
  while it is due, and Overview's Needs attention asks for it a year later,
  or at once until it first is; its Open note opens that note.

## Settings (`/settings`)

- **Household**: the household's name and rupee rate in a card, each saved
  when it is left, with when the rate was last set; beside it the members as
  a table (Name, Role, Login, Telegram), and + Member in the page header. A
  member opens in a drawer: name, role, and Login and Telegram as chips with
  Link. A placeholder member stands for a partner who has not signed in. An
  owner manages the roster; a member who is not an owner renames themselves,
  links their own Telegram, and sees the others read-only. A second member's
  login is made by the owner (`docs/second-member.md`).
- **Categories & rules**: categories and subcategories, whose cost each is
  (shared or one person's), savings categories, what stops when work stops,
  and merchant rules. `?tab=categories&rule=<id>` opens one rule's editor.
- **Telegram**: what the bot sends, as two cards of switches (the
  household's): the morning message (missed bills, card due dates, cash
  cover, unusual spending, the weekly and month-end brief, and budget alerts,
  which are set on Budget) and the questions that need an answer (card
  statements, dividends, month-end balances). Linked accounts shows who is
  linked; Link opens a drawer (`?tab=telegram&link=<member>`) with Open
  Telegram, a QR code of the same link and the one-time code with Copy. Open
  Telegram and the QR code need the bot's username as the build setting
  `VITE_TELEGRAM_BOT`; without it the code alone is offered. Diagnostics,
  folded, count the messages the bot handled over 30 days.
- **Backups**: when the data was last exported and last restored from an
  export, and a form to record each one (`backup_records`). Needs attention
  says when an export is more than 35 days old or the last one failed.

## Telegram bot (`supabase/functions/telegram-webhook`)

- Records share trades from a message: "bought 10 ABC at 120.5", "sold 2 ABC
  at 150 on 24 Oct, brokerage 1", "Partner bought 3 XYZ at 600", "ABC split 10
  for 1". It asks one question at a time for whatever is missing (which
  holding, how many, the currency of a share not yet held, the price; a price
  in another currency is asked again, never converted), then confirms with
  the database's own figures (the holding before and after, the profit, the
  broker fund's movement, and any warning) and saves only on a "yes" or 👍. A
  share bought for the first time becomes a new holding with its price-feed
  symbol and fund shown. "undo last trade" undoes the sender's latest trade
  the same way, and "what did I make on ABC this year?" answers from the
  recorded sales. A traded holding whose value moves by more than 40% between
  two price days with no trade between gets a question about a split.
- Records transfers between the household's own accounts ("paid the card
  3000 from the current account"): it names both accounts and the amount and
  records the transfer on a "yes" or 👍. A side already recorded (the payment
  pasted from the bank's SMS as an expense) becomes part of the transfer
  rather than a second copy, and a transfer already recorded is not recorded
  again.

- Logs expenses, income and refunds from plain text or pasted bank SMS,
  several at once. An SMS or receipt with no date is dated the day it was sent and flagged in the Inbox for the real date. It picks the account by card name or last digits. The
  category comes from a household rule first, then the category the household
  used most for the same merchant across all of its history
  (`merchant_category_counts`), and only then the model's guess. Anything
  uncertain goes to the Inbox. A message read in full that holds no
  expense, income or refund is answered and not kept there, nor is one with
  no amount and no photo that the AI service could not read.
- An entry missing only its category or card is asked about with buttons
  (six categories, or the cards, and "In the Inbox"); a tap fills it in and
  the message becomes the "reply yes" prompt. A tap never records it.
- A paste of several entries is answered with a numbered list of those read
  in full (up to 20; repeats of records already made, and entries missing
  something, are named and left in the Inbox). A reply to the list records
  them: "all on 2 Oct", "1-3, 5 on 2 Oct", or "all" when every SMS had its
  date; "drop 4" sets one aside. Only the sender's reply to the list counts.
- Answers questions: spending by category, net worth, account balances,
  upcoming bills, budget status, holdings. Every figure is read in full; if a
  read fails, it says it could not answer rather than giving a partial figure.
- Reads goal contributions and account balances from a message and asks
  first: it shows the change (old → new) and saves it only on a "yes" or a 👍
  to that message; "no" drops it.
- Nudges and briefs (daily job): bills due and overdue, card payments, budget
  alerts, cash cover and unusual spending go out as one morning message per
  person, after the weekly brief on Mondays and after the monthly review and
  balance check-in on the 1st (one message that morning too). Each card
  statement is asked about on its own: the morning after it closes, and
  once more three days before it is due, unless someone says it is
  reconciled ("done" or 👍).
- Asks each morning about dividends due in a broker's fund, once, one
  message per fund with each line's sum, withholding and net; "yes" or 👍
  records them all, "not yet" or 👎 asks again tomorrow, "no" leaves them
  for the app. When the fund was confirmed on or after the pay date it asks
  whether they were already in that balance instead. A dividend typed in as
  income is not logged in a household with a US or Indian share: the bot
  says where dividends live.

## Scheduled jobs (pg_cron)

| Job | When (UTC) | What |
|---|---|---|
| `daily-recurring-nudge-check` | 05:00 daily | Runs the bot's nudges, briefs and the month-start check-in |
| `weekday-price-refresh` | 23:00 Sun–Thu | Prices, and the rupee rate that re-values holdings, rupee accounts and rupee reminders (`price-refresh`) |
| `daily-fd-accrual` | 23:00 daily | Re-values fixed deposits for the Dubai day (`fd-accrual`) |
| `daily-dividend-refresh` | 01:30 daily | What each followed share pays (Yahoo for Indian shares, Alpha Vantage for US-listed ones), then what each holding earned (`dividend-refresh`) |

`fd-accrual` and `dividend-refresh` run only for their jobs, which send the vault's scheduler secret.
`price-refresh` runs for the job, or for a signed-in household member pressing
Refresh prices on the Investments screen. The bot's webhook needs its own shared
secret. Every secret is compared in constant time.

## Where things live

- App: React + Vite in `src/`; screens in `src/screens`, maths in `src/lib`
  (each with tests alongside).
- Database: Supabase Postgres, schema in `supabase/migrations`, row-level
  security on every table, tests in `supabase/test`.
- Bot and jobs: Deno Edge Functions in `supabase/functions`. Logic shared with
  the app lives in `_shared/applib` and must match `src/lib` (a parity test
  enforces it).
