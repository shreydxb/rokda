# Dividend tax years, part 2: the Tax years section, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Tax years" section at the end of Wealth → Dividends that shows each member's Indian dividends per tax year, the AIS and 26AS check, the return, the surplus or shortfall and what became of the refund, with forms to keep the return, its refund events and a dividend's own tax year.

**Architecture:**
- **Data:** the app reads part 1's four tables with the rest of the household's data (`useOverviewData`).
- **Sums and words:** `src/lib/dividendTax.js` (part 1) works out the years. A new pure file, `src/lib/dividendTaxText.js`, turns them into the screen's sentences.
- **Screen:** `src/screens/wealth/TaxYears.jsx` lays them out. Two forms write through part 1's functions: `TaxReturnForm.jsx` and `TaxEventForm.jsx`. `Dividends.jsx` mounts the section last.

**Tech Stack:** React 19 and Vite, Vitest with Testing Library, Playwright (desktop and phone).

**Spec:** `docs/superpowers/specs/2026-11-04-dividend-tax-years-design.md`:
- section 6, the screen;
- section 4, the sums, as words;
- section 8's cases marked screen and browser.

Part 1 is merged and applied: shreydxb/rokda#155.

## Global Constraints

- **Public repository:** generic names and round figures in tests, fixtures, docs, commits and PR text ("ABC", "Old Co Limited", 1,000, 208, members "One" and "Two"). No PAN, account number or real figure anywhere.
- **No migration.** The functions and tables are part 1's. They are called as:
  - `save_tax_return(p_member_id, p_financial_year, p_change, p_expected_version)`;
  - `save_tax_return_event(p_member_id, p_financial_year, p_event, p_event_id)`;
  - `remove_tax_return_event(p_member_id, p_event_id)`;
  - `set_dividend_tax_year(p_dividend_id, p_financial_year, p_basis, p_expected_version)`.

  Each returns `{ ok, error }`.
- **Rupees, not dirhams:** every figure in the section is shown as `INR 1,000.00` (`formatMoney(n, { decimals: 2 })` after `INR `), never converted. A figure the return has not given reads "not given".
- **Words:**
  - "dividend tax surplus" or "dividend tax shortfall", never "the dividend part of the refund";
  - "within rounding", never "matches";
  - explanations begin "possibly";
  - a missing statement reads "not added", never "cannot be claimed".
- **Refusals:** a database refusal shows `taxRefusalMessage(code)` (part 1). A request error shows `Couldn't save that: <message>. Nothing was changed.` Both keep what was typed.
- **Scope:**
  - In "All", every member's years show, each row naming its member.
  - In one member's scope, only that member's years show.
  - Shared holdings' dividends are listed apart in both.
- **Layout:**
  - The `design-taste-frontend` skill's `references/app-screens.md` is the checklist: sections 7 (lists), 8 (forms), 11 (states) and 12 (the phone).
  - `design/` and Rokda's palette are the look.
  - Rows are the tab's two-line rows (`ht-list`, `ht-row`, `dv-rowbutton`, `dv-name`, `dv-detail`); forms are the dividend form's (`ht-form`, `te-fieldgrid`, `te-fieldcell`, `te-fieldlabel`, `te-fieldvalue`, `ht-form-actions`, `om-btn`).
  - On a phone, nothing scrolls sideways and every `button` and `summary` is at least 44px tall.
- **Checks:** every check in `CLAUDE.md` passes before the PR. Playwright runs with `CHROMIUM_PATH=/opt/pw-browsers/chromium` in this container.

## Review Focus

1. **The tax tables fail to load while the rest loads:** the Dividends tab still shows everything else, and the section says which records couldn't load. *Task 5.*
2. **One member's scope:** another member's years are hidden, and the shared-holding note still shows. *Task 5.*
3. **A form refused by the database:** the sentence shows and every typed value stays. *Task 3.*
4. **Amounts typed the Indian way** (`1,20,000.50`): read as 120000.5. Text that isn't a number (`12a`) is caught before sending, with "Enter an amount, like 1000.50". *Task 3.*
5. **A revised return's events:** each event shows which return it belongs to once the return is revised, and a new event defaults to the latest revision. *Task 4.*

---

### Task 1: Load the tax records; a year's dividends of a share; the last credit date

