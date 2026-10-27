-- Share trades (SHR-367; docs/decisions.md, "Trades are the record of a
-- holding" and "A broker's cash is an account"). A holding changed only when
-- someone edited it, so nothing recorded a sale, what it made, or where its
-- money went. From each holding's fresh start (an opening entry at the
-- broker's units and average price), every buy, sell and split is a dated
-- trade, and the holding's units and average are worked out from them. A
-- broker's uninvested cash is an account of its own kind, which every buy
-- pays from and every sale pays into.

-- ---------------------------------------------------------------------------
-- 1. The trade record, Broker funds, and the guards on traded holdings
-- ---------------------------------------------------------------------------

-- A broker's cash is an account: it counts in net worth and as the Life
-- plan's cash, never as money for bills or spending (the app decides that).
alter table accounts drop constraint accounts_type_check;
alter table accounts add constraint accounts_type_check check (
  type in ('checking', 'savings', 'credit_card', 'investment', 'loan', 'cash', 'other', 'fd', 'broker_funds')
);

alter table accounts add column brokerage_in_average boolean not null default false;
comment on column accounts.brokerage_in_average is
  'Broker funds only: whether this broker adds a buy''s brokerage into the holding''s average price. Brokers differ, and the app''s average has to match the broker''s.';

-- Units keep eight decimals, as a broker selling fractional shares shows
-- them: at four, selling a whole fractional holding read as selling more than
-- was held. The average keeps six, so repeated buys do not drift from the
-- broker's figure.
alter table holdings alter column quantity type numeric(20, 8);
alter table holdings alter column avg_price type numeric(18, 6);

alter table holdings add column funds_account_id uuid;
alter table holdings add constraint holdings_funds_account_fk
  foreign key (household_id, funds_account_id) references accounts (household_id, id);
create index holdings_funds_account_idx on holdings (household_id, funds_account_id);
comment on column holdings.funds_account_id is
  'The broker funds account a trade on this holding pays from or into, unless the trade names another.';

alter table holdings add column trades_version integer not null default 0;
comment on column holdings.trades_version is
  'Raised by every replay of the holding''s trades; 0 until the holding has an opening entry. A confirmation shown on an older version is refused.';

create table holding_trades (
  id uuid primary key default gen_random_uuid(),
  -- Deleted with the household directly, as transactions are, so a household's
  -- deletion removes its trades before it checks its accounts are unused.
  household_id uuid not null references households (id) on delete cascade,
  holding_id uuid not null,
  member_id uuid,
  kind text not null check (kind in ('opening', 'buy', 'sell', 'split')),
  trade_date date not null,
  traded_at timestamptz,
  units numeric(20, 8) not null check (units > 0),
  price numeric(18, 6) check (price is null or price >= 0),
  fees numeric(16, 4) not null default 0 check (fees >= 0),
  tax_withheld numeric(16, 4) not null default 0 check (tax_withheld >= 0),
  tax_to_confirm boolean not null default false,
  funds_account_id uuid,
  cash_amount numeric(16, 4) not null default 0,
  units_after numeric(20, 8),
  avg_after numeric(18, 6),
  realised numeric(16, 4),
  source text not null check (source in ('opening', 'bot', 'app', 'statement')),
  proposal_id uuid references bot_proposals (id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint holding_trades_holding_fk foreign key (household_id, holding_id)
    references holdings (household_id, id) on delete cascade,
  constraint holding_trades_member_fk foreign key (household_id, member_id)
    references household_members (household_id, id) on delete set null (member_id),
  -- No cascade: a fund that money moved through cannot be deleted under its trades.
  constraint holding_trades_funds_fk foreign key (household_id, funds_account_id)
    references accounts (household_id, id),
  -- A split is a ratio, not a price; everything else has a price.
  constraint holding_trades_price_by_kind check ((price is null) = (kind = 'split')),
  -- Money moves on a buy or a sale, and only through a fund.
  constraint holding_trades_fund_by_kind check ((funds_account_id is not null) = (kind in ('buy', 'sell'))),
  -- Tax is deducted from a sale's proceeds, never from anything else.
  constraint holding_trades_tax_on_sales check (kind = 'sell' or (tax_withheld = 0 and not tax_to_confirm))
);

-- One fresh start per holding.
create unique index holding_trades_one_opening on holding_trades (holding_id) where kind = 'opening';
-- One trade per bot confirmation, however often it is confirmed.
create unique index holding_trades_one_per_proposal on holding_trades (proposal_id) where proposal_id is not null;
-- The replay reads a holding's entries in this order.
create index holding_trades_replay_order on holding_trades (holding_id, trade_date, traded_at, created_at);
-- Every foreign key gets a full covering index, so removing a referenced row
-- never scans this table.
create index holding_trades_holding_idx on holding_trades (household_id, holding_id);
create index holding_trades_member_idx on holding_trades (household_id, member_id);
create index holding_trades_funds_idx on holding_trades (household_id, funds_account_id);
create index holding_trades_proposal_idx on holding_trades (proposal_id);

comment on table holding_trades is
  'Every entry in a holding''s record: its opening entry (the fresh start at the broker''s units and average), then each buy, sell and split. The holding''s units and average price are replayed from these. Written only by the trade functions; members read their household''s.';
comment on column holding_trades.units is 'Units bought, sold or opened with; for a split, the ratio (10 for 10-for-1, 2 for a 1:1 bonus).';
comment on column holding_trades.cash_amount is 'The money that moved through the fund, in its currency: negative on a buy (units × price + fees), positive on a sale (units × price − fees − tax). Zero on an opening or a split.';
comment on column holding_trades.traded_at is 'The moment of the trade when the broker''s confirmation shows it; it orders trades within a day and decides whether a fund''s confirmed balance already includes the trade.';
comment on column holding_trades.tax_to_confirm is 'An Indian sale saved before the broker''s statement was read: its tax is not yet the broker''s figure.';

-- The fund is in the holding's currency and still open. A dollar trade
-- through a rupee fund, or into a closed account, is refused here even if a
-- caller skips the trade functions' own check.
create or replace function private.check_trade_fund()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fund public.accounts%rowtype;
  v_currency text;
begin
  if new.funds_account_id is null then return new; end if;
  select * into v_fund from public.accounts where id = new.funds_account_id and household_id = new.household_id;
  select currency into v_currency from public.holdings where id = new.holding_id;
  if v_fund.currency is distinct from v_currency then
    raise exception 'a trade''s fund must be in the holding''s currency (% fund, % holding)', v_fund.currency, v_currency
      using errcode = 'check_violation';
  end if;
  if v_fund.archived_at is not null then
    raise exception 'a closed account takes no new trades' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger holding_trades_check_fund
  before insert or update of funds_account_id, holding_id on holding_trades
  for each row execute function private.check_trade_fund();

-- Once a holding has its opening entry, its units and average come only from
-- the replay of its trades. A hand edit would make the two disagree, so it is
-- refused unless the replay itself is writing (a transaction-local flag only
-- the trade functions set).
create or replace function private.guard_traded_units()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.trades_version > 0
     and (new.quantity is distinct from old.quantity or new.avg_price is distinct from old.avg_price)
     and coalesce(current_setting('rokda.trade_replay', true), '') <> 'on' then
    raise exception 'units and average price of a traded holding change only through its trades'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger holdings_guard_traded_units
  before update of quantity, avg_price on holdings
  for each row execute function private.guard_traded_units();

-- A holding with buys or sales is kept: deleting it would lose where its money
-- went. Its trades are deleted first (which reverses their money), or it stays
-- closed. One with only its opening entry, or a split, can go, and so does
-- everything when the household itself is deleted (its row is already gone
-- when the cascade reaches its holdings). Security definer, so a row hidden
-- from the caller by RLS is not mistaken for a household being deleted.
create or replace function private.guard_traded_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.households h where h.id = old.household_id) then
    return old;
  end if;
  if exists (select 1 from public.holding_trades t where t.holding_id = old.id and t.kind in ('buy', 'sell')) then
    raise exception 'a holding with buys or sales cannot be deleted; delete its trades first'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger holdings_guard_traded_delete
  before delete on holdings
  for each row execute function private.guard_traded_delete();

revoke execute on function private.check_trade_fund() from public, anon, authenticated;
revoke execute on function private.guard_traded_units() from public, anon, authenticated;
revoke execute on function private.guard_traded_delete() from public, anon, authenticated;

alter table holding_trades enable row level security;

-- Members read their household's trades. Nobody writes them through the API:
-- every change goes through the trade functions below, so the sums cannot be
-- skipped and a trade cannot be forged or edited outside them.
create policy "members can read trades" on holding_trades
  for select using (private.is_household_member(household_id));
revoke insert, update, delete on holding_trades from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The sums: one replay, which the preview and every save call
-- ---------------------------------------------------------------------------

-- Works out a holding's units, average price and each sale's profit from its
-- entries, in order: by trade date, the opening entry first on its day, then
-- by time where known, then in the order recorded. It reads no table, so a
-- preview and a save given the same entries give the same figures. A buy
-- re-averages; a sale keeps the average and records profit against it; a
-- split multiplies units and divides the average. It refuses an entry before
-- the opening, a holding with no opening, and selling more than was held at
-- that point.
create or replace function private.replay_entries(p_entries jsonb, p_brokerage_in_average boolean)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  e record;
  v_units numeric;
  v_avg numeric;
  v_realised numeric;
  v_opening_date date;
  v_openings int;
  v_out jsonb := '[]'::jsonb;
begin
  select count(*), min(x.trade_date) into v_openings, v_opening_date
  from jsonb_to_recordset(p_entries) as x(kind text, trade_date date)
  where x.kind = 'opening';
  if v_openings = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_opening');
  end if;
  if v_openings > 1 then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  for e in
    select x.id, x.kind, x.trade_date, x.units, x.price, coalesce(x.fees, 0) as fees
    from jsonb_to_recordset(p_entries)
      as x(id text, kind text, trade_date date, traded_at timestamptz, created_at timestamptz, units numeric, price numeric, fees numeric)
    order by x.trade_date, x.kind <> 'opening', x.traded_at nulls last, x.created_at nulls last, x.id
  loop
    if e.trade_date < v_opening_date then
      return jsonb_build_object('ok', false, 'error', 'before_opening', 'entry_id', e.id);
    end if;
    v_realised := null;
    if e.kind = 'opening' then
      v_units := e.units;
      v_avg := e.price;
    elsif e.kind = 'buy' then
      v_avg := (v_units * v_avg + e.units * e.price + case when p_brokerage_in_average then e.fees else 0 end) / (v_units + e.units);
      v_units := v_units + e.units;
    elsif e.kind = 'sell' then
      if e.units > v_units then
        return jsonb_build_object('ok', false, 'error', 'exceeds_units', 'entry_id', e.id);
      end if;
      v_realised := e.units * (e.price - v_avg) - e.fees;
      v_units := v_units - e.units;
    elsif e.kind = 'split' then
      v_units := v_units * e.units;
      v_avg := v_avg / e.units;
    else
      return jsonb_build_object('ok', false, 'error', 'bad_input', 'entry_id', e.id);
    end if;
    v_out := v_out || jsonb_build_object(
      'id', e.id,
      'units_after', round(v_units, 8),
      'avg_after', round(v_avg, 6),
      'realised', round(v_realised, 4));
  end loop;

  return jsonb_build_object('ok', true, 'units', round(v_units, 8), 'avg', round(v_avg, 6), 'entries', v_out);
end;
$$;

revoke execute on function private.replay_entries(jsonb, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Preview and record a trade, moving the fund and the value together
-- ---------------------------------------------------------------------------

-- The member acting: a signed-in member of the household, or, for the bot
-- (the service role), the member who confirmed. Null means not allowed.
create or replace function private.trade_caller(p_household_id uuid, p_member_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member uuid;
begin
  if auth.uid() is not null then
    if not private.is_household_member(p_household_id) then
      return null;
    end if;
    select m.id into v_member from public.household_members m
    where m.household_id = p_household_id and m.user_id = auth.uid();
    return v_member;
  end if;
  if auth.role() = 'service_role' and p_member_id is not null then
    select m.id into v_member from public.household_members m
    where m.household_id = p_household_id and m.id = p_member_id;
    return v_member;
  end if;
  return null;
end;
$$;

-- A holding's value in dirhams from its units and price, as the price feed
-- works it: the peg for dollars, the household's rate for rupees. Null when
-- the units, the price or a usable rate is missing, so a caller keeps the
-- value it had rather than writing a guess.
create or replace function private.holding_value_aed(p_holding public.holdings)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
    when p_holding.quantity is null or p_holding.current_price is null then null
    when p_holding.currency = 'AED' then round(p_holding.quantity * p_holding.current_price, 2)
    when p_holding.currency = 'USD' then round(p_holding.quantity * p_holding.current_price * 3.6725, 2)
    when p_holding.currency = 'INR' then (
      select round(p_holding.quantity * p_holding.current_price / h.inr_per_aed, 2)
      from public.households h where h.id = p_holding.household_id and h.inr_per_aed > 0)
  end;
$$;

-- Whether a trade moves its fund: not when the fund's balance was confirmed
-- after the trade happened, because the confirmed figure already includes
-- it. A trade with no time happened by the end of its day in Dubai.
create or replace function private.trade_moves_fund(p_balance_as_of timestamptz, p_trade_date date, p_traded_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_balance_as_of is null
      or coalesce(p_traded_at, (p_trade_date + 1)::timestamp at time zone 'Asia/Dubai') > p_balance_as_of;
$$;

-- A holding's entries as the replay takes them, leaving one out (the trade
-- being fixed or deleted).
create or replace function private.holding_entries(p_holding_id uuid, p_exclude_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'trade_date', t.trade_date, 'traded_at', t.traded_at,
    'created_at', t.created_at, 'units', t.units, 'price', t.price, 'fees', t.fees)), '[]'::jsonb)
  from public.holding_trades t
  where t.holding_id = p_holding_id and t.id is distinct from p_exclude_id;
$$;

-- Whether the holding's own fund puts brokerage into the average.
create or replace function private.holding_brokerage_in_average(p_holding public.holdings)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select a.brokerage_in_average from public.accounts a where a.id = p_holding.funds_account_id), false);
$$;

