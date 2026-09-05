-- Richer per-holding pricing fields, matching the v3 design's 10-column
-- holdings table. All nullable: most holdings won't have this detail until
-- entered manually (there's still no live price/FX feed — see SHR-237),
-- so the table degrades gracefully to "—" wherever it's unset rather than
-- guessing a number.
alter table holdings
  add column quantity numeric(18, 4),
  add column avg_price numeric(14, 4), -- in the holding's own currency
  add column current_price numeric(14, 4), -- in the holding's own currency
  add column invested_value_aed numeric(14, 2),
  add column day_change_pct numeric(6, 2); -- as of last_refreshed, not live
