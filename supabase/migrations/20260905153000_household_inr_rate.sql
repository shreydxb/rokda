-- A manually-set, honest INR conversion rate for the multi-currency display
-- toggle. There's no live FX feed (see SHR-237), so this is a real number a
-- household member enters and updates by hand, timestamped so the UI can say
-- "set on <date>" instead of implying a live rate. USD isn't stored here —
-- it's the AED-USD peg (3.6725, fixed since 1997), a constant, not a rate
-- anyone needs to maintain.
alter table households
  add column inr_per_aed numeric(10, 4),
  add column inr_rate_set_at timestamptz;
