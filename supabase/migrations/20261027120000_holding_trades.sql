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
  household_id uuid not null,
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
-- closed. One with only its opening entry, or a split, can go.
create or replace function private.guard_traded_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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
    order by x.trade_date, x.kind <> 'opening', x.traded_at nulls last, x.created_at nulls last
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
