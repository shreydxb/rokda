-- Guards from the review of the share-trades step (Linear SHR-368, SHR-370;
-- docs/decisions.md, "Trades are the record of a holding" and "A broker's
-- cash is an account").
--
-- * Only the bot marks a trade as the bot's. record_trade let a signed-in
--   member pass p_source 'bot' or 'statement' and any proposal id; a member's
--   own call is now always an app trade.
-- * A holding's version never comes round again. Deleting the only opening
--   entry used to put it back to 0, and going live again to 1, so a bot
--   confirmation shown at version 1 before the undo passed the stale check
--   against a holding with different units. The undo now keeps the last
--   version as a negative number (still untraded: every untraded test is
--   <= 0), and going live continues from it.
-- * A fund that is only a holding's usual fund can be deleted. The foreign
--   key refused it with a raw error in the account editor; the holding is
--   now left with no usual fund. A fund money moved through still cannot be
--   deleted (holding_trades_funds_fk is unchanged).
--
-- The four functions are the step-1 functions with only those changes.

comment on column holdings.trades_version is
  'Raised by every replay of the holding''s trades; 0 until the holding has an opening entry. Negative after its only opening entry was deleted: untraded again, and going live continues from the absolute value, so no version is ever reused. A confirmation shown on an older version is refused.';

alter table holdings drop constraint holdings_funds_account_fk;
alter table holdings add constraint holdings_funds_account_fk
  foreign key (household_id, funds_account_id) references accounts (household_id, id) on delete set null (funds_account_id);

create or replace function private.trade_effect(
  p_holding public.holdings, p_kind text, p_trade_date date, p_units numeric, p_price numeric,
  p_fees numeric, p_tax_withheld numeric, p_traded_at timestamptz, p_funds_account_id uuid, p_replace_trade_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  -- Inputs are rounded to the scales they are stored at, so the replay here
  -- works on exactly the figures that will be saved.
  v_units numeric := round(p_units, 8);
  v_price numeric := round(p_price, 6);
  v_fees numeric := round(coalesce(p_fees, 0), 4);
  v_tax numeric := round(coalesce(p_tax_withheld, 0), 4);
  v_old public.holding_trades%rowtype;
  v_old_fund public.accounts%rowtype;
  v_fund public.accounts%rowtype;
  v_fund_id uuid;
  v_cash numeric := 0;
  v_moves boolean := false;
  v_old_moves boolean := false;
  v_delta numeric := 0;
  v_old_delta numeric := 0;
  v_entries jsonb;
  v_result jsonb;
  v_new jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  if p_kind is null or p_kind not in ('opening', 'buy', 'sell', 'split') or p_trade_date is null
     or v_units is null or v_units <= 0 or v_fees < 0 or v_tax < 0
     or (p_kind = 'split') <> (v_price is null) or coalesce(v_price, 0) < 0
     or (p_kind <> 'sell' and v_tax <> 0) or (p_kind in ('opening', 'split') and v_fees <> 0) then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  if p_replace_trade_id is not null then
    select * into v_old from public.holding_trades where id = p_replace_trade_id and holding_id = p_holding.id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'trade_not_found');
    end if;
    -- An opening entry stays an opening entry, and nothing else becomes one.
    if (v_old.kind = 'opening') <> (p_kind = 'opening') then
      return jsonb_build_object('ok', false, 'error', 'bad_input');
    end if;
  elsif p_kind = 'opening' then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  if p_holding.trades_version <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_opening');
  end if;
  if p_holding.asset_class = 'india_equity' and p_kind <> 'split' and v_units <> trunc(v_units) then
    return jsonb_build_object('ok', false, 'error', 'whole_units_only');
  end if;

  -- The fund named, else the fund the trade already used (a fix that leaves
  -- the fund alone keeps it), else the holding's usual one.
  if p_kind in ('buy', 'sell') then
    v_fund_id := coalesce(p_funds_account_id, v_old.funds_account_id, p_holding.funds_account_id);
    if v_fund_id is null then
      return jsonb_build_object('ok', false, 'error', 'fund_required');
    end if;
    select * into v_fund from public.accounts where id = v_fund_id and household_id = p_holding.household_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'fund_required');
    end if;
    -- A trade's money sits with the broker; a card or a bank account would
    -- take the trade's cash into spending and the cash cover.
    if v_fund.type <> 'broker_funds' then
      return jsonb_build_object('ok', false, 'error', 'not_broker_funds');
    end if;
    if v_fund.currency is distinct from p_holding.currency then
      return jsonb_build_object('ok', false, 'error', 'currency_mismatch');
    end if;
    if v_fund.archived_at is not null then
      return jsonb_build_object('ok', false, 'error', 'fund_archived');
    end if;
    v_cash := round(case when p_kind = 'buy' then -(v_units * v_price + v_fees) else v_units * v_price - v_fees - v_tax end, 4);
    v_moves := private.trade_moves_fund(v_fund.balance_as_of, p_trade_date, p_traded_at);
  end if;

  v_entries := private.holding_entries(p_holding.id, p_replace_trade_id) || jsonb_build_array(jsonb_build_object(
    'id', 'new', 'kind', p_kind, 'trade_date', p_trade_date, 'traded_at', p_traded_at,
    'created_at', coalesce(v_old.created_at, clock_timestamp()), 'units', v_units, 'price', v_price, 'fees', v_fees,
    'brokerage_in_average', v_fund.brokerage_in_average));
  v_result := private.replay_entries(v_entries, private.holding_brokerage_in_average(p_holding));
  if not (v_result ->> 'ok')::boolean then
    return v_result;
  end if;
  select x into v_new from jsonb_array_elements(v_result -> 'entries') x where x ->> 'id' = 'new';

  -- The money: the new trade's, less the replaced trade's where that had
  -- moved its fund. A different fund is reversed on its own. A balance is
  -- kept in fils, so the movement is too.
  if v_moves then v_delta := v_cash; end if;
  if v_old.funds_account_id is not null then
    select * into v_old_fund from public.accounts where id = v_old.funds_account_id;
    v_old_moves := private.trade_moves_fund(v_old_fund.balance_as_of, v_old.trade_date, v_old.traded_at);
    if v_old_moves then
      if v_old.funds_account_id = v_fund_id then
        v_delta := v_delta - v_old.cash_amount;
      else
        v_old_delta := -v_old.cash_amount;
      end if;
    end if;
  end if;
  v_delta := round(v_delta, 2);
  v_old_delta := round(v_old_delta, 2);

  if p_kind in ('buy', 'sell') then
    if not v_moves then
      v_warnings := v_warnings || '"fund_confirmed_after"'::jsonb;
    end if;
    if v_fund.balance + v_delta < 0 then
      v_warnings := v_warnings || '"fund_below_zero"'::jsonb;
    end if;
    if p_holding.current_price > 0 and abs(v_price / p_holding.current_price - 1) > 0.20 then
      v_warnings := v_warnings || '"price_off_market"'::jsonb;
    end if;
    if exists (
      select 1 from public.holding_trades t
      where t.holding_id = p_holding.id and t.kind = p_kind and t.units = v_units and t.price = v_price
        and abs(t.trade_date - p_trade_date) <= 2 and t.id is distinct from p_replace_trade_id
    ) then
      v_warnings := v_warnings || '"possible_duplicate"'::jsonb;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'units', v_units,
    'price', v_price,
    'fees', v_fees,
    'tax_withheld', v_tax,
    'trades_version', p_holding.trades_version,
    'units_before', p_holding.quantity,
    'avg_before', p_holding.avg_price,
    'units_after', v_new -> 'units_after',
    'avg_after', v_new -> 'avg_after',
    'realised', v_new -> 'realised',
    'holding_units_after', v_result -> 'units',
    'holding_avg_after', v_result -> 'avg',
    'cash_amount', v_cash,
    'funds_account_id', v_fund_id,
    'funds_moves', v_moves,
    'funds_balance_before', v_fund.balance,
    'funds_balance_after', v_fund.balance + v_delta,
    'funds_delta', v_delta,
    'old_funds_account_id', case when v_old_delta <> 0 then v_old.funds_account_id end,
    'old_funds_delta', v_old_delta,
    'warnings', v_warnings);
