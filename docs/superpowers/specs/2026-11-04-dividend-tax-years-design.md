# Dividend tax years: what was withheld, what the AIS says, what came back

Design for the tax-year panel that SHR-366's dividends design left for later. Status: approved in conversation by the household on 4 November 2026; written for review. This repository is public: every figure, company and account below is a round example ("ABC", "the Indian bank account", "₹1,000"), never the household's.

## 1. What this is

A member who lives outside India and holds Indian shares has tax withheld from every dividend (20.8% at present: 20% plus 4% cess, for a non-resident without a Tax Residency Certificate). Each year they file an Indian return and claim back what was withheld beyond the tax they owe. The refund lands in the Indian bank account months later, mixed with the refund of other tax (a broker withholds tax on a non-resident's capital gains too).

Rokda already records each Indian dividend with its gross and its tax (from the companies' credit intimations, the broker's dividend report, or the nightly feed). This design adds, per Indian financial year (1 April to 31 March) and per member:

- **before filing:** the year's dividends and tax by company, checked against the tax department's own statement (the AIS, Annual Information Statement), so that what the return claims is what the department will credit;
- **after filing:** what the return computed and refunded, when the refund arrived, and how much of it was dividend tax.

**Done when:**

- each member's Indian dividends are grouped by financial year of their credit date, with gross and tax per company, in rupees;
- an imported AIS year is compared company by company with Rokda's figures, and every difference is shown with its likely reason; rounding is not a difference;
- a filed year shows the return's dividend tax, the refund determined and credited, and the dividend part of that refund apart from the rest;
- a year not filed yet shows what could be claimed at the member's claimed rate, or says the rate is not known yet, never a zero;
- no PAN, acknowledgement number, bank account number or document is stored.

## 2. What the household decided

1. **Both jobs.** The panel prepares the year's figures before filing and follows the refund after it.
2. **The AIS is the reference.** Only tax the AIS shows can be claimed; a company that reports late or wrongly is the usual reason a refund comes short. Each year's AIS is imported and compared with Rokda before filing.
3. **The claim rule is read from the return, not assumed.** How the household claims (the treaty rate with a Tax Residency Certificate, or the return's own computation) is not known until the first return is read. Until then the panel shows facts (dividends, tax withheld, the AIS check) and no estimate of what comes back.
4. **The refund stays in the tax-year view.** A refund covers the whole return, not only dividends, so it is not added to dividend income, not counted as income, and not a transaction. The bank balance takes it in at the next check-in, as with any credit.
5. **Indian dividends only.** US withholding at the dollar broker is final and is not part of the Indian return; it stays visible in the Dividends tab's "Where it comes from".
6. **Imports are data tasks.** The household shares the AIS and the return; they are read outside the repository, shown as a worksheet, and saved only on the household's go, as with past dividends (dividends design, section 7). The app has a small form to correct a return's figures.

## 3. What is stored

### 3.1 `tax_returns`: one member's return for one year

One row per member and financial year, created when the first figure for that year is saved.

| Column | Meaning |
|---|---|
| `household_id`, `member_id` | whose return; the member belongs to the household |
| `financial_year` | the year's first calendar year: `2025` is FY 2025-26 (assessment year 2026-27) |
| `dividend_rate_pct` | the rate the member claims on dividends in the return (`10` for a treaty rate, say); null until known |
| `filed_on`, `processed_on` | when the return was filed, and when the department processed it (the intimation's date) |
| `dividend_income`, `dividend_tax` | dividends declared in the return, and the tax the return computes on them |
| `refund_determined` | the refund in the processing intimation; null if none |
| `refund_credited`, `credited_on` | what reached the bank (interest included) and when |
| `note` | free text, for a revised return or a refund set against an old demand |
| `version`, `updated_at`, `updated_by` | as on other edited rows |

Unique on `(member_id, financial_year)`. Amounts are rupees, not negative. Dates are not after the household's today. A revised return replaces the figures; the note says so.

### 3.2 `tax_statement_lines`: what the AIS says, per company

One row per member, financial year and payer, the year's dividends from that payer added up.

| Column | Meaning |
|---|---|
| `household_id`, `member_id`, `financial_year` | as above |
| `payer` | the company as the AIS names it |
| `holding_id` | the holding it was matched to at import; null for a share no longer held |
| `gross`, `tds` | the year's dividend and tax from that payer, in rupees; `tds` is not more than `gross` |
| `imported_at` | when this year's AIS was imported |

Unique on `(member_id, financial_year, payer)`. A year is imported whole: importing it again replaces that member's lines for that year.

### 3.3 Access

Members of the household read both tables. Nobody writes them directly: writes go through the functions in section 5, which check the caller as the dividend functions do (`private.trade_caller`). Both tables get row-level security policies and cases in `rls-policies.test.sql`.

## 4. The sums

Pure, in `src/lib/dividendTax.js`, tested beside it; the screen only lays them out.

### 4.1 Rokda's side of a year

- Indian holdings only (`india_equity`), and only dividends counted as received (received or presumed; not earned, not skipped).
- **Year:** the financial year of the credit date (1 April to 31 March). A presumed dividend's credit date is estimated (ex-date plus 30 days), so one near 31 March can land in the next year; the AIS check (4.2) points at it.
- **Member:** the holding's owner. A shared Indian holding is listed apart, "shared: give it an owner to count it in a return", since a return is one person's.
- **Per company:** the count of dividends, gross, and tax: received figures where the dividend was received, expected figures where presumed.

### 4.2 The AIS check

For a year with AIS lines, each company is one of the following. A line and Rokda's figures are the same company when the line's `holding_id` (set at import) is the holding; a line without one is only in the AIS.

- **matches:** gross and tax each within ₹1 for each of Rokda's dividends from that company in the year (registrars round tax up to the rupee, so three dividends may differ by up to ₹3);
- **differs:** both sides have the company and the figures disagree beyond that. If the same company's difference is offset by its figures in the neighbouring year, it says "probably counted in FY …". If AIS tax is higher with gross equal, it says a company may withhold extra to catch up on its earlier dividends that year;
- **only in the AIS:** typically a share sold before Rokda's records; it still counts in the year's AIS totals;
- **only in Rokda:** a dividend the AIS does not show yet, or a presumed dividend that was never paid.

The year's line reads "matches the AIS", "N differences", or "AIS not added yet".

### 4.3 What could be claimed, and what came back

- **The rate:** the year's `dividend_rate_pct`, else that of the member's latest return that has one, else none.
- **Before the return is read:** claimable is tax withheld minus gross × rate, from the AIS totals when the year has them (they are complete), else from Rokda's. With no rate: "set when your return is read".
- **After the return is read:** the dividend part of the refund is the AIS tax (Rokda's if no AIS) minus the return's `dividend_tax`; the rest of `refund_determined` is shown as "other tax (capital gains and the rest)". A refund credited that differs from the one determined shows both, and the gap.
- Nothing is shown as zero for want of a figure: each missing piece says what is missing.

## 5. Recording

- **`import_tax_statement(member, financial_year, lines)`**: service role only (the import is a data task). Checks the member is in the household and every line's figures; replaces the member's lines for that year in one transaction; returns what it replaced and saved. Run twice with the same lines, the second run changes nothing but `imported_at`.
- **`save_tax_return(member, financial_year, change, expected_version)`**: the app (any member of the household) or the service role naming a member. Creates the row on first save; afterwards saves only at the version the change was made against, as dividends do; refuses figures outside section 3.1's rules with one sentence each.
- **The data task**, after the household shares the documents: the AIS for a year (the portal's download) and the filed return with its processing intimation are read outside the repository, matched to holdings, shown as a worksheet, and saved through these functions on the household's go. Nothing about the documents enters the repository.

## 6. The screen

A "Tax years" section at the end of Wealth → Dividends, in rupees.

- One row per member with Indian holdings and per financial year, newest first, back to the earliest year with a dividend, an AIS line or a return. In one member's scope only that member's rows; in "All", each row names its member.
- **The row:** FY, dividends (gross), tax withheld, the AIS check in words, and either "could be claimed: ₹…" (with the rate) or the refund ("refunded ₹… on …, ₹… of it dividend tax").
- **Opened:** the company list (Rokda's gross and tax beside the AIS's, each difference with its reason), then the return (rate, filed, processed, dividend tax, refund determined and credited, note) with **Edit** opening the return form.
- **States:** no Indian holdings, no section; a year with nothing but Rokda's figures says "AIS not added yet" and "no return yet"; loading and load failures as elsewhere in the tab.
- Phone first: rows wrap, figures stay legible at 390px, controls 44px, as the browser test on the tab already checks.

## 7. Build order

| Step | What | Done when |
|---|---|---|
| **PR** | the two tables with RLS, the two functions, `dividendTax.js`, the section and its form, `docs/decisions.md` and `docs/features.md` | the cases in section 8 pass in SQL, unit, screen and browser tests |
| **Data task** | the household's AIS for FY 2024-25 and 2025-26 and the FY 2025-26 return | the worksheet is approved, the saved figures reconcile with it, and running the import again changes nothing |
| **Later** | a yearly nudge when the AIS is out (June/July) to share it; claims for capital-gains tax | each its own issue |

## 8. What could go wrong, and what stops it

| Case | What happens | Tested in |
|---|---|---|
| A dividend paid on 31 March and one on 1 April | they fall in different years | unit |
| A presumed March dividend estimated into April | the AIS shows it in March; the difference says "probably counted in FY …" | unit |
| Tax rounded up to the rupee by the registrar | counted as matching | unit |
| A company withholds extra to catch up on earlier dividends | shown as a difference with that reason | unit |
| A share sold before Rokda's records, in the AIS | "only in the AIS", counted in the AIS totals | unit |
| A shared Indian holding | listed apart, asking for an owner | unit |
| No rate yet | no claimable figure; says the rate comes from the return | unit, screen |
| The AIS imported twice | the second run changes nothing but its time | SQL |
| A member of another household writes or reads | refused / not visible | SQL (RLS) |
| A signed-in member calls the import | refused | SQL |
| Tax more than gross, a negative amount, a future date, a rate over 100 | refused with one sentence | SQL, unit |
| Two members edit the same return | the second is refused as changed, and checks again | SQL |
| A long company name on a phone | wraps; no sideways scroll | browser |

## 9. Out of scope

- Tax on capital gains, interest or anything other than dividends, except as the "other" part of a refund.
- US withholding, foreign tax credits, and anything about filing the return itself.
- Storing the AIS or the return, or any identifier from them.
- Telling the household what rate to claim: the panel records what the return claimed.
