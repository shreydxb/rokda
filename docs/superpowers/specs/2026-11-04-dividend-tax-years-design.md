# Dividend tax years: what was withheld, what the statements say, what came back

Design for the tax-year panel that SHR-366's dividends design left for later. Status: approved in conversation by the household on 4 November 2026; revised on 6 November 2026 after an outside review (section 10 lists what changed). This repository is public: every figure, company and account below is a round example ("ABC", "the Indian bank account", "₹1,000"), never the household's.

## 1. What this is

A member who lives outside India and holds Indian shares has tax withheld from every dividend (20.8% at present at the household's companies: 20% plus 4% cess, with no surcharge at their income; a presumption, not a universal rate). Each year they file an Indian return, and a refund arrives in the Indian bank account months later. It covers the whole return: tax withheld on capital gains as well as on dividends, with interest, sometimes offset against an earlier demand.

Rokda already records each Indian dividend with its gross and its tax: exact from a company's credit intimation, presumed at the holding's rate from the broker's dividend report or the nightly feed. This design adds, per tax year and member:

- **before filing:** the year's dividends and tax by share, checked against the department's statements: the AIS (Annual Information Statement) for dividend income, Form 26AS for tax credit;
- **after filing:** the return's dividend figures, the dividend tax surplus or shortfall, and what happened to the return's refund (processed, credited, offset), as dated events.

**Done when:**

- each member's Indian dividends are grouped by tax year (section 4.1), with confirmed and presumed figures apart;
- imported AIS income and 26AS tax are compared share by share with Rokda's, every difference shown exactly, with possible explanations offered as possibilities and "unexplained" otherwise;
- a filed year shows the return's dividend tax and the dividend tax surplus or shortfall (signed), apart from the whole return's refund, its interest, offsets and credits;
- an estimate of what could come back is shown only for a year whose claim basis was set for that year;
- no PAN, acknowledgement number, bank account number or document is stored anywhere.

## 2. What the household decided

1. **Both jobs.** The panel prepares the year's figures before filing and follows the refund after it.
2. **AIS for income, Form 26AS for tax credit.** The department's guidance is to rely on 26AS for tax credit when the AIS and 26AS differ. Income is reported from the household's own records whatever the statements show; a dividend or tax missing from them reads "not reflected: needs reconciliation", never "cannot be claimed".
3. **The claim basis is set per year, never inherited.** Domestic rate, treaty rate (with the residence and documents the treaty requires) or manual, with the effective rate on gross dividends: for a treaty rate, the rate the treaty states, no cess added. A year without its own basis shows facts only; the previous year's basis is shown beside it as reference, not used.
4. **"Dividend tax surplus or shortfall", not "the dividend part of the refund".** The surplus is the tax credit on the year's dividends (26AS) minus the tax the return computes on them. It can be negative. It is not an allocation of the refund's rupees: the whole return's refund is shown separately, because other income can absorb or add to it.
5. **The refund stays in this panel.** The refund's principal is tax coming back, not income; its interest is income of the year it is received, labelled so for that year's return. Neither becomes a transaction or changes dividend income; the bank balance takes the credit at its next check-in.
6. **Indian dividends only**, by scope.
7. **Documents are read, not kept.** The household shares the AIS, 26AS, the return and its processing intimation. They are read only in the working session's scratch space, shown as a worksheet, saved through the functions in section 5 on the household's go, and then deleted. Nothing from them reaches the repository, a log, a fixture or a note beyond the figures in section 3.

## 3. What is stored

Amounts are rupees to the paisa, as the source gives them. Null means unknown; zero means known to be zero.

### 3.1 `tax_returns`: a member's return for a tax year

One row per member and tax year, created on its first save.

| Column | Meaning |
|---|---|
| `household_id`, `member_id`, `financial_year` | whose and which year; `2025` is FY 2025-26 (assessment year 2026-27) |
| `claim_basis`, `claim_rate_pct` | `domestic`, `treaty` or `manual`, and the effective rate on gross dividends; both null until set for this year |
| `revision` | `0` not filed, `1` the original return, `2` and up for each revised return |
| `filed_on` | the latest revision's filing date |
| `dividend_income`, `dividend_tax` | from the latest revision: dividends declared, and the tax computed on them with the surcharge and cess that fall on them; the worksheet names the schedules they came from and how any aggregate was split |
| `dividend_tds_claimed`, `tds_claimed_total` | tax credit claimed in that revision: on dividends, and in the whole return |
| `note` | free text; refused if it contains anything shaped like a PAN |
| `version`, `updated_at`, `updated_by` | written by the server |

Unique on `(member_id, financial_year)`.

### 3.2 `tax_return_events`: what happened to a return

Any number per return, each tied to the revision it concerns.

| `kind` | Figures |
|---|---|
| `processed` | the intimation's date; refund principal determined (or demand raised, as a negative), refund interest, tax credit allowed in total |
| `refund_credited` | the date and amount credited to the bank |
| `offset_against_demand` | the date and amount set against an earlier demand |
| `refund_failed` | the date a refund issue failed; counts as nothing received |

The return's state is derived from its events: not filed, filed, processed, refund due, partly settled, settled. "Unexplained" is the determined principal plus interest, less what was credited and offset, when not zero.

### 3.3 `tax_statements` and `tax_statement_lines`: the department's statements

A statement is one imported AIS or 26AS for a member and tax year: `source` (`ais` or `26as`), the statement's own `as_of` date, `imported_at`, and a `revision` that grows only when its content changes. It exists even when it has no lines, so "imported, nothing reported" differs from "not imported".

Each line: the share (`symbol`, the issuer key; null when the payer is not a share Rokda knows), the payer as the statement names it, and the year's figures from that payer: for the AIS, dividend income from its annual dividend reporting stream only (never added to the gross amounts in its tax entries, which would count the same dividend twice); for 26AS, the gross paid and tax deducted, summed over the year's entries. Unique on statement and payer.

### 3.4 `holding_dividends.tax_financial_year`

Nullable, with `tax_year_basis` (`declared`, `paid`, `statement` or `household`): set only when a dividend's tax year differs from its credit date's (section 4.1), through a function, at the dividend's version.

### 3.5 Access

Members of the household read all of it. Nobody writes directly: functions in section 5 write it, `security definer` with an empty `search_path`, checking the caller as the dividend functions do, checking that every referenced member, share and dividend is the household's, accepting only listed fields and setting audit fields themselves. Each table gets row-level security policies and cases in `rls-policies.test.sql`.

## 4. The sums

Pure, in `src/lib/dividendTax.js`, tested beside it; the screen only lays them out.

### 4.1 The tax year of a dividend

- **The rule:** a final dividend is income of the year it is declared; an interim dividend of the year it is paid. Payment follows declaration within 30 days, so the credit date's financial year (1 April to 31 March) gives the right year except for a final dividend declared in March and paid in April.
- **So:** a dividend's tax year is `tax_financial_year` when set, else its credit date's year. When the credit date is estimated (a presumed dividend), the year is **provisional** and says so.
- **Member:** the holding's owner. A shared Indian holding is listed apart, asking whose dividends they are, since a return is one person's. Ownership history is not kept: a holding whose owner changes moves its past dividends with it, which the panel states.

### 4.2 Rokda's side of a year

Per member, tax year and share (adding up holdings of the same share): the number of dividends, gross and tax, **confirmed** (a credit intimation, or a member's record with the broker's figures) and **presumed** (expected figures) kept apart. Only dividends counted as received are included.

### 4.3 The statement check

Per member, tax year and share, Rokda's gross against the AIS and Rokda's tax against 26AS, each difference shown exactly. A difference is labelled:

- **agrees:** zero difference;
- **within rounding:** not more than ₹1 for each of Rokda's dividends from that share that year (companies round tax differently); the exact amount still shows;
- **differs**, with possible explanations, each worded as a possibility: the same share shows an offsetting difference in the neighbouring year ("possibly counted in FY …"); tax higher with gross equal ("possibly an additional deduction or a correction: check the company's intimation or Form 16A"); presumed figures in Rokda ("presumed, not confirmed"). Otherwise **unexplained**;
- **only in the statement** (a share sold before Rokda's records, or one Rokda does not know) or **only in Rokda** (not reported yet, or never paid).

A statement may itself be incomplete (the department says so of the AIS); the check reports differences, it does not decide which side is right.

### 4.4 Surplus, refund and estimate

- **Dividend tax surplus or shortfall** (filed years, with 26AS imported): 26AS dividend tax minus the return's `dividend_tax`. Signed. Missing either input: says which.
- **The return's refund:** from the events: determined, interest, credited, offset, unexplained. Never split into a dividend part.
- **Estimate before filing** (only with this year's own basis): tax withheld minus gross × `claim_rate_pct`, from 26AS when imported, else from Rokda, with Rokda's presumed part shown apart. Labelled an estimate.

### 4.5 Labels

Years under the Income-tax Act 1961 read "FY 2025-26 (AY 2026-27)"; from the tax year 2026-27, under the 2025 Act, "tax year 2026-27". Import mappings follow the year: a statement or return for an older year keeps that year's forms and schedules.

## 5. Recording

- **`import_tax_statement(member, financial_year, source, as_of, lines, expected_revision)`**: service role only. Validates every line before touching anything (known member and shares, non-negative amounts, no duplicate payers); locks the member, year and source; refuses a statement older than the one held unless told to replace it; replaces the lines and raises the revision when the content differs, and reports a no-op when it does not.
- **`save_tax_return(member, financial_year, change, expected_version)`**: a member of the household, or the service role naming one. Listed fields only; saves at the version it was changed against; refuses figures outside section 3 with one sentence each.
- **`save_tax_return_event(...)`, `remove_tax_return_event(...)`**: the same callers and checks.
- **`set_dividend_tax_year(dividend, financial_year, basis, expected_version)`**: the same callers; clears with a null year.
- **The data task:** the documents are read in the scratch space; each figure on the worksheet names its source (statement and stream, or the return's schedule) and any split made; saved on the household's go; the copies deleted.

## 6. The screen

A "Tax years" section at the end of Wealth → Dividends, in rupees, shown whenever a member has Indian dividends, statements or returns, held or not.

- One row per member and tax year, newest first. In one member's scope only theirs; in "All", each row names its member.
- **The row:** the year label; dividends and tax withheld (presumed part beside, if any; "provisional" where a year is); the statement check in words ("agrees with AIS and 26AS", "3 differences", "26AS not added"); and, by stage, the estimate (with its basis), or the surplus or shortfall and the refund's state ("refund ₹… credited 5 Oct", "₹… unexplained").
- **Opened:** the share list with Rokda's, the AIS's and 26AS's figures, each difference exact with its label; the return (basis, revision, filed, dividend figures, tax claimed) with **Edit**; the events, in date order, with **Add**; and **Set tax year** on a dividend from the share list.
- **States:** each missing piece says what is missing (no statement, no basis, not filed, not processed); loading and load failures as elsewhere in the tab.
- Phone first: rows wrap, figures stay legible at 390px, controls 44px.

## 7. Build order

| Step | What | Done when |
|---|---|---|
| **PR 1** | the tables, column and functions, with RLS and SQL tests; `dividendTax.js` with its tests; the decisions in `docs/decisions.md` | the database and sum cases in section 8 pass |
| **PR 2** | the section and its forms; `docs/features.md`, and the screen's lines in `docs/decisions.md` | the screen and browser cases in section 8 pass |
| **Data task** | the household's AIS and 26AS for FY 2024-25 and 2025-26, and the FY 2025-26 return with its intimation | the worksheet is approved, the saved figures reconcile with it, the copies are deleted, and importing again reports a no-op |
| **Later** | a yearly nudge when the statements are out; capital-gains tax; ownership history | each its own issue |

## 8. What could go wrong, and what stops it

| Case | What happens | Tested in |
|---|---|---|
| A final declared on 30 March and paid on 10 April | credit date gives the April year; with `tax_financial_year` set (`declared`), the March year | unit |
| An interim declared in March and paid in April | the April year | unit |
| A presumed dividend near 31 March | its year is shown provisional | unit |
| AIS dividend income and 26AS gross for the same dividend | compared separately, never added | unit |
| AIS and 26AS disagree on tax | tax is checked against 26AS; the AIS figure is shown beside it | unit |
| A statement imported with no lines | "imported, nothing reported", not "not imported" | SQL, unit |
| The same statement imported twice | a no-op, reported | SQL |
| An older statement over a newer one | refused unless told to replace | SQL |
| Two imports of one year at once | the second waits for the lock and then checks its expected revision | SQL |
| Two holdings of the same share | compared as one share | unit |
| A share sold before Rokda's records | "only in the statement", counted in its totals | unit |
| A difference of ₹0.40 over three dividends | "within rounding", ₹0.40 shown | unit |
| Tax higher, gross equal | "possibly an additional deduction or a correction" | unit |
| Presumed tax in Rokda | shown apart, never as confirmed credit | unit, screen |
| A dividend surplus larger than the whole refund | both shown, signed; no negative "other" | unit |
| A zero refund determined | "no refund", not "not processed" | unit |
| Interest and an offset against a demand | both shown; unexplained only for what remains | unit |
| A revised return after a refund was credited | the credit stays, tied to the original revision | SQL, unit |
| A failed refund issue, then a credit | only the credit counts | unit |
| No basis set for the year | no estimate; the previous year's basis shown as reference | unit, screen |
| A note containing a PAN-shaped text | refused | SQL |
| A member or share of another household | refused | SQL (RLS) |
| A signed-in member calls the import | refused | SQL |
| All Indian holdings sold | the section stays while history exists | screen |
| A long company name on a phone | wraps; no sideways scroll | browser |

## 9. Out of scope

- Tax on capital gains, interest or anything other than dividends, except as part of the whole return's refund.
- Foreign dividends and their withholding (shown elsewhere in the Dividends tab).
- Deciding the claim basis, computing the return, refund interest or its tax: the panel records what the household and the department state.
- Storing documents or any identifier from them.

## 10. Changes after the outside review (6 November 2026)

- Tax credit is checked against Form 26AS, income against the AIS; missing items are "not reflected", never "cannot be claimed".
- The tax year follows the dividend rules (final: declared; interim: paid), with the credit date as the default, an explicit per-dividend year, and provisional years for estimated dates.
- The AIS's dividend income is taken from one stream only, never added to the gross in its tax entries.
- "The dividend part of the refund" became the signed dividend tax surplus or shortfall, apart from the whole return's refund.
- The claim basis is per year and never inherited; the estimate needs it.
- Refund interest, offsets against demands, several credits and failed issues are dated events; revisions are numbered and keep their events.
- Statements carry their source, date and revision, including empty ones; imports validate first, lock, refuse older content and report no-ops.
- Shares, not holdings, are compared; sold shares stay; ownership history is out of scope for now and stated on screen.
- Every difference is shown exactly; "within rounding" replaces "matches"; explanations are possibilities, else "unexplained"; presumed figures are always apart.
- Year labels follow the Act that governs the year.
