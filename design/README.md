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

## Open questions before building the v3-specific features above

1. Do we want the AED/USD/INR display toggle in the real app, and if so, what
   FX source feeds it (manual rate, same as holdings, or the planned live FX
   feed infra)?
2. Do we want the richer holdings table now (needs schema migration) or defer
   until the live price/FX feed work happens?
3. Do we want in-app add/remove-card UI on the credit cards panel, or is
   Settings → accounts sufficient?

None of these block items #1 (net worth + holdings) or #2 (real Needs
Attention detectors), which don't depend on this design revision.