**Files:**
- Modify: `src/screens/useOverviewData.js`, `src/lib/loadState.js`, `src/lib/dividendTax.js`
- Test: `src/lib/dividendTax.test.js`, `src/lib/loadState.test.js` (or the existing test that covers `SOURCE_LABELS`)

**Interfaces:**
- **Produces, in `useOverviewData`:**
  - the four keys `taxReturns`, `taxReturnEvents`, `taxStatements` and `taxStatementLines`;
  - each query is `.eq('household_id', id)`, ordered stably: returns by `financial_year` then `id`; events by `happened_on`, `created_at`, `id`; statements by `financial_year`, `source`, `id`; lines by `statement_id`, `payer`;
  - a comment in the file's voice says members read them and only part 1's functions write them.
- **Produces `SOURCE_LABELS`:** `taxReturns: 'tax returns'`, `taxReturnEvents: 'refund records'`, `taxStatements: 'tax statements'`, `taxStatementLines: 'tax statement lines'`.
- **Produces `dividendsInYear({ holdings, dividends, memberId, year, key }): row[]`** in `dividendTax.js`: the received and presumed dividends of Indian holdings owned (not shared) by `memberId` whose `shareKey` is `key` and whose `dividendTaxYear(d).year` is `year`, oldest `credited_on` first. These are the same dividends `rokdaShareYears` counts.
- **Extends `refundState`:** it also returns `lastCreditedOn`, the latest `happened_on` of a `refund_credited` event, or null.

- [ ] **Step 1: Write the failing tests:**
  - `'a year's dividends of a share are the ones its sums count'`: with `IN_A`, `IN_A2` and `IN_S`, received dividends credited `'2025-05-01'` and `'2025-08-01'` on `IN_A`, one credited `'2025-06-01'` on `IN_A2`, one on `IN_S`, an earned one on `IN_A`, and a received one credited `'2026-05-01'` on `IN_A`. `dividendsInYear({ …, memberId: 'm1', year: 2025, key: 'ABC.NS' })` gives the three 2025 ids in credit order. The shared, earned and 2026 dividends are not included.
  - `'the last credit date'`: two credits on `'2026-09-20'` and `'2026-10-05'` give `lastCreditedOn: '2026-10-05'`; none gives `null`.
  - `SOURCE_LABELS` has a label for each of the four new keys. Extend the existing every-source-has-a-label test, if one exists, rather than adding a second.
- [ ] **Step 2: Run** `npx vitest run src/lib/dividendTax.test.js src/lib/loadState.test.js`. **Expected:** FAIL on the new cases.
- [ ] **Step 3: Implement** the keys, the labels, `dividendsInYear` and `lastCreditedOn`.
- [ ] **Step 4: Run the same command, then `npx vitest run`.** **Expected:** PASS everywhere. `useOverviewData`'s own tests still pass with four more sources.
- [ ] **Step 5: Commit** (`Dividend tax years: load the tax records`).

### Task 2: The section's words

**Files:**
- Create: `src/lib/dividendTaxText.js`, `src/lib/dividendTaxText.test.js`