end;
$$;

create or replace function public.record_trade(
  p_holding_id uuid, p_kind text, p_trade_date date, p_units numeric, p_price numeric,
  p_fees numeric default 0, p_tax_withheld numeric default 0, p_traded_at timestamptz default null,
  p_funds_account_id uuid default null, p_source text default 'app', p_proposal_id uuid default null,
  p_member_id uuid default null, p_expected_version integer default null, p_tax_to_confirm boolean default false,
  p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holding public.holdings%rowtype;
  v_member uuid;
  v_existing uuid;
  v_effect jsonb;
  v_trade uuid;
begin
  -- Locked for the whole save, so two trades on one holding replay in turn.
  select * into v_holding from public.holdings where id = p_holding_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'holding_not_found');
  end if;
  v_member := private.trade_caller(v_holding.household_id, p_member_id);
  if v_member is null then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  -- A member's own call is an app trade. Only the bot (the service role)
  -- records a trade as the bot's or a statement's, or ties it to a bot
  -- proposal: a member passing either would make a trade look confirmed in
  -- Telegram when it was not, or use up another proposal's one trade.
  if auth.uid() is not null and (p_source is distinct from 'app' or p_proposal_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if p_source is null or p_source not in ('bot', 'app', 'statement') or p_kind = 'opening'
     or (coalesce(p_tax_to_confirm, false) and p_kind <> 'sell') then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  if p_proposal_id is not null then
    select id into v_existing from public.holding_trades where proposal_id = p_proposal_id;
    if found then
      return jsonb_build_object('ok', false, 'error', 'already_recorded', 'trade_id', v_existing);
    end if;
  end if;
  if p_expected_version is not null and p_expected_version <> v_holding.trades_version then
    return jsonb_build_object('ok', false, 'error', 'stale', 'trades_version', v_holding.trades_version);
  end if;

  perform private.lock_funds(array[coalesce(p_funds_account_id, v_holding.funds_account_id)]);
  v_effect := private.trade_effect(v_holding, p_kind, p_trade_date, p_units, p_price, p_fees, p_tax_withheld,
    p_traded_at, p_funds_account_id, null);
  if not (v_effect ->> 'ok')::boolean then
    return v_effect;
  end if;

  insert into public.holding_trades (
    household_id, holding_id, member_id, kind, trade_date, traded_at, units, price, fees, tax_withheld,
    tax_to_confirm, funds_account_id, cash_amount, source, proposal_id, note, created_by, created_at)
  values (
    v_holding.household_id, v_holding.id, coalesce(v_holding.owner_member_id, v_member), p_kind, p_trade_date,
    p_traded_at, (v_effect ->> 'units')::numeric, (v_effect ->> 'price')::numeric, (v_effect ->> 'fees')::numeric,
    (v_effect ->> 'tax_withheld')::numeric, coalesce(p_tax_to_confirm, false),
    (v_effect ->> 'funds_account_id')::uuid, (v_effect ->> 'cash_amount')::numeric, p_source, p_proposal_id,
    p_note, v_member, clock_timestamp())
  returning id into v_trade;

  perform private.save_replay(v_holding, v_effect);
  perform private.move_fund((v_effect ->> 'funds_account_id')::uuid, (v_effect ->> 'funds_delta')::numeric, p_source, v_member);

  return v_effect || jsonb_build_object('trade_id', v_trade, 'trades_version', v_holding.trades_version + 1);
end;
$$;

create or replace function public.delete_trade(p_trade_id uuid, p_expected_version integer, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trade public.holding_trades%rowtype;
  v_holding public.holdings%rowtype;
  v_fund public.accounts%rowtype;
  v_member uuid;
  v_result jsonb;
  v_delta numeric := 0;
  v_source text := case when auth.uid() is not null then 'app' else 'bot' end;
begin
  select * into v_trade from public.holding_trades where id = p_trade_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'trade_not_found');
  end if;
  select * into v_holding from public.holdings where id = v_trade.holding_id for update;
  -- Read the trade again now the holding is locked: a save that held the lock
  -- first may have changed or deleted it, and acting on the first read would
  -- move its money twice.
  select * into v_trade from public.holding_trades where id = p_trade_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'trade_not_found');
  end if;
  v_member := private.trade_caller(v_holding.household_id, p_member_id);
  if v_member is null then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if p_expected_version is not null and p_expected_version <> v_holding.trades_version then
    return jsonb_build_object('ok', false, 'error', 'stale', 'trades_version', v_holding.trades_version);
  end if;

  if v_trade.kind = 'opening' then
    if exists (select 1 from public.holding_trades t where t.holding_id = v_holding.id and t.id <> v_trade.id) then
      return jsonb_build_object('ok', false, 'error', 'opening_has_trades');
    end if;
    -- Back to being edited by hand, keeping the last version as a negative
    -- number: going live again continues from it, so a confirmation shown
    -- before the undo is stale rather than matching a reused version.
    delete from public.holding_trades where id = v_trade.id;
    perform set_config('rokda.trade_replay', 'on', true);
    update public.holdings set trades_version = -trades_version where id = v_holding.id;
    perform set_config('rokda.trade_replay', '', true);
    return jsonb_build_object('ok', true, 'trade_id', v_trade.id, 'trades_version', -v_holding.trades_version);
  end if;

  perform private.lock_funds(array[v_trade.funds_account_id]);
  v_result := private.replay_entries(private.holding_entries(v_holding.id, v_trade.id), private.holding_brokerage_in_average(v_holding));
  if not (v_result ->> 'ok')::boolean then
    return v_result;
  end if;

  delete from public.holding_trades where id = v_trade.id;
  perform private.write_replay(v_holding.id, v_result);

  if v_trade.funds_account_id is not null then
    select * into v_fund from public.accounts where id = v_trade.funds_account_id;
    if private.trade_moves_fund(v_fund.balance_as_of, v_trade.trade_date, v_trade.traded_at) then
      v_delta := -v_trade.cash_amount;
      perform private.move_fund(v_fund.id, v_delta, v_source, v_member);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'trade_id', v_trade.id, 'trades_version', v_holding.trades_version + 1,
    'holding_units_after', v_result -> 'units', 'holding_avg_after', v_result -> 'avg',
    'funds_account_id', v_trade.funds_account_id, 'funds_delta', v_delta);
