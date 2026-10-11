-- Two rules from the older finance app that Rokda did not follow
-- (docs/decisions.md, "A holding's cost is its units at their average price"
-- and "A price is as old as its quote").
--
-- 1. A holding's cost was a fixed AED figure, typed in or worked out at the
--    rupee rate of the day it was entered. Its value follows today's rate
--    (price-refresh), so the gain on a rupee holding mixed share performance
--    with however far the rate had moved since. Now, for every holding with
--    units and an average price, the cost is worked out from them in the
--    holding's own currency and converted the way its value is: AED as is,
--    USD at the peg, INR at the household's current rate. No rate, no AED
--    cost: unknown, never 1:1. A holding without units keeps the cost a
--    person entered, and a currency Rokda cannot convert keeps it too.
-- 2. priced_at was set to when the feed ran, so a price the exchange quoted
--    days ago (a suspended share, a stale fund NAV) looked fresh. The feed
--    now writes the provider's own quote time into priced_at, and the time it
--    fetched into the new price_fetched_at.

alter table holdings add column if not exists price_fetched_at timestamptz;

comment on column holdings.price_fetched_at is
  'When price-refresh last fetched this holding''s price. Not how old the price is: that is priced_at, the provider''s quote time.';

comment on column holdings.priced_at is
  'When the stored value/price was valued as of: the provider''s quote time for a feed price, or the date a person confirmed a valuation. Never advanced by reloading or by a rate change. See holdings_sync_priced_at().';

create or replace function holdings_derive_cost()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_inr_per_aed numeric;
begin
  -- Units and an average price are the cost. Without both, the cost is
  -- whatever a person entered.
  if new.quantity is null or new.avg_price is null then
    return new;
  end if;

  if new.currency = 'AED' then
    new.invested_value_aed := round(new.quantity * new.avg_price, 2);
  elsif new.currency = 'USD' then
    new.invested_value_aed := round(new.quantity * new.avg_price * 3.6725, 2);
  elsif new.currency = 'INR' then
    select inr_per_aed into v_inr_per_aed from households where id = new.household_id;
    new.invested_value_aed := case when v_inr_per_aed > 0 then round(new.quantity * new.avg_price / v_inr_per_aed, 2) end;
  end if;
  return new;
end;
$$;

revoke execute on function holdings_derive_cost() from public, anon, authenticated;

create or replace trigger holdings_derive_cost
  before insert or update on holdings
  for each row
  execute function holdings_derive_cost();

comment on column holdings.invested_value_aed is
  'What the holding cost, in AED. With units and an average price it is worked out from them by holdings_derive_cost(): the peg for USD, households.inr_per_aed for INR, re-applied when that rate changes (holdings_follow_inr_rate). Null when there is no rate. Without units it is what a person entered.';

-- When the rupee rate changes, rupee holdings with units follow it: the cost
-- through holdings_derive_cost(), and the value from the last price. A rate
-- change is not a reprice, so priced_at and the value history stay as they
-- are. With no rate the value is left alone (the column cannot be empty) and
-- the cost becomes unknown, which the Investments screen shows.
create or replace function holdings_follow_inr_rate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update holdings
     set value_aed = case
           when new.inr_per_aed > 0 and quantity is not null and current_price is not null
             then round(quantity * current_price / new.inr_per_aed, 2)
           else value_aed
         end
   where household_id = new.id and currency = 'INR';
  return null;
end;
$$;

revoke execute on function holdings_follow_inr_rate() from public, anon, authenticated;

create or replace trigger holdings_follow_inr_rate
  after update of inr_per_aed on households
  for each row when (new.inr_per_aed is distinct from old.inr_per_aed)
  execute function holdings_follow_inr_rate();

-- Every holding with units and an average price, worked out once now. The
-- dollar ones move by rounding at most; the rupee ones move to today's rate.
update holdings set quantity = quantity
 where quantity is not null and avg_price is not null;
