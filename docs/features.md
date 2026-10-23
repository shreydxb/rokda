# What Rokda does

A map of the app as built: every screen, what the Telegram bot understands,
and what runs on its own. The reasons behind each piece are in
`docs/decisions.md`; open ideas are in `docs/ideas.md`. The household's own
plan (goals, split, open items) is kept in the app under Planning → Notes, not
here, because this repository is public.

## Every page

- "Loaded 14:32 · Refresh" at the top says when the page last read the
  household's records. Pages read again when the tab comes back into view
  (if more than a minute old), every five minutes while in view, and on
  Refresh, without closing an open editor.
- On a phone the top bar holds the nav and one button showing the household
  scope and display currency ("Both · AED ▾"); it opens those switches, light
  mode, sign-out and the build.

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

- In order: the period's income, net spend, income less spending and savings
  rate, each against the same days of the period before (Income also says
  which expected pay is still to come this period, and how much); the cash-flow chart
  (titled by its grouping, with its scale, the running period marked "so
  far", and periods with no records saying so) beside Needs attention (on a
  phone, Needs attention comes first, above the chart); the
  next 30 days; net worth and cash position; data quality as one line that
  opens; then categories, the five newest records (with a link to the rest
  in Activity) and accounts.
- The Both / Me / Partner scope in the sidebar applies throughout (shared rows
  split evenly between the two individual scopes).
- Needs attention: bills and expected income not yet matched, card payments
  due, spending well above a category's usual, items waiting in the Inbox,
  accounts with no balance set, holdings whose price has gone stale, the
  month that just ended until someone closes it, and a backup export that is
  late or failed.
- Upcoming bills and income, with rupee amounts shown in rupees as well.

## Money (`/money`)

- **Activity**: every transaction, with a list and a calendar view, filters,
  and an editor for expense / income / refund. Refunds net against spending.
  Posted / Scheduled / All picks which dates count (Posted by default, like
  every other total); scheduled rows are labelled. Under Me or the partner's
  name, totals are that person's share and shared rows show the share under
  the full amount. Calendar days add up the same way, and open the editor.
  Filters: search, dates (presets or custom), category (a group includes its
  subcategories, and "Uncategorised" shows records with none), account, type, which dates count, needs review, and sort.
  On a phone the second row folds behind "Filters (n)". They are all in the
  address, so Back, reload and a bookmark keep them. The summary shows net
  spend as purchases less refunds, and income. The list shows 200 rows at a
  time; the totals cover everything matching.
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
- **Budget**: month and year views. Spending is budgeted by subcategory and
  rolled up to its group. Savings categories are savings targets measured
  against what the month actually saved, never counted as spending.
  One person's own lines carry their name. **Household share** shows each
  person's plan (own lines plus their income-proportional split of the shared
  ones), what each paid against their part, and the one transfer that evens it up.
- **Recurring**: bills and expected income on a cadence, with an optional
  last date and amounts in AED, USD or INR. Status per occurrence (Paid,
  Posted, Expected, Late, Ended). Income is matched within 10 days of its
  date, bills within 5, and a salary counts in the month it was due. What
  needs marking paid comes first (late, then due soon, a late one saying when
  it was due), the rest by next date; ended schedules fold under "Ended".
- **Insights**: what moved month on month. Every category figure, card and
  merchant opens its records in Activity for the month on screen. Top
  merchants follows the selected month, net of refunds.
- Money and the AED-entered plans (Plan, Goals, Debt payoff) stay in AED
  whatever the display currency, and say so when another one is picked.
- **Inbox**: transactions the bot was not sure of, to confirm or fix. An entry
  whose message had no date is marked "No date" and is approved only once its
  date is set or confirmed, never in bulk.
- **Review**: the month just ended (or an earlier one), as a checklist of
  what to settle before its totals go into history: flagged records,
  records with no category, possible duplicates ("Both are real", remembered
  so the pair is never asked about again, or "Delete one"), pairs that look like an unjoined transfer (joined
  in one tap; never holds the month up), the card statements that closed in
  the month, balances confirmed since it ended, and closing it under Net
  worth, plus a note of refunds not yet linked to their purchase. Each check
  is worked out from the records and ticks itself off; the
  close marks the month reviewed. A "Next" card above the checks names the
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
- **Accounts**: bank, card, loan, cash, investment and fixed-deposit accounts.
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
  Refresh re-reads what is stored.
