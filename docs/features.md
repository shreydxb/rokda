# What Rokda does

A map of the app as built: every screen, what the Telegram bot understands,
and what runs on its own. The reasons behind each piece are in
`docs/decisions.md`; open ideas are in `docs/ideas.md`. The household's own
plan (goals, split, open items) is kept in the app under Planning → Notes, not
here, because this repository is public.

## Signing in

- Email and password, with "Keep me signed in". Sign-ups are closed: logins
  are added in the Supabase dashboard.
- **Forgot password?** emails a link that opens **Set a new password**; the
  app opens once the new one is saved. A link that has expired or was already
  used opens **Reset password** instead, saying so.

## Overview (`/`)

- Net worth and cash position, with the Both / Me / Partner scope in the
  sidebar (shared rows split evenly between the two individual scopes).
- Needs attention: bills and expected income not yet matched, card payments
  due, spending well above a category's usual, items waiting in the Inbox,
  accounts with no balance set, holdings whose price has gone stale, and a
  backup export that is late or failed.
- Upcoming bills and income, with rupee amounts shown in rupees as well.

## Money (`/money`)

- **Activity**: every transaction, with a list and a calendar view, filters,
  and an editor for expense / income / refund. Refunds net against spending.
- **Budget**: month and year views. Spending is budgeted by subcategory and
  rolled up to its group. Savings categories are savings targets measured
  against what the month actually saved, never counted as spending.
  One person's own lines carry their name. **Household share** shows each
  person's plan (own lines plus their income-proportional split of the shared
  ones), what each paid against their part, and the one transfer that evens it up.
- **Recurring**: bills and expected income on a cadence, with an optional
  last date and amounts in AED, USD or INR. Status per occurrence (Paid,
  Posted, Expected, Late, Ended). Income is matched within 10 days of its
  date, bills within 5, and a salary counts in the month it was due.
- **Insights**: what moved month on month, drilling into Activity.
- **Inbox**: transactions the bot was not sure of, to confirm or fix. An entry
  whose message had no date is marked "No date" and is approved only once its
  date is set or confirmed, never in bulk.

## Wealth (`/wealth`)

- **Net Worth**: history from dated balance snapshots and valuations.
- **Accounts**: bank, card, loan, cash, investment and fixed-deposit accounts.
  Balances are entered by hand and confirmed, never derived. Every change is
  kept with the figure it replaced, where it came from (app, bot or system)
  and who made it (`account_balance_events`). A balance in
  rupees is valued at the household's current rate, and moves when the rate
  does. Cards carry a limit, statement day and due day. A loan account can
  carry its debt terms. Closed accounts stay in history.
- **Investments**: holdings with prices pulled daily where a symbol is set,
  and FX rates for USD and INR.
- **Statements**: each card's recent statements, the period each covers, its
  due date, what Rokda recorded for that period (to the cent, signed, with
  its transactions listed) against the statement's own figures when recorded,
  and whether it has been reconciled (`statement_reconciliations`). "Mark
  done" settles one, "Resolve…" settles one that did not match, and
  "Reopen…" undoes either; the bot asks about each until it is settled.

## Planning (`/planning`)

- **Plan**: one page answering "are we on track", including the Stop working
  card from the Life plan and linked debts.
- **Life plan**: a year-by-year timeline from today to the last life
  expectancy: saving and growth while working, each goal paid in its year,
  dated lump sums (policy maturities) and later income, then spending once
  work stops, less what stops with work (EMIs, rent where set). Solves for the
  earliest year work can stop.
- **Goals**: targets in today's cost with their own inflation, funded in
  priority order. One monthly figure per goal and in total.
- **Debt payoff**: avalanche / snowball / custom order, with extra payments.
- **Forecast**: projection of net worth under scenario sets, with the saving
  needed by year.
- **Drawdown**: the Life plan's stress test from its stop year: how long the
  pot lasts, with a market fall early or late.
- **Notes**: the household plan in words, private to the household.

## Settings (`/settings`)

- **Household**: members, roles, invitations, and a placeholder member for a
  partner who has not signed in.
- **Categories & rules**: categories and subcategories, whose cost each is
  (shared or one person's), savings categories, what stops when work stops,
  and merchant rules.
- **Telegram**: linking, and which nudges and briefs each person gets.
- **Backups**: when the data was last exported and last restored from an
  export, and a form to record each one (`backup_records`). Needs attention
  says when an export is more than 35 days old or the last one failed.

## Telegram bot (`supabase/functions/telegram-webhook`)

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
Refresh on the Investments screen. The bot's webhook needs its own shared
secret. Every secret is compared in constant time.

## Where things live

- App: React + Vite in `src/`; screens in `src/screens`, maths in `src/lib`
  (each with tests alongside).
- Database: Supabase Postgres, schema in `supabase/migrations`, row-level
  security on every table, tests in `supabase/test`.
- Bot and jobs: Deno Edge Functions in `supabase/functions`. Logic shared with
  the app lives in `_shared/applib` and must match `src/lib` (a parity test
  enforces it).
