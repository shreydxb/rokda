# The shell, and fewer words — design

## Why

The revamp audit (November 2026, SHR-385) found the same things on every
screen: small spaced-out capitals as labels, no screen title, technical
details in everyday view, a sidebar whose background stopped partway down,
and long paragraphs explaining how figures are worked out. The household's
words: "too many texts in the entire site; make it look clean and
professional". These are shared pieces, so one change fixes every screen.

## What changes, everywhere

1. **A title on every screen.** Money, Wealth, Planning and Settings get
   their name as a 26px title in Rokda's figure face, where a tiny
   spaced-out label sat. Overview keeps its own title ("3 things need a
   decision").
2. **Labels in sentence case.** "MONTH TO DATE", "NOT CHECKED" and the
   table headers become "Month to date", "Not checked", "Category": 13px for
   section labels, 12px for table headers, no letter spacing. All 21 such
   styles change in one sweep.
3. **The sidebar runs the full height.** The household and currency
   switches sit under the menu; the theme, account and sign-out sit at the
   foot. The phone layout is unchanged.
4. **Technical details leave everyday view.**
   - The build number leaves the sidebar for Settings → Household, in an
     "About" line.
   - "Loaded 20:47 · Refresh" becomes a plain "Refresh". The time shows on
     hover and is still announced to screen readers; the page also reads
     itself again every few minutes, as now.
5. **Fewer words: the rule.** Each block gets at most one short line of
   help. Anything longer (how a figure is worked out, why a number may
   differ, what a feed does) goes behind a small "How this is worked out"
   link that opens in place. Figures carry labels, not sentences.
6. **Fewer words: this PR.** The rule above is applied to the longest
   passages now:
   - Budget's household-share paragraph;
   - Investments' feed and refresh sentence;
   - Settings → Household's currency and members paragraphs;
   - the Plan and Life plan basis box;
   - the Life plan's closing assumptions paragraph.

   The rest is cut screen by screen, in each screen's own PR.

## Before and after

The screenshots sent with this design show Overview and Money → Budget,
before and after items 1–4. They use the test household's made-up figures.

## Goals and limits

- Goal: every screen reads calm at a glance: its title, its figures and one
  line of help at most, with the detail one click away.
- Nothing is removed that a decision depends on. Warnings ("2 holdings
  failed to refresh"), errors and statuses stay in view; only explanations
  move.
- Rokda's palette, typefaces and dark look (`design/`) are unchanged.
- Not in this PR: each screen's own layout changes (Overview, Money, Wealth,
  Life plan, Settings), which follow in the agreed order.

## Left to the builder

The exact wording of each shortened line, and the tests.
