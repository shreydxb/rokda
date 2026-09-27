-- Goals priced the way a financial plan prices them. A goal years away is
-- easier to state at today's cost -- a villa costs Rs 5 Cr today -- and let
-- grow at its own rate: education and medical costs rise faster than prices in
-- general, and a UAE goal slower than an Indian one. The priority says which
-- goals money goes to first when there is not enough for all of them.

alter table goals
  -- True: target_amount is today's cost, grown at inflation_pct (or the
  -- household's general inflation when null) until target_date. False: the
  -- target is already the amount needed on the date, as before.
  add column cost_today boolean not null default false,
  add column inflation_pct numeric(6, 3),
  -- 1 first. Null: after every numbered goal, earliest date first.
  add column priority int,
  add constraint goals_inflation_range check (inflation_pct is null or inflation_pct between -10 and 30),
  -- A rate only means something for a cost that grows.
  add constraint goals_inflation_needs_today_cost check (inflation_pct is null or cost_today),
  add constraint goals_priority_range check (priority is null or priority between 1 and 999);