end;
$$;

create or replace function public.open_trade_history(p_member_id uuid, p_trade_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holding record;
  v_household uuid;
  v_funds uuid[];
  v_count integer := 0;
  v_shared integer;
begin
  select household_id into v_household from public.household_members where id = p_member_id;
  for v_holding in
    select h.* from public.holdings h
    where h.owner_member_id = p_member_id and h.trades_version <= 0
      and h.quantity > 0 and h.avg_price is not null
      and not exists (select 1 from public.holding_trades t where t.holding_id = h.id and t.kind = 'opening')
    order by h.created_at, h.id
    for update
  loop
    if v_holding.funds_account_id is null then
      select array_agg(a.id) into v_funds from public.accounts a
      where a.household_id = v_holding.household_id and a.owner_member_id = p_member_id
        and a.type = 'broker_funds' and a.currency = v_holding.currency and a.archived_at is null;
      if cardinality(v_funds) = 1 then
        update public.holdings set funds_account_id = v_funds[1] where id = v_holding.id;
      end if;
    end if;
    insert into public.holding_trades (
      household_id, holding_id, member_id, kind, trade_date, units, price, source, units_after, avg_after, created_by, created_at)
    values (
      v_holding.household_id, v_holding.id, p_member_id, 'opening', p_trade_date, v_holding.quantity, v_holding.avg_price,
      'opening', v_holding.quantity, v_holding.avg_price, p_member_id, clock_timestamp());
    perform set_config('rokda.trade_replay', 'on', true);
    update public.holdings set trades_version = abs(trades_version) + 1 where id = v_holding.id;
    perform set_config('rokda.trade_replay', '', true);
    v_count := v_count + 1;
  end loop;

  select count(*) into v_shared from public.holdings h
  where h.household_id = v_household and h.owner_member_id is null and h.trades_version <= 0
    and h.quantity > 0 and h.avg_price is not null;
  return jsonb_build_object('opened', v_count, 'shared_left', v_shared);
end;
$$;
