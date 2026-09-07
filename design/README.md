# Design reference

`Our Money - Command Center v3.dc.html` (+ `support.js`) is the current design
reference for Rokda. It supersedes the v2 file used earlier in the build.

This is a mockup with fabricated example data — match its visual/interaction
language, not its numbers. Real screens use real household data.

## What changed vs v2

- **Card names/data now match our real cards** — "NBD Platinum" → "ENBD Noon",
  plus FAB Z, FAB Islamic, and Wio added. "Aparna" renamed to "Tarika"
  throughout.
- **Multi-currency display toggle** (AED / USD / INR) in the sidebar. Converts
  *display only* — all figures are still stored in AED; a `cx()` pass rewrites
  authored AED amounts in prose to the selected display currency using a fixed
  rate table. Native transaction/holding currency is never converted, only the
  AED-equivalent figures are. Not yet discussed whether/how to build this in
  the real app (Rokda has no live FX feed by design).
- **Credit cards panel redesigned**: large single-column panels → compact
  responsive card grid. Each card gets a 3-stat mini-grid (Spent so far /
  Pending / Before close), a per-card "Remove" action, and a new "+ Add a
  card" tile. Real build would need add/remove-card UI wired to `accounts`.
- **Holdings table restructured**: 7 columns (Holding/Owner/Units/Price/Value
  AED/range/Quote-basis) → 10 columns (Holding/Owner/Ccy/Units/Avg
  price/Price now/Invested/Value/P&L/Today). This maps closely onto the
  Zerodha CSV columns (Qty/Avg cost/LTP/Invested/Cur. val/P&L/Day chg) — real
  build would need new `holdings` columns: currency, avg_price, current_price,
  invested_value, day_change_pct (currently only `name/asset_class/currency/
  value_aed` exist).
- **Net Worth and Investments charts reworked**: stacked-bar+line → full
  interactive area/line charts with hover tooltips (date, value, % change) and
  an inline stats row (replacing the old legend). Investments gained a
  top-line summary (Invested / P&L to date / Change today).
- **Transaction rows gained a native-currency sub-line** (e.g. "INR 2,010" for
  a rupee-denominated purchase billed in AED) — real build needs
  `transactions.native_amount` / `native_currency` columns.
- **"Needs Attention" copy re-worded** (e.g. stale-FX card became a "Rate
  move" framing) — superseded by the real, condition-based detectors being
  built directly (see Linear), not template text to port over.

## Open questions — resolved

All three questions this file used to carry have since been answered by the
build, and are recorded here rather than left open:

1. **AED/USD/INR display toggle** — built. Display-only conversion from stored
   AED. USD uses the fixed 3.6725 AED peg; INR uses `households.inr_per_aed`, a
   manually entered rate, and stays unavailable until someone sets one. There is
   no live FX feed and none is planned as a release prerequisite.
2. **Richer holdings table** — built, with the pricing columns added by
   `20260905150000_holding_pricing_fields.sql` and the commodity asset class by
   `20260905160000_holdings_commodity_class.sql`.
3. **In-app card add/remove** — the add and edit paths are built on the cards
   panel. "Remove" is deliberately **not** a delete: an account with history is
   closed/archived so its transactions survive (QA-01, SHR-242). Hard deletion
   remains available only for an account that has never been used.
