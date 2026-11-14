# Revamp phase 2: the look, the shell and the shared kit — design

## Why

The household adopted an independent UI/UX review and its clickable
prototype as the plan for the whole app (November 2026, SHR-385), chose
look A (graphite and iris, Geist) and asked for the app to be built like the
prototype. This phase lays the ground every later screen stands on, so no
screen is restyled twice.

## The reference

- The prototype moves into the repo as `design/prototype/`: plain HTML, CSS
  and JavaScript with made-up data ("Maya", "Dev", "Sample household"). It
  replaces "Our Money - Command Center v3" as the authority on look, which
  moves to `design/archive/`. `CLAUDE.md` and `design/README.md` say so.
- "Like the prototype" means its layout, type, colour, spacing and
  components. Where the prototype shows a figure the app does not work out
  today, the screen's own phase says whether it is added (with tests) or
  left out; nothing is shown that the data cannot back.
- Every warning, error and status the app has today stays, even where the
  prototype's sample data never shows it.

## What this phase changes

1. **Look.** The prototype's tokens replace today's: graphite and iris, in
   dark and light, with green, red and amber for status only. Geist and
   Geist Mono replace Newsreader and IBM Plex. Corners round to the
   prototype's 7–10px. The first visit follows the device's light or dark
   setting; the choice is then remembered, as now.
2. **Sidebar.** Logo mark and name; "Showing: Both / {A} / {B}" at the top;
   Overview, Inbox (with its count), Money, Wealth, Planning, then Settings,
   each with a small outline icon. Display currency, light/dark, sign-out and
   the build move into the account menu at the foot. Inbox links to today's
   Inbox until phase 4 gives it its own page.
3. **Page header.** One row: the title (and kicker on Overview) on the left;
   on the right, the period control, the one primary action, and a refresh
   icon with the time it last loaded. Tabs sit under it on the rule.
4. **Shared kit**, as React components in `src/design-system/` with tests:
   card (panel with heading and right-hand link), KPI strip, chip (grey,
   amber, red, green), warning row, info button (opens the explanation in a
   popover), month stepper (`‹ Nov 2026 ›`), segmented control, select,
   switch, table, fold ("▸ Done (4)"), empty state, banner with "Try again",
   right-hand drawer (tabs, sticky footer, Delete left / Cancel and primary
   right), and the chart kit (trend line, paired columns, bar list, bullet,
   stacked bar, dated strip, year bars).
5. **Existing screens** keep their layout in this phase but take the new
   tokens, fonts, sidebar and header, so nothing looks broken between
   phases. Each later phase then rebuilds its screens from the kit.

## Not in this phase

- Screen layouts (phases 3–7), the bot (phase 8).
- Quick add and jump (Ctrl+K): after the revamp, as its own feature.

## Checks

- Unit tests for each kit component; screen tests and the browser checks
  stay green; a before/after of every screen at 1440×900, dark and light.
- Load size measured before and after (fonts and CSS), so the new look does
  not make the app slower.
- Phone layouts keep working; not redesigned.

## Left to the builder

Exact component names, the token mapping from today's names, and the tests.
