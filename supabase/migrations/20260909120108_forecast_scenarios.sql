-- A "Custom" scenario for the Forecast screen's scenario picker (Baseline /
-- Conservative / Optimistic / Custom). Conservative and Optimistic are
-- derived on the client from the baseline (nominal ∓2pp, inflation ±1pp) —
-- Custom is the only one that needs its own storage, since it's the one a
-- household actually edits independently of its saved baseline.
alter table planning_assumptions
  add column custom_nominal_return_pct numeric(6, 3),
  add column custom_inflation_pct numeric(6, 3),
  add column custom_safe_withdrawal_pct numeric(6, 3),
  add column custom_updated_at timestamptz;
