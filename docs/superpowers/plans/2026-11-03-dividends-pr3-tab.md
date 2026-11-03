# Dividends, part 3: the Dividends tab, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Dividends tab on Wealth that shows dividends as passive income. It keeps Earned, Expected and Received apart, projects the next twelve months as a labelled forecast, and says which periods each market covers.

**Architecture:**
- **Database:** works out what was earned and what moved (parts 1 and 2). This part adds only a members' read of the feed's freshness and widens who may answer a one-off question.
- **App sums:** the app reads the household's dividends, the feed's events and splits, and that freshness. It works out dirhams, today's basis, one-offs, frequency, the next twelve months and every summary in three pure files under `src/lib`.
- **Screen:** `src/screens/wealth/Dividends.jsx` lays the summaries out, and reuses part 2's `HoldingDividends` and `DividendForm` for Record and Fix.

**Tech Stack:**
- React 19 and Vite, Vitest with Testing Library, Playwright (desktop and phone);
- Supabase Postgres with SQL tests;
- one Deno Edge Function change.

**Spec:** `docs/superpowers/specs/2026-11-02-dividends-design.md`:
- section 4, the sums;
- section 6, the tab;
- section 8, the scenarios marked 3 and PR 3's "done when".

Parts 1 and 2 are merged: shreydxb/rokda#152 and #153.

## Global Constraints

- **Public repository:** generic names and round figures in tests, fixtures, docs, commits and PR text ("ABC", "XYZ", "the dollar broker's fund", 100, 7).
- **One migration:** `supabase/migrations/20261103200000_dividend_tab.sql`. It is applied to production only on "apply and merge", then renamed to the version production gives it.
- **Pure logic:** the spec's `src/lib/dividends.js` is split by responsibility, each file with a `*.test.js` beside it:
  - `src/lib/dividendHistory.js`: today's basis, one-offs, frequency and gaps;
  - `src/lib/dividendForecast.js`: the next twelve months and yields;
  - `src/lib/dividendSummary.js`: dirhams and the tab's summaries.

  `src/lib/dividends.js` keeps part 2's row helpers.
- **Dirhams (spec 4.2):** converted when read, never stored. Use `estimateAed(amount, currency, day, fxHistory, inrPerAed)` from `src/lib/fxHistory.js`:
  - earned and expected figures at the ex-date's rate;
  - received figures at the credit date's rate;
  - projections at today's rate.

  A figure with no rate is unknown, never guessed. A total that leaves one out says how many it left out.
- **Scope:** the screen's scope (household or one member), as on Investments:
  - `visibleHoldings(holdings, scopeMemberId, 'All')`;
  - `scopedValue(aed, holding, scopeMemberId)`, so a shared holding counts half for one member.
