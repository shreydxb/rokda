-- Dividends (SHR-366), PR 3: what the Dividends tab reads.
--
-- Design: docs/superpowers/specs/2026-11-02-dividends-design.md, section 6.
-- The tab says, per market, when the feed last checked, which shares are
-- failing and since when, and from what date each share's history is
-- covered. Members could not read the feed's bookkeeping at all; this gives
-- them that much of it, for their own shares only, and never the feed's raw
-- error, which can quote a provider's request URL with its key in it.
--
-- It also lets a member answer whether part of a dividend was a one-off for
-- any event of a share a holding follows. A payment from before a holding's
-- opening entry earned nothing, but it still shapes the share's projection.

-- The feed's freshness for the shares the signed-in member's household
-- follows: one row per share, provider and kind (dividends or splits).
create or replace function public.dividend_feed_status()
returns table (
  symbol text, provider text, kind text, last_success_at timestamptz, last_failure_at timestamptz,
  fail_count integer, covered_from date)
language sql
stable
security definer
set search_path = ''
as $$
  select s.symbol, s.provider, s.kind, s.last_success_at, s.last_failure_at, s.fail_count, s.covered_from
  from public.dividend_feed_state s
  where exists (
    select 1 from public.holdings h
    where h.price_symbol = s.symbol
      and private.dividend_provider(h) = s.provider
      and private.is_household_member(h.household_id))
  order by s.symbol, s.provider, s.kind;
$$;

revoke execute on function public.dividend_feed_status() from public, anon;
grant execute on function public.dividend_feed_status() to authenticated;

-- The same function as 20261103061556_dividend_receipts, answering for an
-- event of any share one of the household's holdings follows, as well as one
-- the household has a dividend on.
create or replace function public.set_special_part(p_event_id uuid, p_special_per_share numeric, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_member uuid;
  v_amount numeric;
begin
  select m.household_id into v_household from public.household_members m
  where (auth.uid() is not null and m.user_id = auth.uid()) or (auth.uid() is null and m.id = p_member_id)
  limit 1;
  v_member := case when v_household is null then null else private.trade_caller(v_household, p_member_id) end;
  if v_member is null or not (
    exists (select 1 from public.holding_dividends d where d.household_id = v_household and d.event_id = p_event_id)
    or exists (
      select 1 from public.holdings h join public.dividend_events e on e.symbol = h.price_symbol
      where h.household_id = v_household and e.id = p_event_id)) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if p_special_per_share is null then
    delete from public.dividend_special_parts where household_id = v_household and event_id = p_event_id;
    return jsonb_build_object('ok', true, 'special_per_share', null);
  end if;
  select e.amount into v_amount from public.dividend_events e where e.id = p_event_id;
  if p_special_per_share < 0 or p_special_per_share > v_amount then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  insert into public.dividend_special_parts (household_id, event_id, special_per_share, updated_by)
  values (v_household, p_event_id, p_special_per_share, v_member)
  on conflict (household_id, event_id) do update
    set special_per_share = excluded.special_per_share, updated_by = excluded.updated_by;
  return jsonb_build_object('ok', true, 'special_per_share', p_special_per_share);
end;
$$;
