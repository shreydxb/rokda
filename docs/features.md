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
  marked "AED estimated", which Activity can filter to and the monthly review
  asks about. The Inbox takes a rupee entry from the bot the same way.
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
- Money and the AED-entered plans (Plan, Goals, Debt payoff) stay in AED
  whatever the display currency, and say so when another one is picked.
- **Categories**: a record is filed under a category with no subcategories;
  pickers list them as "Group › Category" (Shopping, with none, stands
  alone). A record already under a group keeps it.
- **Inbox**: transactions the bot was not sure of, to confirm or fix. An entry
  whose message had no date is marked "No date" and is approved only once its
  date is set or confirmed, never in bulk. The undated entries of one
  message that read cleanly otherwise are offered together above the queue:
  one date, given by hand, approves them all. An undated entry that repeats
  a record made in the two weeks before it was sent (same card, same amount,
  same merchant) is marked "Recorded", left out of that, and "Set aside N
  already recorded" rejects them together. Its editor offers "Remember this
  merchant", unticked, for an expense with a category chosen whose merchant
  no rule covers: the entry is approved, then the rule is added.
- **Review**: the month just ended (or an earlier one), as a checklist of
  what to settle before its totals go into history: flagged records,
  records with no category, possible duplicates ("Both are real", remembered
  so the pair is never asked about again, or "Delete one"), pairs that look like an unjoined transfer (joined
  in one tap; never holds the month up), the card statements that closed in
  the month, balances confirmed since it ended, and closing it under Net
  worth, plus a note of refunds not yet linked to their purchase. Each check
  is worked out from the records and ticks itself off; the
  close marks the month reviewed, and is done here ("Close October 2026"
  under what goes into history), whatever else is open: the checks still
  open are named, and can be finished after. A "Next" card above the checks names the
  first one still to do, with its link; each link out of the review offers
  "Back to the review" on the page it opens. Under the checks, the month
  against its budget and the groups that went over; what the close puts into
  history (income, spending, saving and its rate, and net worth against the
  last month closed); and a short ranked list of what to do next: bills in the
  next 30 days the money to hand won't cover, goals behind their pace, spending
  over budget, and saving short of its target. Overview's "hasn't been closed"
  item opens it. Finished checks fold under "Done (n)", with the suggestions
  that found nothing counted apart ("Nothing to do (n)"), so what is still
  open leads.

## Wealth (`/wealth`)

