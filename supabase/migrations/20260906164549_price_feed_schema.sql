-- Real price/FX feed schema (SHR-237). All new holdings columns are
-- nullable/opt-in: a holding stays fully manual until someone sets a
-- price_symbol + price_provider, so existing data is untouched.
alter table holdings
  add column price_symbol text,
  add column price_provider text check (price_provider in ('twelvedata', 'coingecko', 'mfapi')),
  add column price_fetch_error text,
  add column price_fetch_fail_count integer not null default 0;

-- Global market data, not household data: one row per currency pair,
-- written only by the price-refresh Edge Function (service role, bypasses
-- RLS). Any authenticated household member can read it.
create table fx_rates (
  base text not null,
  quote text not null,
  rate numeric(14, 6),
  fetched_at timestamptz,
  fetch_error text,
  fail_count integer not null default 0,
  primary key (base, quote)
);

alter table fx_rates enable row level security;
create policy "authenticated users can read fx rates" on fx_rates
  for select using (auth.role() = 'authenticated');

-- Distinguishes a rate a person typed in from one the scheduled feed wrote,
-- so the UI can stop claiming "manual" once the real feed is live.
alter table households
  add column inr_rate_source text not null default 'manual' check (inr_rate_source in ('manual', 'auto'));