**Interfaces** (`fmt` is `(n) => string`, the screen's rupee formatter; the tests pass ``(n) => `INR ${n}` ``):
- **`basisWords(claimBasis, ratePct): string`:**
  - `'treaty', 10` gives `'the treaty rate of 10%'`;
  - `'domestic', 20.8` gives `'the domestic rate of 20.8%'`;
  - `'manual', 15` gives `'a rate of 15%'`.
- **`revisionLabel(n): string`:** 0 is `'Not filed'`, 1 `'Original return'`, 2 `'Revised return'`, and n ≥ 3 `` `Revised return ${n - 1}` ``.
- **`checkWords(year): string`**, from `year.statements` and `year.shares`:
  - A difference is a share's `income` (when the AIS is imported) or `tax` (when 26AS is) labelled `differs`, `unexplained`, `only_in_statement` or `only_in_rokda`. `within_rounding` is not a difference.
  - Neither statement imported: `'AIS and 26AS not added'`.
  - No differences: `'agrees with AIS and 26AS'`, `'agrees with 26AS; AIS not added'` or `'agrees with AIS; 26AS not added'`.
  - Otherwise `'1 difference'` or `` `${n} differences` ``, followed by `'; AIS not added'` or `'; 26AS not added'` when one is missing.
- **`stageWords(year, fmt): string`:**
  - **Not filed** (`refund.stage === 'not_filed'`):
    - with an estimate: `` `could come back: about ${fmt(amount)} at ${basisWords(…)}` ``, followed by `` `, ${fmt(presumedPart)} of it on presumed dividends` `` when `presumedPart` is nonzero;
    - otherwise, with a basis reference: `` `no claim basis set (last year: ${basisWords(…)})` ``;
    - otherwise: `'no claim basis set'`.
  - **Filed:** the surplus words, then `'; '`, then the refund words.
  - **Surplus words:**
    - `` `dividend tax surplus ${fmt(a)}` `` when positive;
    - `` `dividend tax shortfall ${fmt(-a)}` `` when negative;
    - `'no dividend tax surplus'` when 0;
    - `'surplus needs 26AS'` when 26AS is missing;
    - otherwise `"surplus needs the return's dividend tax"`.
  - **Refund words:**
    - `filed`: `'not processed yet'`;
    - `demand`: `` `demand ${fmt(-determined)}` ``;
    - `no_refund`: `'no refund'`;
    - `refund_due`: `` `refund ${fmt(determined + interest)} due` ``;
    - `partly_settled`: `` `refund ${fmt(due)}, ${fmt(unexplained)} unexplained` ``;
    - `settled` with a credit: `` `refund ${fmt(credited)} credited ${shortDate(lastCreditedOn)}` ``, then `` `, ${fmt(offset)} set against a demand` `` when there is an offset, then `` `, ${fmt(-unexplained)} more than determined` `` when unexplained is below 0;
    - `settled` with no credit: `` `refund ${fmt(offset)} set against a demand` ``.
- **`comparisonWords(cmp, source, fmt): string`**, where `source` is `'AIS'` or `'26AS'`:
  - `not_imported`: `` `${source} not added` ``;
  - `neither`: `` `not in Rokda or ${source}` ``;
  - `agrees`: `` `agrees with ${source}` ``;
  - `within_rounding`: `` `within rounding of ${source} (${fmt(|d|)})` ``;
  - `only_in_statement`: `` `only in ${source} (${fmt(d)})` ``;
  - `only_in_rokda`: `` `not in ${source}` ``;
  - `differs` and `unexplained`: `` `${source} ${fmt(|d|)} more` `` (or `less` when d < 0); then `', unexplained'` for unexplained;
  - **reasons:** any label with reasons is followed by `': '` and the reasons joined with `'; '`:
    - `neighbouring_year`: `` `possibly counted in ${taxYearLabel(year)}` ``;
    - `extra_deduction`: `"possibly an additional deduction or a correction: check the company's intimation or Form 16A"`;
    - `presumed`: `'presumed, not confirmed'`.
- **`shareLines(check, fmt): { income: string, tax: string }`:**
  - **income:** `` `Income: Rokda ${fmt(gross)}` ``, then `` ` (${fmt(presumed.gross)} presumed)` `` when there are presumed dividends, then `` ` · AIS ${fmt(ais.gross)}` `` when there is an AIS line, then `` ` · ${comparisonWords(income, 'AIS', fmt)}` ``. `gross` is confirmed plus presumed.
  - **tax:** the same shape with `Tax:` and the 26AS `tds`; then `` ` · AIS ${fmt(ais.tds)}` `` when the AIS gives tax; then the 26AS comparison words.
- **`returnLines(taxReturn, fmt): string[]`:**
  - `'Claim basis: not set'`, or `` `Claim basis: ${basisWords(…)}` ``;
  - then `'Not filed'`;
  - or, when filed: `` `${revisionLabel(r)}, filed ${shortDate(filed_on)}` ``, then `` `Dividend income ${x}, dividend tax ${y}` ``, then `` `Tax credit claimed: ${a} on dividends, ${b} in all` ``. An unknown figure reads `'not given'`.
- **`eventLine(event, taxReturn, fmt): string`:**
  - starts with `` `${shortDate(happened_on)} · ` ``;
  - **processed:** `` `Processed: refund ${fmt}` `` (or `` `Processed: demand ${fmt(-d)}` ``), then `` `, interest ${fmt}` `` when the interest is above 0;
  - **refund_credited:** `` `Refund credited ${fmt}` ``;
  - **offset_against_demand:** `` `${fmt} set against a demand` ``;
  - **refund_failed:** `'Refund failed'`, then `` ` (${fmt})` `` when there is an amount;
  - when the return's revision is above 1: `` ` · ${revisionLabel(event.revision).toLowerCase()}` ``.
- **`unassignedWords(unassigned): string | null`:**
  - one holding: `` `${name} is shared, so its dividends aren't in anyone's tax year. Give it an owner under Investments to count them.` ``;
  - several: `` `${names joined with ', ' and ' and '} are shared, so their dividends aren't in anyone's tax year. Give them owners under Investments to count them.` ``;
  - none: `null`.

- [ ] **Step 1: Write the failing tests.** Each export gets one `it` per branch above, with the exact strings, built on `taxYears()` output (part 1) and its fixtures. These must include:
  - `checkWords` on a year with both statements and two differing shares gives `'2 differences'`;
  - `checkWords` with only 26AS and no differences gives `'agrees with 26AS; AIS not added'`;
  - `stageWords` on a settled refund of 5,000 credited `'2026-10-05'`, with a surplus of 1,080, gives `` `dividend tax surplus INR 1080; refund INR 5000 credited ${shortDate('2026-10-05')}` ``;
  - `stageWords` before filing gives `'could come back: about INR 1080 at the treaty rate of 10%, INR 216 of it on presumed dividends'`;
  - `comparisonWords` on the neighbouring-year case gives `'only in AIS (INR 1000): possibly counted in tax year 2026-27'`;
  - `comparisonWords` on the extra-deduction case gives `"26AS INR 42 more: possibly an additional deduction or a correction: check the company's intimation or Form 16A"`;
  - `eventLine` on a revision 1 credit, when the return is at revision 2, ends `' · original return'`.
- [ ] **Step 2: Run** `npx vitest run src/lib/dividendTaxText.test.js`. **Expected:** FAIL (no module).
- [ ] **Step 3: Implement** the exports, with a header comment naming the spec and the words rule.
- [ ] **Step 4: Run the same command.** **Expected:** PASS.
- [ ] **Step 5: Commit** (`Dividend tax years: the section's words`).

### Task 3: The return form

**Files:**
- Create: `src/screens/wealth/TaxReturnForm.jsx`, `src/screens/wealth/TaxReturnForm.test.jsx`

**Interfaces:**
- **Produces `<TaxReturnForm memberId year taxReturn onSaved onCancel />`**, where `taxReturn` is a `tax_returns` row or null.
- **Fields, labelled exactly:**
  - "Claim basis": a select of `''` "Not set", `domestic` "Domestic rate", `treaty` "Treaty rate", `manual` "Another rate";
  - "Rate (%)";
  - "Return": a select of `revisionLabel(n)` for n from 0 to `max(2, current + 1)`;
  - "Filed on" (a date);
  - "Dividend income", "Dividend tax", "Tax credit claimed on dividends", "Tax credit claimed in all", "Note".
  - "Filed on" and the four figures show only while "Return" is above 0.
  - A hint under the basis reads: "The rate on gross dividends you'll claim at for this year. A treaty rate needs the residence and documents the treaty asks for."
- **Save** ("Save return"):
  - It sends `save_tax_return({ p_member_id, p_financial_year, p_change, p_expected_version: taxReturn?.version ?? 0 })`.
  - `p_change` holds only the fields that differ from the row as it was; an emptied field is sent as `null`.
  - The revision goes as a number. The basis and rate go together whenever either changes.
- **Amounts:** spaces and commas are removed before `Number()`. Text that is still not a finite number shows "Enter an amount, like 1000.50" under its field, and nothing is sent.
- **Results:**
  - `ok`: calls `onSaved()`.
  - Refused: shows `taxRefusalMessage(error)` (`role="alert"`) and keeps the form.
  - Request error: `Couldn't save that: <message>. Nothing was changed.`
- **Cancel** calls `onCancel()`. Escape cancels; focus starts on "Claim basis".

- [ ] **Step 1: Write the failing tests**, with the Supabase client mocked as in `Dividends.test.jsx`:
  - `'a first save sets the basis at version 0'`: choosing "Treaty rate" and typing `10` sends `{ p_member_id: 'm1', p_financial_year: 2025, p_change: { claim_basis: 'treaty', claim_rate_pct: 10 }, p_expected_version: 0 }`, then calls `onSaved`.
  - `'filing shows the figures and sends only what changed'`: with a version 3 row (treaty 10, revision 0), choosing "Original return", the date `2026-07-20`, income `10,000` and tax `1,000` sends `p_change` `{ revision: 1, filed_on: '2026-07-20', dividend_income: 10000, dividend_tax: 1000 }` and `p_expected_version: 3`.
  - `'amounts typed the Indian way'` (Review Focus 4): `1,20,000.50` is sent as `120000.5`; `12a` shows "Enter an amount, like 1000.50" and no call is made.
  - `'a refusal keeps what was typed'` (Review Focus 3): answering `{ ok: false, error: 'filed_before_year_end' }` shows "A return can only be filed after its tax year has ended." and the date field still holds `2026-03-15`.
  - `'emptying a figure clears it'`: clearing the dividend tax of a filed row sends `{ dividend_tax: null }`.
- [ ] **Step 2: Run** `npx vitest run src/screens/wealth/TaxReturnForm.test.jsx`. **Expected:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, then `npx eslint src e2e`.** **Expected:** PASS and clean.
- [ ] **Step 5: Commit** (`Dividend tax years: the return form`).

### Task 4: What happened to the refund: the event form

**Files:**
- Create: `src/screens/wealth/TaxEventForm.jsx`, `src/screens/wealth/TaxEventForm.test.jsx`

**Interfaces:**
- **Produces `<TaxEventForm memberId year taxReturn event onSaved onCancel />`**, where `event` is a `tax_return_events` row to fix, or null to add one.
- **Fields:**
  - "What happened": a select of `processed` "Processed (intimation)", `refund_credited` "Refund credited", `offset_against_demand` "Set against a demand", `refund_failed` "Refund failed";
  - "Date";
  - for processed: "Refund determined" (hint: "A demand as a negative amount."), "Interest" and "Tax credit allowed in all";
  - for credited and offset: "Amount";
  - for failed: "Amount (if known)";
  - "For": a select of `revisionLabel(n)` for 1 to `taxReturn.revision`, shown only when that is above 1 and defaulting to the latest;
  - "Note".
- **Save** ("Save"):
  - It sends `save_tax_return_event({ p_member_id, p_financial_year, p_event, p_event_id: event?.id ?? null })`.
  - `p_event` holds the kind, the date, the kind's figures as numbers, the revision, and the note when given. A fix sends the whole event.
  - Amounts are read as in Task 3. A negative is allowed only for "Refund determined".
  - Refusals and errors are shown as in Task 3.

- [ ] **Step 1: Write the failing tests:**
  - `'recording a credit'`: "Refund credited", the date `2026-09-20` and `5,150` send `p_event` `{ kind: 'refund_credited', happened_on: '2026-09-20', amount: 5150, revision: 1 }` with `p_event_id: null`.
  - `'a processing with a demand'`: "Refund determined" of `-500` and interest `0` send `{ kind: 'processed', happened_on: …, refund_determined: -500, refund_interest: 0, revision: 1 }`.
  - `'a revised return's event defaults to the latest revision'` (Review Focus 5): with a revision 2 return, "For" shows and defaults to "Revised return". Choosing "Original return" sends `revision: 1`.
  - `'fixing sends the event's id'`: opened on an event with `id 'e1'`, a save sends `p_event_id: 'e1'`.
  - `'a refusal keeps the form'`: `{ ok: false, error: 'in_future' }` shows "That date is after today."
- [ ] **Step 2: Run** `npx vitest run src/screens/wealth/TaxEventForm.test.jsx`. **Expected:** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and lint.** **Expected:** PASS and clean.
- [ ] **Step 5: Commit** (`Dividend tax years: the refund event form`).

### Task 5: The Tax years section in the tab

**Files:**
- Create: `src/screens/wealth/TaxYears.jsx`, `src/screens/wealth/TaxYears.test.jsx`
- Modify: `src/screens/wealth/Dividends.jsx`, `src/screens/wealth/Dividends.css`, `src/screens/wealth/Dividends.test.jsx`

**Interfaces:**
- **Consumes:**
  - `taxYears` and `dividendsInYear` (Task 1, part 1);
  - every export of `dividendTaxText.js` (Task 2);
  - `TaxReturnForm` (Task 3) and `TaxEventForm` (Task 4).
- **Produces `<TaxYears members scopeMemberId data />`**, a `section` with `aria-labelledby` pointing at its title "Tax years" (so its region is named "Tax years"):
  - **Load failure:** when any of the four tax sources `neverLoaded`, the section shows `couldntLoad(missing)` + " Refresh the page to try again." (`role="alert"`) and nothing else.
  - **Nothing to show:** with no years and nothing unassigned, it renders nothing.
  - **Intro**, under the title: "Indian dividends by tax year, checked against the AIS (income) and Form 26AS (tax credit). In rupees."
  - **The years:** `taxYears(...)` on all holdings (not the screen's scope), filtered to `scopeMemberId` when set.
  - **One row per year:** a `dv-rowbutton` with `aria-expanded`.
    - Line 1: the label, then `` ` · ${member name}` `` in "All".
    - Line 2: three parts joined with `' · '`:
      - the dividends: `` `dividends ${fmt(gross)}, tax withheld ${fmt(tax)}` ``, then `` ` (${fmt(presumed tax)} of it presumed)` `` when there are presumed dividends, then `', provisional'` when the year is provisional; or `'no Indian dividends recorded'`;
      - `checkWords(year)`;
      - `stageWords(year, fmt)`.
  - **An opened year** has three parts:
    - **"Shares":** one two-line row per share, its name, then `shareLines`' two lines. A fold "Dividends (n)" lists `dividendsInYear`, each as `` `${shortDate(credited_on)} · ${fmt(gross)}, tax ${fmt(tax)} · ${Received|Presumed}` ``. A dividend with its own year adds `` ` · counted in ${taxYearLabel(year)}` ``.
    - **"Set tax year"** on each listed dividend opens an inline form:
      - "Tax year" offers the credit date's year and the years either side, each as `taxYearLabel`;
      - "Why" offers `declared` "Declared that year (a final dividend)", `paid` "Paid that year (an interim dividend)", `statement` "A statement says so" and `household` "Our own reading";
      - "Save" sends `set_dividend_tax_year({ p_dividend_id, p_financial_year, p_basis, p_expected_version: version })`;
      - on a dividend with its own year, "Use the credit date's year" sends nulls;
      - refusals are shown as in Task 3.
    - **"Return":** `returnLines`, and **Edit** (or **Set claim basis** with no row) opens `TaxReturnForm`.
    - **"What happened to the refund"**, only once filed:
      - `eventLine` for each event in date order, each with **Fix** (opens `TaxEventForm`) and **Remove**;
      - **Remove** asks inline, "Remove this record?", with **Keep it** and **Remove**, and then sends `remove_tax_return_event({ p_member_id, p_event_id })`;
      - **Add** opens an empty `TaxEventForm`;
      - when any processing has interest above 0, a note: "Refund interest is income of the year it arrives: include it in that year's return."
  - **Footnote:** under the rows, `unassignedWords(unassigned)` when present, then always: "A holding's dividends count for its owner today: changing its owner moves them."
  - **After a change:** every save and remove calls `data.reload()`; then the form closes and focus returns to the button that opened it.
- **Dividends.jsx:**
  - renders `<TaxYears members scopeMemberId data />` last, after Freshness;
  - also renders it under the "No holdings that pay dividends." empty state, so tax history without holdings still shows;
  - its own `SOURCES` check does not include the four tax sources, so a tax load failure never hides the tab.
- **CSS:** only what the existing classes don't give (`.tx-lines`, `.tx-fold`), in `Dividends.css` with a comment in its voice.

- [ ] **Step 1: Write the failing tests** in `TaxYears.test.jsx`, mocking the client as `Dividends.test.jsx` does, with fixtures in the part 1 style for members `m1` "One" and `m2` "Two":
  - `'a year reads as one row'`: one 2025 year for `m1` with received 1,000 / 208, both statements agreeing, a filed return (dividend tax 1,000), a processed 5,000 and a credit of 5,000 on `'2026-10-05'`. The row's name starts `FY 2025-26 (AY 2026-27) · One`, and its text includes `agrees with AIS and 26AS` and `refund INR 5,000.00 credited`.
  - `'opening a year shows shares, return and events'`: after a click, the share's two lines, `Original return, filed …` and the credit's `eventLine` show.
  - `'one member's scope'` (Review Focus 2): with `scopeMemberId 'm2'`, `m1`'s year is gone, and a shared holding's `unassignedWords` still shows.
  - `'the tax records failing to load'` (Review Focus 1): with `loaded.taxReturns` false and `errors.taxReturns` set, the section's alert names "tax returns". In `Dividends.test.jsx`, the same data still shows "Dividends at a glance".
  - `'all Indian holdings sold'`: with `quantity: 0` on every Indian holding, the year still shows.
  - `'setting a dividend's tax year'`: "Set tax year", then "FY 2024-25 (AY 2025-26)" and "Declared that year (a final dividend)", then Save, sends `{ p_dividend_id, p_financial_year: 2024, p_basis: 'declared', p_expected_version: 1 }` and reloads.
  - `'removing a refund record asks first'`: Remove, then Remove sends `{ p_member_id: 'm1', p_event_id }`; Keep it sends nothing.
  - `'no estimate without this year's basis'`: a 2026 year with no return, after a 2025 return on the treaty basis at 10%, reads `no claim basis set (last year: the treaty rate of 10%)`.
  - `'no tax history, no section'`: with no Indian dividends, statements or returns, there is no "Tax years" region.
- [ ] **Step 2: Run** `npx vitest run src/screens/wealth/TaxYears.test.jsx src/screens/wealth/Dividends.test.jsx`. **Expected:** FAIL.
- [ ] **Step 3: Implement** the section and mount it.
- [ ] **Step 4: Run them, then lint and `npx vitest run`.** **Expected:** all pass.
- [ ] **Step 5: Commit** (`Dividend tax years: the Tax years section`).

### Task 6: The section in a browser, on a phone

**Files:**
- Create: `e2e/dividends-tax-years.spec.js`

**Interfaces:**
- **Consumes** `stubSupabase` from the e2e helpers, as `e2e/dividends-tab.spec.js` uses it:
  - the tables `tax_returns`, `tax_return_events`, `tax_statements` and `tax_statement_lines`, with the dividend tables;
  - the rpcs `save_tax_return: { ok: true, id: 'r1', version: 2 }`, `set_dividend_tax_year: { ok: true, version: 2 }` and `dividend_feed_status: []`.
  - A stub that 404s an unknown table is extended to answer `[]`.

- [ ] **Step 1: Write the failing test** `'the Tax years section: rows, the check, the return and a dividend's year'`, on desktop and phone:
  - **Fixture:** one Indian holding with a 60-character name and `quantity: 0` (sold), two received dividends in FY 2025-26, both statements (one line differs), a filed return and a credit.
  - **Opening:** open Wealth → Dividends and scroll to the "Tax years" region. The row reads `1 difference`. Opening it shows `Original return, filed`.
  - **Layout:** the document does not scroll sideways, with the row open and with the return form open. The long name's row ends within the viewport. On the phone, every `button` and `summary` in the region is at least 44px tall.
  - **Edit:** Edit, change "Dividend tax" to `1000`, Save return. The request body matches `{ p_member_id, p_financial_year: 2025, p_change: { dividend_tax: 1000 }, p_expected_version: 1 }`.
  - **Set tax year:** on a dividend, Save. The request body has `p_basis: 'declared'`.
  - **Screenshots:** the region closed, open, and with the form, per project.
  - **No page errors.**
- [ ] **Step 2: Run** `CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/dividends-tax-years.spec.js`. **Expected:** the test is red before Task 5's section exists; a run after Task 5, with a deliberate wrong assertion, shows the test can fail. Restore it.
- [ ] **Step 3: Fix** whatever the browser shows that the unit tests didn't: overflow, control height, wrapping.
- [ ] **Step 4: Run the whole Playwright suite.** **Expected:** all pass. A failure already on `main` is named, not hidden.
- [ ] **Step 5: Commit** (`Dividend tax years: the section in a browser and on a phone`).

### Task 7: Docs, checks, review and the pull request

**Files:**
- Modify: `docs/features.md`, `docs/decisions.md`

- [ ] **Step 1: Write the docs:**
  - **`docs/features.md`:** a "Tax years" entry under the Dividends tab: what a row says, what opening it shows, and the three forms.
  - **`docs/decisions.md`:** in "Dividend tax years", a bullet on the screen. Rupees, not dirhams. One row per member and year. Differences counted without "within rounding". The estimate is shown only at the year's own basis. Shared holdings ask whose they are. A tax load failure never hides the tab.
- [ ] **Step 2: Run every check** in `CLAUDE.md` (lint, `npx vitest run`, the build, Playwright, and the SQL script for safety). **Expected:** all pass.
- [ ] **Step 3: Commit** (`Dividend tax years: the screen in the docs`), push, and run the final whole-branch review on the most capable model, then its fix pass.
- [ ] **Step 4: Open the pull request** "Dividend tax years, part 2: the Tax years section". Give a summary, the screens, the tests, and say that it needs no migration.