- **Net worth**: history from dated balance snapshots and valuations.
- **Accounts**: bank, card, loan, cash, investment, fixed-deposit and broker funds accounts (a broker's uninvested cash, which trades move).
  Balances are entered by hand and confirmed, never derived. Every change is
  kept with the figure it replaced, where it came from (app, bot or system)
  and who made it (`account_balance_events`). A balance in
  rupees is valued at the household's current rate, and moves when the rate
  does. Cards carry a limit, statement day and due day. A loan account can
  carry its debt terms. Cards sit under their own heading with "+ Add card";
  closed accounts fold under "Closed (n)" and stay in history. Account types
  read as words ("Credit card", "Fixed deposit"), never as stored.
- **Investments**: holdings with prices pulled daily where a symbol is set,
  and FX rates for USD and INR. "Refresh prices" fetches them; the page's own
  Refresh re-reads what is stored. Under Allocation, one line names the
  largest concentration, a sector or a single holding, and its share of
  investments (cash left out), against the household's cap: "above your 25%
  cap" in warning colour, or within it. "Set a cap" sets it in place, for the
  household. A share or share fund is tagged with its sector once, in its
  editor: one of the market sectors, or for an Indian holding the sector its
  broker's statement gives it (Defence, FMCG, Auto ancillary and the like);
  a fund spread across sectors is tagged so, and counts in no sector. Each
  holding's buys, sells and splits are kept as dated trades from its fresh
  start (`holding_trades`); its units and average price are worked out from
  them, and read-only in its editor once it has them. A trade moves the
  broker's funds account and the holding's value together. The editor lists
  a traded holding's trades, newest first, with brokerage, tax and what each
  sale made; "Record a trade" (buy, sell or split), "Fix" and "Delete" are
  checked by the database first, and saved exactly as shown. A holding sold
  down to nothing moves to a "Sold" fold with what its sales made, and
  "Profit on sales this year" (in dirhams, a rupee sale at its own day's
  rate) sits beside "Profit not yet taken" on what is still held.
  A US-listed or Indian share has a withholding rate on dividends (30% and
  20.8% by default) and a fee per share in its editor, and a broker fund
  says where its holdings' dividends are paid. Each night the dividend feed
  records what every holding earned on each ex-date, at the units its trades
  say it held (`holding_dividends`); a dividend paid into a bank account is
  presumed received 30 days after its ex-date. The editor lists a share's
  dividends under its trades, newest first: date and net, status (earned,
  received, presumed received and not checked, skipped), the sum it came
  from and where it goes, with the reason when the feed has flagged it.
  "Record", "Fix", "Skip" and "Restore" are checked by the database first,
  showing the net and what each fund gains or loses, and asking whether a
  receipt was already in a balance confirmed on its day; "Add a dividend"
  adds one the feed missed. A flagged one can be kept as it is or linked to
  the feed's dividend, and a feed dividend's one-off part given.
- **Dividends**: dividends as passive income, in dirhams and in the scope
  chosen. At the top, what was received in the last twelve months (or since
  the record starts, with the presumed part said apart) and what is expected
  in the next twelve, about so much a month, then one line per market. Under
  it: "Coming up", the earned and declared dividends still to come in, with
  "Record" for one that arrived; "Needs you", the flagged dividends, the
  one-off questions ("Yes, part was a one-off" / "No, all ordinary"), splits
  the trades don't show and dividends to add by hand; "By month", a bar a
  month (presumed receipts paler, the year ahead lighter) with a total per
  year, switching between Received and Earned (a receipt with no ex-date is
  left out of Earned, and it says how many); "By holding", each share's
  rhythm, last amount, received, expected, yield on value and on cost, and
  next payment, opening its dividends, with the shares that paid nothing,
  whose checks fail or that are not checked yet in folds; "Where it comes
  from", expected by market (with its withholding) and by sector; and "How
  fresh this is", when each market's feed last checked, how far back its
  history goes, any failing checks, and what the figures leave out.
  Last, "Tax years": each member's Indian dividends by tax year, in rupees,
  one row per member and year saying the dividends and tax withheld (the
  presumed part and a provisional year said), how they stand against the
  AIS and Form 26AS ("agrees with AIS and 26AS", "1 difference", "26AS not
  added"), and where the year stands: before filing, what could come back
  at that year's claim basis; after, the dividend tax surplus or shortfall
  and the refund ("refund … credited 5 Oct", "… unexplained"). Opened, each
  share is shown against both statements with any possible cause, its
  dividends with "Set tax year" (a final dividend declared in March counts
  in the March year), the return with "Edit" (claim basis, filed or
  revised, the dividend figures), and what happened to the refund with
  "Add", "Fix" and "Remove". Shared holdings are named apart, since a
  return is one person's.
- **Statements**: one section per card (when it closes and is due), with the
  statements still to check first and the settled ones folded under
  "Checked". Each statement shows its period and status, then three figures
  side by side: what Rokda recorded for the period (to the cent, signed),
  the statement's own figure when recorded, and the difference, which way it
  goes. Its buttons sit in one row underneath: "Mark done" (or "Resolve…" for
  one that did not match), its transactions, and "Reopen…" for a settled one;
  the bot asks about each once and reminds once before it is due
  (`statement_reconciliations`).

## Planning (`/planning`)

Five tabs: Plan, Life plan, Goals, Debt payoff, Notes. An old link to
Forecast or Drawdown, which went (Planning audit, 3.15), opens the Life plan.

- **The assumptions bar** at the top of the Life plan: the scenario
  (Baseline, Conservative, Optimistic, Custom), today's or future money,
  growth (return, inflation, after inflation, and the return after work
  stops), and the spending the plan is built on. Edit assumptions opens the
  plan's drawer at its growth figures. The scenario and the money shown
  hold while moving between tabs, and are never saved. On a phone the bar
  folds to a summary ("Baseline · today's money · 6.0% return · 48K a year
  after work"); Change opens it.
- **Tables on a phone**: the Life plan's year-by-year table and Goals'
  priority table become two-line rows below 640px: the year and the pot, or
  the goal and what it needs today, on the first line, and every other
  column on the second, each figure labelled from its header. Nothing is
  dropped and nothing scrolls sideways.
- **The plan's drawer** (Edit plan and Edit assumptions on the Life plan)
  holds every planning assumption in one place: who the plan is for and the
  age to plan each person to, the year work stops, spending after it (a
  planned figure, essentials only, for one, and the categories that stop),
  the costs that start when work stops, other income, and growth: the return,
  inflation, the return after work stops, which is a point below the
  return until one is set and moves with the scenario, and the return on
  cash, 3% until one is set, the same in every scenario. Costs and income
  open in a drawer over it and are saved as they are added.
- **Planning basis**: every projection (Plan and the Life plan) opens with
  one line saying what it is worked out on: your budget
  or the recorded months, why, and from which month the records count.
  Change basis chooses the budget or the recorded months and the month
  records count from, saved for the household. With nothing chosen, the
  budget stands in until three months have ended, then the records.
- **Plan**: one page answering "are we on track". Once ages are set it opens
  with the Life plan's Stop working card (the year, the ages then, Baseline
  and Conservative at that year, the spending after work stops it assumes),
  then goals and linked debts. Until ages are set, the card asks for them
  rather than giving a target; with not enough to project, it says the Life
  plan lists what is missing. A
  monthly check follows, for the household: saving in the month just ended
  against the budget's savings target (Review's check), and the cash reserve
  in months of spending against what the kept goals hold. Then what needs a
  decision.
- **Life plan**: leads with the year work stops (saved, being tried, or
  assumed) and Baseline and Conservative side by side at that year, each
  with what is left at the end or when the money runs out; the earliest year
  with nothing to spare is a lever under "What it would take". Under the
  headline it says what the start leaves out (accounts with no AED value,
  holdings never valued) and balances never entered, counted as 0. With
  not enough to project it lists what is missing, item by item, with where
  to add it. Then a
  year-by-year timeline from today to the last life expectancy: saving and growth while working, each goal paid in its year,
  dated lump sums (policy maturities) and later income, then spending once
  work stops, less what stops with work (EMIs, rent where set), plus the
  costs that start then: health cover and visa fees, for the household or
  each person, rising above inflation from now if set
  (`after_work_costs`). Solves for the
  earliest year work can stop. A loan paid out of spending is counted once:
  the plan starts before what it owes, and saving rises by its instalment
  once it clears at the minimum. The chart switches between the pot by phase
  and the working years split into what each year's saving adds and what the
  pot earns, with the year the pot starts earning more. "If markets fall" puts the plan at its stop
  year through the same two-year fall the year work stops and ten years in,
  on Baseline, beside a steady return: whether each lasts, the stop year that
  weathers the early fall, what the first year without work takes from the
  pot, and the pot's path against the steady one. The cash and deposits held
  today stay cash at the return on cash; the rest earns the return. When
  anything is in rupees (accounts or holdings, other income, a cost), "If the
  rupee weakens" sets the plan with the rupee losing 3% a year against the
  dirham beside the plan as it is: what is left at the end, and the earliest
  stop year, each way.
- **Goals**: targets in today's cost with their own inflation, in four
  kinds, each goal with one status. Due within 3 years: paid from cash
  (logged contributions and linked current, savings and cash accounts, no
  growth), with the cash a month as it really falls. Kept, like an emergency
  fund: held in cash. Later: paid by the Life plan, whose timeline says
  covered or short. No date: in no plan. The priority table covers later
  goals only, closed, as a what-if. The goal editor sets spent or kept, what
  the household plans to put in a month (measured against what a goal held
  in cash needs, and a goal it covers is not raised on Plan), and done: a
  done goal is listed apart and left out of every plan and the bot, and can
  be reopened. A goal has one source of saved: its linked accounts and
  holdings, or, with none, what is logged to it. A goal held in cash shows
  its pace over about three months, from its linked accounts' recorded
  balance changes or from what is logged.
- **Debt payoff**: leads with when the debts clear at their minimums and the
  interest still to pay. Each debt shows what is owed, its rate, its minimum
  and when it clears, labelled. An extra payment is a what-if, against the
  minimums, beside the rule to fill the cash reserve first. Avalanche or
  snowball from two debts up, saved for the household and followed by Plan.
- **Notes**: the household plan in words, private to the household. A note
  can be checked once a year (insurance, wills, nominations): it says when it
  was last checked, "Checked today" records it, and Overview's Needs
  attention asks for it a year later, or at once until it first is.

## Settings (`/settings`)

- **Household**: members, roles, and a placeholder member for a
  partner who has not signed in. An owner manages the roster; a member who
  is not an owner renames themselves, links their own Telegram, and sees the
  others read-only. A second member's login is made by the owner
  (`docs/second-member.md`).
- **Categories & rules**: categories and subcategories, whose cost each is
  (shared or one person's), savings categories, what stops when work stops,
  and merchant rules. `?tab=categories&rule=<id>` opens one rule's editor.
- **Telegram**: linking, and which nudges and briefs each person gets
  (the morning dividend question among them).
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
