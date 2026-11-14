# Design reference

`prototype/` is the design reference for Rokda since the revamp (November
2026). It is a clickable mock built from an independent UI/UX review, which
the household adopted as the plan: open `prototype/index.html` in a browser.
Its data is made up ("Maya", "Dev", "Sample household"); match its look,
layout and interaction, not its numbers. The review itself is kept privately
(Linear, SHR-385), because it carries the household's own notes.

- Look: "graphite and iris", in dark and light, with Geist and Geist Mono.
  The accent marks the main data series and the one primary button; green,
  red and amber mean status only. `src/design-system/tokens.css` carries the
  same values.
- Where the prototype shows a figure the app does not work out, the screen's
  phase decides whether it is added (with tests) or left out. Every warning,
  error and status the app has stays, even where the prototype's sample data
  never shows it.
- `prototype/README.md` lists what to try and the states it shows.

`archive/` holds "Our Money - Command Center v3", the reference before the
revamp, kept for its history.