- **Statements**: one section per card (when it closes and is due), with the
  statements still to check first and the settled ones folded under
  "Checked". Each statement shows its period and status, then three figures
  side by side: what Rokda recorded for the period (to the cent, signed),
  the statement's own figure when recorded, and the difference, which way it
  goes. Its buttons sit in one row underneath: "Mark done" (or "Resolve…" for
  one that did not match), its transactions, and "Reopen…" for a settled one;
  the bot asks about each until it is settled (`statement_reconciliations`).

## Planning (`/planning`)

- **The assumptions bar** at the top of Forecast, Life plan and Drawdown,
  in the same order and words on each: the scenario (Baseline,
  Conservative, Optimistic, Custom), today's or future money (Drawdown is
  today's money only), growth (return, inflation, after inflation, and what
  else the view depends on), and the spending the view is built on. Edit
  assumptions changes the shared return, inflation and withdrawal rate from
  any of them. The scenario and the money shown hold across the three tabs
  until changed, and are never saved.
- **Plan**: one page answering "are we on track". Once ages are set it opens
  with the Life plan's Stop working card (the year, the ages then, the
  spending after work stops it assumes), then goals and linked debts.
- **Life plan**: a year-by-year timeline from today to the last life
  expectancy: saving and growth while working, each goal paid in its year,
  dated lump sums (policy maturities) and later income, then spending once
  work stops, less what stops with work (EMIs, rent where set). Solves for the
  earliest year work can stop.
- **Goals**: targets in today's cost with their own inflation, in four
  kinds, each goal with one status. Due within 3 years: paid from cash
  (logged contributions and linked current, savings and cash accounts, no
  growth), with the cash a month as it really falls. Kept, like an emergency
  fund: held in cash. Later: paid by the Life plan, whose timeline says
  covered or short. No date: in no plan. The priority table covers later
  goals only, closed, as a what-if. The goal editor sets spent or kept.
- **Debt payoff**: leads with when the debts clear at their minimums and the
  interest still to pay. Each debt shows what is owed, its rate, its minimum
  and when it clears, labelled. An extra payment is a what-if, against the
  minimums, beside the rule to fill the cash reserve first. Avalanche or
  snowball from two debts up, saved for the household and followed by Plan.
- **Forecast**: projection of net worth under scenario sets, with the saving
  needed by year. Once ages are set it leads with the Life plan's stop year
  and whether the plan's own stop year lasts; the lasts-forever and lean
  targets sit under "Other ways to look at the plan". In "If things change",
  alternatives that leave the year where it is fold into one line ("3 make
  no change") that opens.
- **Drawdown**: the Life plan's stress test from its stop year: how long the
  pot lasts, with a market fall early or late.
- **Notes**: the household plan in words, private to the household.

## Settings (`/settings`)

- **Household**: members, roles, and a placeholder member for a
  partner who has not signed in. An owner manages the roster; a member who
  is not an owner renames themselves, links their own Telegram, and sees the
  others read-only. A second member's login is made by the owner
  (`docs/second-member.md`).
- **Categories & rules**: categories and subcategories, whose cost each is
  (shared or one person's), savings categories, what stops when work stops,
  and merchant rules. `?tab=categories&rule=<id>` opens one rule's editor.
- **Telegram**: linking, and which nudges and briefs each person gets.
- **Backups**: when the data was last exported and last restored from an
  export, and a form to record each one (`backup_records`). Needs attention
  says when an export is more than 35 days old or the last one failed.

## Telegram bot (`supabase/functions/telegram-webhook`)

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
  uncertain goes to the Inbox.
- Answers questions: spending by category, net worth, account balances,
  upcoming bills, budget status, holdings. Every figure is read in full; if a
  read fails, it says it could not answer rather than giving a partial figure.
- Reads goal contributions and account balances from a message and asks
  first: it shows the change (old → new) and saves it only on a "yes" or a 👍
  to that message; "no" drops it.
- Nudges and briefs (daily job): bills due and overdue, card payments, budget
  alerts, cash cover, unusual spending, a weekly and a monthly brief, a
  balance check-in on the 1st of each month, and each card statement from the
  day after it closes until someone says it is reconciled ("done" or 👍).

## Scheduled jobs (pg_cron)

| Job | When (UTC) | What |
|---|---|---|
| `daily-recurring-nudge-check` | 05:00 daily | Runs the bot's nudges, briefs and the month-start check-in |
| `weekday-price-refresh` | 23:00 Sun–Thu | Prices, and the rupee rate that re-values holdings, rupee accounts and rupee reminders (`price-refresh`) |
| `daily-fd-accrual` | 23:00 daily | Re-values fixed deposits for the Dubai day (`fd-accrual`) |

`fd-accrual` runs only for the job, which sends the vault's scheduler secret.
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