-- Writes a replay's figures: each entry's units, average and profit after it,
-- the holding's units and average (the only writer the guard lets through),
-- a new version, and the value and today's value point from the new units.
-- A holding sold to zero is worth nothing whatever its price.
create or replace function private.write_replay(p_holding_id uuid, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holding public.holdings%rowtype;
  v_value numeric;
begin
  update public.holding_trades t
  set units_after = (x ->> 'units_after')::numeric,
      avg_after = (x ->> 'avg_after')::numeric,
      realised = (x ->> 'realised')::numeric
  from jsonb_array_elements(p_result -> 'entries') x
  where t.holding_id = p_holding_id and t.id = (x ->> 'id')::uuid;

  perform set_config('rokda.trade_replay', 'on', true);
  update public.holdings
  set quantity = (p_result ->> 'units')::numeric,
      avg_price = (p_result ->> 'avg')::numeric,
      trades_version = trades_version + 1
  where id = p_holding_id
  returning * into v_holding;
  perform set_config('rokda.trade_replay', '', true);

  v_value := case when v_holding.quantity = 0 then 0 else private.holding_value_aed(v_holding) end;
  if v_value is not null then
    update public.holdings set value_aed = v_value where id = p_holding_id;
    insert into public.holding_value_history (holding_id, as_of, value_aed)
    values (p_holding_id, public.household_today(), v_value)
    on conflict (holding_id, as_of) do update set value_aed = excluded.value_aed;
  end if;
end;
$$;

-- What a trade would do, without saving it: checks, the replay, the money and
-- the warnings. The preview shows this, and record, fix and delete save
-- exactly this, so the two cannot disagree. p_replace_trade_id is the trade a
-- fix replaces; its money is reversed if it had moved its fund.
create or replace function private.trade_effect(
  p_holding public.holdings, p_kind text, p_trade_date date, p_units numeric, p_price numeric,
  p_fees numeric, p_tax_withheld numeric, p_traded_at timestamptz, p_funds_account_id uuid, p_replace_trade_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_fees numeric := coalesce(p_fees, 0);
  v_tax numeric := coalesce(p_tax_withheld, 0);
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
     or p_units is null or p_units <= 0 or v_fees < 0 or v_tax < 0
     or (p_kind = 'split') <> (p_price is null) or coalesce(p_price, 0) < 0
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

  if p_holding.trades_version = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_opening');
  end if;
  if p_holding.asset_class = 'india_equity' and p_kind <> 'split' and p_units <> trunc(p_units) then
    return jsonb_build_object('ok', false, 'error', 'whole_units_only');
  end if;

  if p_kind in ('buy', 'sell') then
    v_fund_id := coalesce(p_funds_account_id, p_holding.funds_account_id);
    if v_fund_id is null then
      return jsonb_build_object('ok', false, 'error', 'fund_required');
    end if;
    select * into v_fund from public.accounts where id = v_fund_id and household_id = p_holding.household_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'fund_required');
    end if;
    if v_fund.currency is distinct from p_holding.currency then
      return jsonb_build_object('ok', false, 'error', 'currency_mismatch');
    end if;
    if v_fund.archived_at is not null then
      return jsonb_build_object('ok', false, 'error', 'fund_archived');
    end if;
    v_cash := round(case when p_kind = 'buy' then -(p_units * p_price + v_fees) else p_units * p_price - v_fees - v_tax end, 4);
    v_moves := private.trade_moves_fund(v_fund.balance_as_of, p_trade_date, p_traded_at);
  end if;

  v_entries := private.holding_entries(p_holding.id, p_replace_trade_id) || jsonb_build_array(jsonb_build_object(
    'id', 'new', 'kind', p_kind, 'trade_date', p_trade_date, 'traded_at', p_traded_at,
    'created_at', coalesce(v_old.created_at, clock_timestamp()), 'units', p_units, 'price', p_price, 'fees', v_fees));
  v_result := private.replay_entries(v_entries, private.holding_brokerage_in_average(p_holding));
  if not (v_result ->> 'ok')::boolean then
    return v_result;
  end if;
  select x into v_new from jsonb_array_elements(v_result -> 'entries') x where x ->> 'id' = 'new';

  -- The money: the new trade's, less the replaced trade's where that had
  -- moved its fund. A different fund is reversed on its own.
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

  if p_kind in ('buy', 'sell') then
    if not v_moves then
      v_warnings := v_warnings || '"fund_confirmed_after"'::jsonb;
    end if;
    if v_fund.balance + v_delta < 0 then
      v_warnings := v_warnings || '"fund_below_zero"'::jsonb;
    end if;
    if p_holding.current_price > 0 and abs(p_price / p_holding.current_price - 1) > 0.20 then
      v_warnings := v_warnings || '"price_off_market"'::jsonb;
    end if;
    if exists (
      select 1 from public.holding_trades t
      where t.holding_id = p_holding.id and t.kind = p_kind and t.units = p_units and t.price = p_price
        and abs(t.trade_date - p_trade_date) <= 2 and t.id is distinct from p_replace_trade_id
    ) then
      v_warnings := v_warnings || '"possible_duplicate"'::jsonb;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
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

-- Moves a fund by a trade's money, recorded in its balance history as the
-- bot's or the app's change, by the member who made it.
create or replace function private.move_fund(p_fund_id uuid, p_delta numeric, p_source text, p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_fund_id is null or p_delta is null or p_delta = 0 then
    return;
  end if;
  perform set_config('rokda.balance_source', case when p_source = 'app' then 'app' else 'bot' end, true);
  perform set_config('rokda.balance_member', p_member_id::text, true);
  update public.accounts set balance = balance + p_delta where id = p_fund_id;
  perform set_config('rokda.balance_source', '', true);
  perform set_config('rokda.balance_member', '', true);
end;
$$;

create or replace function public.preview_trade(
  p_holding_id uuid, p_kind text, p_trade_date date, p_units numeric, p_price numeric,
  p_fees numeric default 0, p_tax_withheld numeric default 0, p_traded_at timestamptz default null,
  p_funds_account_id uuid default null, p_replace_trade_id uuid default null, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holding public.holdings%rowtype;
begin
  select * into v_holding from public.holdings where id = p_holding_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'holding_not_found');
  end if;
  if private.trade_caller(v_holding.household_id, p_member_id) is null then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  return private.trade_effect(v_holding, p_kind, p_trade_date, p_units, p_price, p_fees, p_tax_withheld,
    p_traded_at, p_funds_account_id, p_replace_trade_id);
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
    p_traded_at, p_units, p_price, coalesce(p_fees, 0), coalesce(p_tax_withheld, 0), coalesce(p_tax_to_confirm, false),
    (v_effect ->> 'funds_account_id')::uuid, (v_effect ->> 'cash_amount')::numeric, p_source, p_proposal_id,
    p_note, v_member, clock_timestamp())
  returning id into v_trade;

  perform private.write_replay(v_holding.id,
    private.replay_entries(private.holding_entries(v_holding.id, null), private.holding_brokerage_in_average(v_holding)));
  perform private.move_fund((v_effect ->> 'funds_account_id')::uuid, (v_effect ->> 'funds_delta')::numeric, p_source, v_member);

  return v_effect || jsonb_build_object('trade_id', v_trade, 'trades_version', v_holding.trades_version + 1);
end;
$$;

revoke execute on function private.trade_caller(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.holding_value_aed(public.holdings) from public, anon, authenticated;
revoke execute on function private.trade_moves_fund(timestamptz, date, timestamptz) from public, anon, authenticated;
revoke execute on function private.holding_entries(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.holding_brokerage_in_average(public.holdings) from public, anon, authenticated;
revoke execute on function private.write_replay(uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.trade_effect(public.holdings, text, date, numeric, numeric, numeric, numeric, timestamptz, uuid, uuid) from public, anon, authenticated;
revoke execute on function private.move_fund(uuid, numeric, text, uuid) from public, anon, authenticated;
revoke execute on function public.preview_trade(uuid, text, date, numeric, numeric, numeric, numeric, timestamptz, uuid, uuid, uuid) from public, anon;
revoke execute on function public.record_trade(uuid, text, date, numeric, numeric, numeric, numeric, timestamptz, uuid, text, uuid, uuid, integer, boolean, text) from public, anon;
grant execute on function public.preview_trade(uuid, text, date, numeric, numeric, numeric, numeric, timestamptz, uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.record_trade(uuid, text, date, numeric, numeric, numeric, numeric, timestamptz, uuid, text, uuid, uuid, integer, boolean, text) to authenticated, service_role;