- **Display:** amounts are shown through `useMoneyDisplay(household).fmt` (dirhams in, the screen's currency out); per-share amounts use `formatPerShare`.
- **Words:** the screen says Earned, Expected and Received, never "income". It says "after withholding", never "after tax". Projections are labelled as projections.
- **Markets:**
  - `india_equity` is the Indian market ("India");
  - `us_equity` and `intl_equity` are the US market ("US");
  - any other class pays no tracked dividends (`paysDividends` in `src/lib/holdings.js`).
- **Layout:** the `design-taste-frontend` skill's app-screen rules (`references/app-screens.md`) are the checklist; `design/` and Rokda's palette are the look. On a phone, rows are two lines and nothing scrolls sideways.
- **Checks:** every check in `CLAUDE.md` passes before the PR.

## Review Focus

1. **A rupee dividend with no exchange rate** (no history on or before its day, no household rate): left out of every dirham total. The total says "1 not counted: no exchange rate", never shows a smaller sum as complete. *Task 4.*
2. **A shared holding, seen in one member's scope:** every figure is half, received, expected and projected alike. *Task 4.*
3. **A split after the last payment** (the source's history is on older bases): projections are today's units × the amount on today's basis, never ten times too much. *Task 3.*
4. **A holding sold to nothing with an earned dividend not yet received:** it appears in Coming up and in Expected (as earned), and is never projected further. *Task 3.*
5. **A followed share with no feed status yet** (bought today): its row says "not checked yet", never "No dividends found since …". *Task 4.*

---

### Task 1: Feed freshness for members, and one-off answers for any followed share

**Files:**
- Create: `supabase/migrations/20261103200000_dividend_tab.sql`
- Test: `supabase/test/migration-behaviour.test.sql`, `supabase/test/rls-policies.test.sql`

**Interfaces:**
- **Produces `public.dividend_feed_status()`:**
  - Returns `table(symbol text, provider text, kind text, last_success_at timestamptz, last_failure_at timestamptz, fail_count integer, covered_from date)`. It is `stable security definer`, executable by `authenticated` only.
  - The rows are `dividend_feed_state` for the symbols the signed-in member's household holdings follow: `price_symbol` with `private.dividend_provider(h)` not null.
  - It never returns `last_error`, which can hold a provider's request URL.
- **Recreates `public.set_special_part(p_event_id, p_special_per_share, p_member_id)`:** same signature and answers, except the event only has to be one of a symbol a household holding follows. It no longer needs a dividend row on it, so a one-off before an opening entry can be answered.

- [ ] **Step 1: Write the failing cases:**
  - `D3-01` (behaviour): as the service role with `p_member_id`, `set_special_part` accepts an event of a followed symbol on which the household has no dividend row. It refuses (`not_member`) an event of a symbol no holding follows.
  - RLS:
    - signed in as a member of the first household, `dividend_feed_status()` returns its followed symbol's rows and none of the other household's;
    - the result has no `last_error` column;
    - signed out, the call raises `insufficient_privilege`.
- [ ] **Step 2: Run** `bash .superpowers/sdd/2026-11-03-dividends-pr3-tab/sqltest.sh`, a copy of part 2's script that runs both SQL suites on fresh databases. **Expected:** FAIL on `D3-01` and the RLS case.
- [ ] **Step 3: Implement** the migration.
- [ ] **Step 4: Run the same command.** **Expected:** all ok, part 1's and 2's cases included.
- [ ] **Step 5: Commit** (`Dividends: feed freshness for members, and one-off answers for any followed share`).

### Task 2: Keep the API key out of recorded errors

**Files:**
- Modify: `supabase/functions/dividend-refresh/sources.ts`, `supabase/functions/dividend-refresh/index.ts`
- Test: `supabase/functions/dividend-refresh/sources.test.ts`

**Interfaces:**
- **Produces** `redactSecrets(message: string): string` in `sources.ts`. Every `apikey=` value (up to `&`, whitespace, `)` or the end) becomes `apikey=***`. `index.ts`'s `failure()` passes its message through it before `record_dividend_fetch` stores it.

- [ ] **Step 1: Write the failing test** `"a recorded error never carries the API key"`:

  ```ts
  assertEquals(
    redactSecrets("error sending request for url (https://www.alphavantage.co/query?function=DIVIDENDS&symbol=ABC&apikey=SECRET123)"),
    "error sending request for url (https://www.alphavantage.co/query?function=DIVIDENDS&symbol=ABC&apikey=***)",
  );
  assertEquals(redactSecrets("timed out"), "timed out");
  ```
- [ ] **Step 2: Run** the bot test command from `CLAUDE.md`. **Expected:** FAIL (no export).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it again, and `deno check`.** **Expected:** PASS. Delete `deno.lock`.
- [ ] **Step 5: Commit** (`Dividends: keep the API key out of recorded feed errors`).

### Task 3: Today's basis, one-offs, frequency and the next twelve months

**Files:**
- Create: `src/lib/dividendHistory.js`, `src/lib/dividendHistory.test.js`, `src/lib/dividendForecast.js`, `src/lib/dividendForecast.test.js`

**Interfaces:**
- **`dividendHistory.js`:**
  - `marketOf(holding): 'IN' | 'US' | null`.
  - `todayFactor(symbol, exDate, splits): number`: the product of `ratio` over that symbol's splits with `effective_date > exDate` (1 when none).
  - `sharePayments(events, symbol, { splits, specialParts, today }): Payment[]`:
    - which events: the symbol's events with `superseded_by` null, `missed_checks < 2` and `ex_date <= today`, oldest first;
    - each Payment is `{ eventId, exDate, payDate, amount, factor, todayAmount, special, ordinary, ordinaryToday, oneOff }`;
    - `amount`, `special` and `ordinary` are per share on the event's basis; `todayAmount = amount / factor`;
    - `oneOff` is `'answered'` (from `specialParts` by `event_id`), `'candidate'` (spec 4.3) or `null`;
    - **candidate:** `todayAmount` is more than twice the median `todayAmount` of the symbol's payments in the 24 months before its ex-date, with at least three of them; its `special = amount − median × factor`;
    - **answered:** `special` is the answer's `special_per_share`;
    - otherwise `special` is 0.
  - `shareFrequency(payments, coveredFrom, today): { kind, perYear, intervalMonths }`:
    - counts ordinary payments (`ordinary > 0`) with ex-date in the last 24 months, over `months = min(24, whole months from coveredFrom to today)`;
    - `perYear = count × 12 / months`;
    - `kind` is the nearest of yearly 1, `half-yearly` 2, quarterly 4, monthly 12, when `perYear` is within 25% of it, else `'irregular'`;
    - `'too_new'` with fewer than two ordinary payments;
    - `intervalMonths = 12 / perYear`.
  - `usualGapDays(payments): number`: the median of `payDate − exDate` in days over payments that have both, else 30.
- **`dividendForecast.js`:**
  - `forecastHolding({ holding, payments, frequency, gapDays, declared, earnedUnpaid, coveredFrom, today })` returns `{ items, status, next, ordinaryPerShareNextYear }`:
    - `declared`: listed events with `ex_date > today`;
    - `earnedUnpaid`: the holding's `holding_dividends` with status `earned`;
    - `items`: ForecastItem `{ kind: 'earned' | 'declared' | 'projected' | 'irregular', day, month, gross, withheld, fees, net, currency, dividendId?, eventId? }`, in the holding's currency, whole (not scoped);
    - `status`: `'ok' | 'irregular' | 'not_enough_history' | 'may_have_stopped' | 'not_held'`;
    - `next`: `{ day }` for an earned or declared item, else `{ month }`, else null.
  - `nextYearYields(holding, ordinaryPerShareNextYear): { onValue: number | null, onCost: number | null }`: the per-share amount over `current_price` and over `avg_price`. Null when either is missing or zero.
- **Items, by spec 4.4:**
  - **Earned:** `expected_net` on its `pay_date`, or the month of `ex_date + gapDays`.
  - **Declared:**
    - `holding.quantity × amount`;
    - withheld at `holding.dividend_tax_pct`;
    - fees `quantity × dividend_fee_per_share`;
    - dated on its `pay_date`, or `ex_date + gapDays`.
  - **Projected:** for each ordinary payment with ex-date in the last twelve months:
    - amount: `quantity × ordinaryToday`, less withholding and fees;
    - month: `exDate + 1 year + gapDays`;
    - but not when a declaration replaces it. Each declaration replaces at most one projected payment: the nearest by ex-date, within half `intervalMonths`.
  - **Irregular:** one item with no month, of the average ordinary amount a year over the last 24 months.
  - **No projection:**
    - `quantity` 0: earned items only, status `'not_held'`;
    - `not_enough_history`: fewer than twelve months covered and fewer than two payments;
    - `may_have_stopped`: no ordinary payment for 1.5 × `intervalMonths` and nothing declared.

- [ ] **Step 1: Write the failing tests** with synthetic symbols (ABC, XYZ), including:
  - `"a past amount is put on today's basis by the splits after it"`: amount 10 before a 10:1 split gives `todayAmount` 1. A split on the ex-date itself does not count.
  - **`"a candidate one-off: its excess is left out until answered, and the answer then rules"`** (scenario 3):
    - quarterly 1, 1, 1, then 5: the 5 is a `'candidate'` with special 4 and ordinary 1;
    - with an answer of 0 it is `'answered'`, ordinary 5;
    - with an answer of 3, ordinary 2;
    - with only two earlier payments it is not a candidate.
  - `"frequency over 24 months, or what the source covers"`:
    - eight payments in 24 months is quarterly with interval 3;
    - one payment is `'too_new'`;
    - covered from 12 months ago with four payments is quarterly;
    - five in 24 months is `'irregular'`.
  - `"the usual gap is the median of known gaps, else 30 days"`.
  - **`"one declaration among monthly projections replaces exactly one"`** (scenario 3): twelve monthly payments and a declaration 2 days off one projected ex-date give eleven projected items and one declared.
  - `"a split after the last payment does not inflate the projection"`: quantity 100 after a 10:1 split, a past ordinary amount of 10. The projected gross is 100 × 1, not 100 × 10.
  - `"a holding sold to nothing keeps its earned dividend and is not projected"`.
  - `"stopped paying, not enough history and irregular each say so instead of a zero"`.
  - `"yields on value and on cost, and none without a price or an average"`.
- [ ] **Step 2: Run** `npx vitest run src/lib/dividendHistory.test.js src/lib/dividendForecast.test.js`. **Expected:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** **Expected:** PASS.
- [ ] **Step 5: Commit** (`Dividends: today's basis, one-offs, frequency and the next twelve months`).

### Task 4: Dirhams and the tab's summaries

**Files:**
- Create: `src/lib/dividendSummary.js`, `src/lib/dividendSummary.test.js`
- Modify: `src/lib/forecast.js` (`closedMonths` takes a scope), `src/lib/forecast.test.js`

**Interfaces:**
- **Consumes:** Task 3's exports and `estimateAed`.
- **Produces:** every summary below takes one input object, `{ holdings, dividends, trades, events, splits, payments, forecasts, feedStatus, accounts, scopeMemberId, fx, today }`, and returns dirhams, scoped.
  - `payments` maps a symbol to `sharePayments`'s result.
  - `forecasts` maps a holding id to `forecastHolding`'s result.
  - `fx` is `{ fxHistory, inrPerAed }`.
  - `buildDividendInput({ data, household, scopeMemberId, today })` builds that object from the screen's data, so the screen and the tests make it the same way.
- **`comingUp(input)`:**
  - returns `[{ kind: 'earned' | 'declared', holdingId, dividendId?, eventId?, day, month, net, currency, netAed, destinationAccountId, canRecord }]`, soonest first;
  - the earned rows come from the dividends, the declared ones from the forecasts;
  - a declared one's destination is `dividendDestination(holding, accounts)`: the fund's `dividends_into_account_id` when that account is open, else the fund (as `private.dividend_destination` does);
  - `canRecord` is true for an earned row whose destination is a `broker_funds` account.
- **`dividendHeadline(input)`:**
  - returns `{ received, expected, markets, coverageDiffers }`:
    - `received`: `{ aed, presumedAed, since, notCounted }`;
    - `expected`: `{ aed, monthlyAed, notCounted }`;
    - `markets`: one `{ market, receivedAed, expectedAed, since }` per market present.
  - **Received** is the last twelve months, by credit date, of rows with status `received` or `presumed`.
  - **`since`:** a market's coverage starts at the earlier of:
    - its holdings' earliest opening entry (the `opening` row in `trades`);
    - its earliest received credit date.

    `since` is that date when it is less than twelve months ago, else null.
  - **`coverageDiffers`** is true when the two markets' `since` differ.
- **`dividendsByMonth(input, view)`:**
  - `view` is `'received' | 'earned'`;
  - returns `{ months, years, leftOut }`:
    - `months`: `[{ month, receivedAed, presumedAed, expectedAed }]`, up to 24 months back plus the next twelve (expected only);
    - `years`: `[{ year, aed }]`.
  - `'earned'` buckets by ex-date month. `leftOut` counts the receipts with no ex-date it could not place.
- **`dividendsByHolding(input)`:**
  - returns `{ rows, none, failing, notChecked }`:
    - `rows`: `[{ holding, frequency, lastOrdinaryPerShare, receivedAed, expectedAed, yields, next, status }]`, sorted by `expectedAed` descending;
    - `none`: `{ since, holdings }`, the holdings with no dividends found, `since` being the latest `covered_from` among their symbols;
    - `failing`: holdings whose symbol's `dividends` status has `fail_count > 0`;
    - `notChecked`: followed symbols with no status row yet.
- **`dividendSources(input)`:**
  - returns `{ markets: [{ market, expectedAed, withholdingPct }], sectors: [{ sector, expectedAed }] }`;
  - on expected receipts over the next twelve months;
  - sectors use `holding.sector` and `SECTOR_LABELS`, with `'unknown'` last.
- **`spendingEquivalent({ transactions, received, expected, scopeMemberId, now })`:**
  - returns `{ pct, basis: 'received' | 'expected' } | null`, by spec 4.5;
  - spending is `closedMonths(transactions, now, scopeMemberId)`'s last twelve months;
  - null with fewer than three closed months or no spending.
- **`needsYou(input)`:**
  - returns `[{ kind, holdingId, dividendId?, eventId?, text }]`.
  - `kind` is `'flagged'` (any `review_reason`, possible duplicates included), `'one_off'` (a candidate the household holds the symbol of), `'split_not_traded'` or `'add_by_hand'`:
    - `'split_not_traded'`: a split after the holding's opening entry with no `split` trade on its date;
    - `'add_by_hand'`: a listed event after the opening entry with `pay_date < ex_date`, or a split on its ex-date, that has no dividend row.
  - `text` uses `reviewText` for flagged rows. The other kinds' text is in Step 1.
- **`feedFreshness(input)`:**
  - returns `[{ market, lastSuccessAt, coveredFrom, failing: [{ symbol, since }], neverRun }]`;
  - `since` is the symbol's `last_success_at` (null if it never succeeded);
  - `neverRun` is true when the market has no status row with a success.
- **Modifies** `closedMonths(transactions, now = new Date(), scopeMemberId = null)`: it scopes each amount with `scopedValue(t.amount, t, scopeMemberId)`. Existing callers are unchanged.

- [ ] **Step 1: Write the failing tests** (round figures, rupees at 25 a dirham in `fxHistory`), including:
  - `"received counts the last twelve months by credit date, and says the presumed part"`.
  - `"a rupee dividend with no rate is not counted, and the total says how many"` (Review Focus 1).
  - `"a shared holding counts half in one member's scope"` (Review Focus 2).
  - **`"one market's history covers less than the other's, and the headline says so"`** (scenario 3): Indian opening entry 14 months ago, US 2 months ago. `markets` shows US `since` and `coverageDiffers: true`.
  - `"by month: presumed apart, expected in the next twelve, earned view leaves out receipts with no ex-date and counts them"`.
  - `"by holding: sorted by expected; none found since the latest coverage date; failing and not-checked-yet kept apart"` (Review Focus 5).
  - `"sources by market and by sector, unknown sector last"`.
  - `"spending equivalent: received once twelve months are covered, expected before; none under three months"`.
  - `"coming up: earned and declared, soonest first; only an earned one into a broker's fund can be recorded; a declared one goes where the fund's dividends land"`.
  - Needs-you text, exactly:
    - one-off: `"ABC paid 4.00 a share on 14 Mar, more than twice its usual. Was part of it a one-off?"`;
    - split: `"ABC split 10 for 1 on 2 Jun, but its trades don't show it."`;
    - add by hand: `"ABC's dividend of 14 Mar needs adding by hand: its pay date is before its ex-date."`
  - `closedMonths` with a member: a shared expense counts half.
- [ ] **Step 2: Run** `npx vitest run src/lib/dividendSummary.test.js src/lib/forecast.test.js`. **Expected:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command, then `npx vitest run`.** **Expected:** PASS everywhere.
- [ ] **Step 5: Commit** (`Dividends: dirhams and the tab's summaries`).

### Task 5: The tab: headline, Coming up and Needs you

**Files:**
- Create: `src/screens/wealth/Dividends.jsx`, `src/screens/wealth/Dividends.css`, `src/screens/wealth/Dividends.test.jsx`
- Modify:
  - `src/screens/Wealth.jsx`: `TABS` gains `{ id: 'dividends', label: 'Dividends' }` after Investments;
  - `src/screens/useOverviewData.js` and `src/lib/loadState.js`: three sources;
  - `src/screens/Wealth.test.jsx` if it lists the tabs.

**Interfaces:**
- **Consumes:** Tasks 1, 3 and 4; part 2's `DividendForm` and `canRecord`.
- **Produces:**
  - `Dividends({ household, members, me, data, loading })`;
  - three sources:
    - `dividendEvents`: `dividend_events`, `ex_date >= today − 5 years`, ordered by symbol, ex-date and id;
    - `dividendSplits`: ordered by symbol and effective date;
    - `dividendFeedStatus`: `rpc('dividend_feed_status')`, ordered by symbol, provider and kind;
  - their labels: `'dividend dates and amounts'`, `'share splits'`, `'dividend feed status'`.

- [ ] **Step 1: Write the failing screen tests**, rendering with fixtures and mocking `supabase.rpc` as part 2's tests do:
  - **headline:**
    - `"Received in the last 12 months"` with its figure and `"of which … presumed, not checked"`;
    - `"Expected in the next 12 months"` with `"about … a month"`;
    - the spending equivalent;
    - one smaller line per market;
    - when coverage differs, `"Indian dividends are counted from <date>, US from <date>."`;
  - **Coming up:**
    - a declared dividend with its date, net and destination;
    - an earned broker-fund one with `Record`, which opens `DividendForm` and, saved, calls `data.reload`;
  - **Needs you:**
    - a flagged row with its reason;
    - a one-off with `Yes, part was a one-off` / `No, all ordinary`, which call `set_special_part` with the excess or 0;
  - **states:**
    - loading;
    - a failed source names what did not load (`couldntLoad`);
    - no paying holdings: `"No holdings that pay dividends. US-listed and Indian shares appear here once they're added under Investments."`;
    - feeds not yet run: `"The dividend feed hasn't run yet. It checks each night."`.
- [ ] **Step 2: Run** `npx vitest run src/screens/wealth/Dividends.test.jsx`. **Expected:** FAIL.
- [ ] **Step 3: Implement.** Follow the app-screen checklist for the headline (type, not tiles), rows and states.
- [ ] **Step 4: Run it, then `npx eslint src e2e` and `npx vitest run`.** **Expected:** all pass.
- [ ] **Step 5: Commit** (`Dividends: the tab, its headline, what's coming and what needs you`).

### Task 6: By month, by holding, where it comes from, and freshness

**Files:**
- Modify: `src/screens/wealth/Dividends.jsx`, `Dividends.css`, `Dividends.test.jsx`

**Interfaces:**
- **Consumes:** Task 4's `dividendsByMonth`, `dividendsByHolding`, `dividendSources` and `feedFreshness`; part 2's `HoldingDividends`.

- [ ] **Step 1: Write the failing screen tests:**
  - **By month:**
    - one bar per month, presumed shaded apart and expected lighter, with a total per year;
    - a `Received` / `Earned` switch;
    - in Earned, `"<n> receipts with no ex-date aren't shown."`;
    - an SVG drawn like `PortfolioTrendChart`, labelled for screen readers by month and figure;
  - **By holding:**
    - each row's frequency, last ordinary amount per share, received, expected, yields and next date (`14 Mar` when declared, `Mar 2027` when projected);
    - opening a row shows `HoldingDividends` for it;
    - the folds: `"No dividends found since <date>"`, `"Checks failing"` and `"Not checked yet"`;
  - **Where it comes from:**
    - India and US, each with its withholding;
    - sectors with `Unknown` last, as short bars;
    - when the markets cover different periods, the same coverage sentence as the headline's;
  - **Freshness and honesty:**
    - per market, the last successful check and any failing symbols with since when;
    - the four sentences, exactly:
      - `"Dividends from before a holding's opening entry aren't counted: the units held then are unknown."`
      - `"Expected figures are a projection at today's units and exchange rates."`
      - `"Dividends earned but not yet received aren't in net worth."`
      - `"The Life plan already counts dividends in its return, so this tab is cash flow, not a second return."`
- [ ] **Step 2: Run** the screen tests. **Expected:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, lint, and `npx vitest run`.** **Expected:** all pass.
- [ ] **Step 5: Commit** (`Dividends: by month, by holding, where it comes from, and how fresh`).

### Task 7: The tab in a browser, on a phone

**Files:**
- Create: `e2e/dividends-tab.spec.js`

- [ ] **Step 1: Write the test.** On desktop and phone, with the stub's tables and RPCs:
  - **fixtures:**
    - a holding with a 60-character name;
    - a received dividend with no ex-date;
    - US feed status failing since a day, Indian checks fine;
    - an earned dividend into the dollar broker's fund;
  - **assertions:**
    - the page does not scroll sideways;
    - every button is 44px or taller on the phone;
    - the long name wraps or truncates, and never pushes figures off;
    - the Earned view counts the dateless receipt as not shown;
    - the freshness section names the failing US symbol;
    - `Record` checks and saves through the stub;
    - `Fix` from a holding's dividends opens the form;
    - screenshots of each section are kept.
- [ ] **Step 2: Build and run** `CHROMIUM_PATH=… npx playwright test e2e/dividends-tab.spec.js`. **Expected:** PASS on both projects. Look at the phone screenshots against the checklist and fix what reads wrong.
- [ ] **Step 3: Commit** (`Dividends: the tab in a browser, on a phone`).

### Task 8: Docs, checks and the pull request

**Files:**
- Modify:
  - `docs/decisions.md`: the "Dividends are their own records" section, on what the tab counts and why. It covers today's basis, one-offs, projections, dirhams and coverage, plus the split of the sums into three files.
  - `docs/features.md`: the Dividends tab.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run every check in `CLAUDE.md`**, migrations and SQL tests included, and `npm run compare:migrations`. **Expected:** all pass, with one migration awaiting deployment.
- [ ] **Step 3: Final whole-branch review** by a fresh reviewer. Fix what it finds, each with a failing test first.
- [ ] **Step 4: Commit, push and open the pull request.** The description says the migration is not applied yet.
