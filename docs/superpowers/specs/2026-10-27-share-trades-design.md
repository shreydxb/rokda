# Share trades: buys and sells by Telegram, with their cash side

Design for SHR-367 (B2 on the household's tracker). Status: written 27 October 2026, waiting on the household's review. This repository is public: every figure below is a round example, never the household's.

## 1. What this is

Holdings change today only when someone edits each one in the app, or when a broker's statement or screenshot is applied by hand. Nothing records a sale or what it made, and the money from a sale appears nowhere.

**Done when** a member tells the bot "sold 2 ABC at 150" (or forwards the broker's confirmation), confirms what the bot shows, and then:

- the trade is kept, dated, with its brokerage and, for an Indian sale, the tax deducted;
- the holding's units and average price match the broker's;
- the profit or loss on a sale is recorded;
- the money has moved into or out of the broker's fund account, so net worth does not jump or drop on the day of a trade;
- nothing is saved twice, and nothing is half-saved.

## 2. What the household decided

1. **A fresh start.** Each holding starts from today's units and average price, taken from the broker. History before that is not rebuilt. A sale's profit is worked against that average, as the broker works it.
2. **Telegram is the way in**: a message, or a forwarded broker confirmation screenshot. The app shows the trades and is where an older one is fixed.
3. **Every buy and sell has a cash side.** A sale's money stays at the broker until it is used or moved; a buy is paid from it. The bot asks when a message does not say.
4. **Each broker's cash is an account in the app** ("Broker funds"): one for the dollar broker, one for the rupee broker, per member who uses them. The 1st-of-month check-in confirms their balances.
5. **Brokerage counts** on buys and sells at both brokers.
6. **Indian sales:** the broker deducts tax at the sale and emails a statement. After an Indian sale the bot asks for it. The broker's statement is the authority for tax; the app does not compute tax.
7. **Dividends (SHR-366) wait** until trades exist, because they need the units held on each ex-dividend date.
8. Approach A: trades are the record, and a holding's units and average price are worked out from them.

## 3. What is stored

### 3.1 `holding_trades`

One row per entry, in the holding's currency.

| Column | Meaning |
|---|---|
| `id`, `household_id`, `holding_id` | `(household_id, holding_id)` references `holdings (household_id, id)` |
| `member_id` | who traded (the holding's owner, or the member who said so) |
| `kind` | `opening`, `buy`, `sell`, `split` |
| `trade_date` | the date on the broker's confirmation, in the household's day |
| `traded_at` | optional timestamp, when the confirmation shows one; orders two trades on the same day, and later tells dividends which side of an ex-date a late-night US trade fell |
| `units` | numeric(20,8), > 0. For `split`, the ratio (new units per old unit, e.g. 10, or 2 for a 1:1 bonus) |
| `price` | numeric(18,6), per unit; null for `split` |
| `fees` | numeric(16,4), >= 0: brokerage and charges |
| `tax_withheld` | numeric(16,4), >= 0, sells only |
| `tax_to_confirm` | true on an Indian sale until the broker's statement is read |
| `funds_account_id` | the account the money moved through; required for buy and sell, null otherwise |
| `cash_amount` | what moved in the fund's currency: −(units × price + fees) on a buy, units × price − fees − tax on a sell |
| `units_after`, `avg_after`, `realised` | written by the recompute (3.4); `realised` on sells only |
| `source` | `opening`, `bot`, `app`, `statement` |
| `proposal_id` | the bot proposal that saved it; unique when set |
| `note`, `created_at`, `created_by` | |

Constraints (each gets a case in `migration-behaviour.test.sql`):

- one `opening` row per holding (unique partial index);
- `price` is set exactly when `kind` is `buy`, `sell` or `opening`;
- `funds_account_id` is set exactly when `kind` is `buy` or `sell`, and that account's currency equals the holding's (trigger);
- for an `india_equity` holding, `units` on buy, sell and opening is a whole number;
- no trade is dated before its holding's opening entry.

**Nobody writes this table directly.** Members can read it (RLS through the household; a case in `rls-policies.test.sql`); every write goes through the functions in 3.4, so the sums cannot be bypassed and a trade cannot be forged or edited without them. This is the pattern `account_balance_events` already uses.

### 3.2 Changes to `holdings`

- `quantity` widens to numeric(20,8) and `avg_price` to numeric(18,6). Fractional US shares carry 8 decimals; at 4, selling a whole fractional holding reads as selling more than is held.
- `funds_account_id`: the fund a trade on this holding uses unless told otherwise.
- `trades_version` integer, raised by every recompute. A bot proposal remembers it; see 5.6.
- **Once a holding has an opening entry, its `quantity` and `avg_price` change only through the recompute.** A trigger refuses any other change to them (the recompute sets a transaction-local flag). The holding editor shows them read-only, with "Record a trade" instead.
- A holding with buy or sell trades cannot be deleted; delete its trades first (which reverses their cash), or leave it closed.
- A holding sold to zero is **closed**: kept, value 0, out of the current lists, shown under "Sold". A later buy of the same stock by the same member reopens it rather than creating a second holding.

### 3.3 The fund accounts

A new account type, `broker_funds`, in the holding's currency. Where it counts:

| Place | Counts it? | Why |
|---|---|---|
| Net worth | yes | it is the household's money |
| Life plan start (`planningModel.js` cash types) | yes, as cash | it is cash, not invested |
| Overview cash cover, liquid assets (`overviewMath.js`, `useOverviewData.js`, `cashCover.js` and its `applib` copy) | no | money at a broker does not pay bills |
| Near-term goals held in cash (`goals.js`) | no | the same |
| Bot: accounts offered for spending (card and name matching) | no | "paid 50 cash" must never land in a broker fund |
| Bot: 1st-of-month balance check-in | yes | the household confirms it monthly |
| Accounts screen and account editor | yes | its own group, "Broker funds" |

Every list above is a place the type must be added or deliberately left out; the plan names each file.

A trade moves the fund's balance by `cash_amount`. The check-in still sets the true balance; trades move it in between. **A trade that happened before the fund's balance was last confirmed does not move it**, whether it is recorded late, back-dated, fixed or deleted: the confirmed figure already includes it, and moving it again would count the money twice. A trade's moment is its `traded_at`, or the end of its trade date when there is none. The confirmation says so: "Dollar broker funds was confirmed on 1 Nov, after this trade, so its balance stays." A trade does not advance `balance_as_of`, which records when a person last confirmed the figure. The existing `accounts_record_balance_change` trigger records each movement in `account_balance_events` (source `bot` or `app`).

### 3.4 Where the sums live

In the database, in one place:

- `preview_trade(...)`: works out what a trade would do (units and average after, profit, cash, warnings) without saving. The bot's confirmation and the app's form both show its answer.
- `record_trade(...)`, `fix_trade(...)`, `delete_trade(...)`: save, change or remove a trade, then recompute.
- The recompute: lock the holding row, replay its entries in order from the opening entry, write `units_after`, `avg_after` and `realised` on each, set the holding's `quantity` and `avg_price`, adjust the fund by the change in each trade's `cash_amount`, recompute the holding's `value_aed` from its current price and today's history point, raise `trades_version`. All of it in one transaction: it all happens or none of it does.

The functions are `security definer` with a fixed `search_path`, refuse anyone who is not a member of the holding's household, and are not callable by `anon`. The bot calls them with the service role and the confirming member's id, as `apply_bot_proposal` does today.

The preview and the save run the same SQL, so what the bot shows is what is saved, to the last decimal. Any JavaScript that formats these figures for both the app and the bot lives in `applib` and is kept identical by the parity test.

## 4. The sums

All in the holding's currency.

- **Opening:** units and average as the broker shows them.
- **Buy** of `u` at `p` with fees `f`: units become `U + u`; average becomes `(U × A + u × p + f) ÷ (U + u)` if this broker puts brokerage into the average, else `(U × A + u × p) ÷ (U + u)`, and the brokerage shows only in the fund's movement, as that broker shows it. Fund: `−(u × p + f)`.
- **Sell** of `u` at `p` with fees `f` and tax `t`: refused if `u > U`. Units become `U − u`; the average stays. Profit: `u × (p − A) − f`. After tax: profit `− t`, shown beside it. Fund: `u × p − f − t`. At zero units the holding closes and keeps its last average.
- **Split** by ratio `r`: units `× r`, average `÷ r`. No cash, no profit.
- **Order:** trade date, then `traded_at` (missing last), then when recorded. A back-dated or fixed trade replays everything after it.
- **Refused** when the replay would sell more than was held at that point, or date a trade before the opening entry.
- **Rounding:** units to 8 decimals, average to 6, money to 4 in storage; shown as the broker shows them (2 decimals for money).
- **Brokerage in the average** is a setting per fund account, decided from the household's samples of each broker's confirmation. Until the samples arrive the default is "not in the average", the common way brokers show it.
- **In dirhams:** a profit is kept in the holding's currency. Totals in AED convert a dollar profit at the peg and a rupee profit at the rate on its trade date (`fx_rate_history`).

Worked example: 10 held at 100. Buy 5 at 130: 15 at 110. Sell 6 at 150 with fees of 1: profit 6 × (150 − 110) − 1 = 239; 9 left at 110; the fund gets 899.

## 5. The bot

### 5.1 What it understands

- Text: "bought 10 ABC at 120.5", "sold 2.5 ABC at 150 on 24 Oct, brokerage 1", "Partner bought 3 XYZ at 600" (the named member's holding).
- A broker's order confirmation or contract note, as a screenshot or PDF.
- A split or bonus: "ABC split 10 for 1".
- "undo last trade"; questions such as "what did I make on ABC this year?"

### 5.2 Photos

Every photo is treated as a receipt today. The bot first decides whether a photo is a receipt, a trade confirmation, or neither, and asks when unsure. A trade confirmation never becomes an expense.

### 5.3 Reading

It reads side, stock, units, price, currency, date (today if none), time if shown, fees and tax. For trade screenshots it uses a stronger reading model than the receipt model: a misread figure here costs real money, and the confirmation step catches what reading misses either way.

### 5.4 Matching

- The stock is matched to the sender's holdings (or the named member's) by symbol and name, closed holdings included.
- Two holdings could match (two lots of one stock): it asks which.
- No match on a buy: it proposes a new holding with its price-feed symbol (NSE symbols take `.NS`), asset class, sector and fund account, all shown for the member to confirm.
- No match on a sell: it says so and saves nothing.

### 5.5 Questions it asks

One at a time, only for what is missing and needed: units, price, which holding. A price given in another currency than the holding's ("AED 1,500" for a dollar share) is asked about, never converted silently. The fund defaults to the holding's and is shown in the confirmation; the member can reply with another.

### 5.6 The confirmation

Through the existing proposal flow (`bot_proposals`, new kinds for a trade, a fix and an undo; only the sender confirms; "yes" or 👍 saves, "no" drops, it expires):

> Sell 6 ABC at $150 on 27 Oct, brokerage $1
> ABC: 15 → 9 shares, average stays $110
> Profit $239 · Dollar broker funds +$899
> Reply yes or 👍 to save.

The proposal stores the holding's `trades_version`. If anything changed the holding before it is confirmed, applying refuses and the bot sends a fresh preview. Applying runs in `apply_bot_proposal`, which already locks the proposal and saves it once.

Warnings in the confirmation:

- **Possible duplicate:** the same holding, side, units and price within two days of a saved trade: "This looks like the sale saved on 24 Oct. Save it again?"
- **Fund below zero:** "Dollar broker funds would go to −$120. Did you add money? Tell me from which account, or say save anyway."
- **Price far from the market:** more than 20% from the holding's last price: "Check the price: ABC was last $150."

### 5.7 After an Indian sale

The trade is saved with `tax_to_confirm`. The bot asks for the broker's statement or a screenshot. Reading it proposes a fix with the tax and charges, which the member confirms. A daily reminder follows for up to seven days while one is unconfirmed.

### 5.8 Undo

"undo last trade" proposes deleting the sender's most recent trade. That reverses its cash and replays the holding. Anything older is fixed in the app.

## 6. The app

- **Holding editor:** the trades list (date, kind, units, price, fees, tax, profit); "Record a trade" (the same fields, previewed through `preview_trade` before saving); fix and delete on each trade, refused with the reason when the replay would fail.
- **Wealth → Investments:** "Profit on sales this year" beside the gains not taken (both in AED), and a "Sold" fold for closed holdings with their trades.
- **Accounts:** the fund accounts in a "Broker funds" group.

## 7. Money into and out of a fund

Money moving between a bank account and a fund is a transfer. Today a transfer is in dirhams only. It gains a second amount when the two accounts' currencies differ: dirhams to dollars at the peg without asking; rupees and dirhams with both amounts, as the bank shows them. If the bank account is not in the app, the money arrives or leaves "from outside the app" with a note, and net worth moves accordingly. That is why 10.1 asks to add it.

## 8. The 1st-of-month check-in

The fund accounts are accounts, so the existing check-in lists them with no change. A gap between the check-in figure and the app's (a dividend, an unrecorded fee, a settlement to the bank) is corrected by the check-in, and shows in the account's history as such.

## 9. What could go wrong, and what stops it

**Saved twice**

- Telegram delivers an update twice: updates are already claimed once (`claim_telegram_update`).
- 👍 pressed twice, or "yes" and 👍: `apply_bot_proposal` locks the proposal and applies it once. `proposal_id` is unique on trades.
- The same trade sent as a message and then as a screenshot: the duplicate warning (5.6).
- Go-live run twice: one opening entry per holding (unique index); the go-live step skips holdings that have one.
- Opening entries from stale figures: a member's holdings get their opening entries only once they have been checked against that member's broker; the partner's wait for their screenshots.
- A second holding for a stock bought again after selling out: the closed holding is reopened (3.2).

**Saved wrong**

- The bot misreads a screenshot: nothing is saved before the member sees and confirms every figure; the price warning catches a misplaced decimal.
- The preview and the save disagree: they run the same SQL (3.4).
- The holding changes between preview and confirm (an app edit, another trade): `trades_version` refuses the stale confirmation.
- A trade on the wrong person's holding: matching uses the sender unless another member is named, and the confirmation names the holding's owner when it is not the sender.
- A sale of more than is held, or back-dated before a buy it depended on: refused by the replay.
- Units typed straight into a traded holding: refused by the trigger (3.2).
- Indian shares in fractions: refused for `india_equity`.
- A dollar trade through a rupee fund: refused (currency check).
- A split never recorded: the price halves and the value with it. A price move of more than 40% in a day on a traded holding makes the bot ask the household whether there was a split. (Detecting splits from the feed's events is left for later.)

**Half-saved**

- A trade saved but the holding or fund not updated: one transaction (3.4).
- The nightly price feed writes a holding's value from units it read before a trade, overwriting the new value: the feed computes the value from the row's current units in the same statement that writes the price, not from units read earlier.
- Net worth counting a sale twice (the fund up, the holding not yet down): both change in the same transaction.

**Drifting from the broker**

- Dividends, interest, fees and settlements to the bank move the broker's cash without a trade: the monthly check-in sets the true balance.
- A late, back-dated, fixed or deleted trade moving a fund whose balance was confirmed after it, counting the money twice: such trades leave the fund alone (3.3).
- Units drift from the broker: the statement check (12, step 4) lists every difference and proposes the trades that explain it.
- Holdings not on the fresh start (no units or average): they get no opening entry and cannot be traded until their units are set; the bot says so.

**Breaking what exists**

- Every place that lists account types (3.3) is updated deliberately, with a test where one exists.
- A fund account archived or deleted under its trades: an archived fund takes no new trades, and a fund with trades cannot be deleted (foreign key).
- The holding editor's existing edits keep working for holdings without trades.
- The price feed skips closed holdings (no wasted price requests).

## 10. Open questions for the household

1. **The Indian bank account** the rupee broker pays out to (and is topped up from): add it to the app? Recommended. Without it, the quarterly settlement reads as money leaving the household.
2. **The bank account** dollar-fund withdrawals go to: is it in the app already?
3. **Brokerage in the average:** settled per broker by the samples (pending).
4. **The partner's broker(s) and fund accounts:** from their screenshots (pending).
5. **The fund balances on go-live day.**

## 11. Out of scope

Tax calculation (the broker's statement is the authority), tax lots and holding periods, dividends (SHR-366), options, margin, short selling, detecting splits from the price feed, rebuilding history before the fresh start.

## 12. Build order

Each step is its own pull request, with the checks in `CLAUDE.md`.

1. **Database and sums:** the migration (3.1 to 3.4), behaviour and RLS tests, the account-type lists (3.3), the price feed's value fix and closed-holding skip, docs. Applied to production on the household's word. Then go-live, per member: once a member's holdings have been checked against their broker, opening entries for each holding with units and an average, and their fund accounts with that day's balances.
2. **Bot:** trade messages and screenshots, matching, questions, the confirmation and its warnings, the Indian-sale follow-up, undo, the two-currency transfer, questions about trades. Needs the brokerage samples first.
3. **App:** the trades list, record, fix and delete, profit on sales, the Sold fold, the Broker funds group.
4. **Statement check:** a holdings statement compared with the app, with the differences and the trades that explain them proposed.
