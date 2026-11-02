-- Dividends (SHR-366), PR 1: the records and the feed.
--
-- Design: docs/superpowers/specs/2026-11-02-dividends-design.md. A dividend
-- is its own record, not an income transaction: recorded income feeds the
-- Life plan's saving, and the plan's return already includes dividends.
-- What the feeds say each share pays is reference data, the same for every
-- household (dividend_events, dividend_splits). What a household earned and
-- received is its own (holding_dividends), written only by the functions in
-- this file and, in PR 2, by the receipt functions.

-- ---------------------------------------------------------------------------
-- 1. What the feeds say
-- ---------------------------------------------------------------------------

-- One row per share per ex-date. `amount` is per share on the share basis of
-- the ex-date: a source that adjusts past amounts for later splits gives a
-- smaller figure after a split, so the figure it gave is kept as
-- `source_amount` and multiplied back by the splits it had applied
-- (`source_factor`). A moved ex-date arrives as a new event; the old one is
-- kept, no longer listed, and marked as superseded once a holding's dividend
-- has moved to its replacement.
create table dividend_events (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  ex_date date not null,
  amount numeric(18,6) not null check (amount >= 0),
  source_amount numeric(18,6) not null check (source_amount >= 0),
  source_factor numeric(18,8) not null default 1 check (source_factor > 0),
  source_fetched_on date,
  currency text not null,
  pay_date date,
  record_date date,
  declared_on date,
  source text not null check (source in ('alphavantage', 'yahoo')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  superseded_by uuid references dividend_events (id),
  -- Successful checks in a row that have not listed it. One incomplete answer
  -- changes nothing; only two in a row count as the source dropping it.
  missed_checks integer not null default 0 check (missed_checks >= 0),
  unique (symbol, ex_date)
);

comment on table dividend_events is
  'Each share''s dividends as the feeds give them, with amount on the share basis of the ex-date. Reference data: read by every member, written only by the feed.';

-- The market's splits for each share (a bonus issue is a split), used only to
-- put the feeds' amounts back on their ex-date's basis. A holding's own split
-- trades are what its units follow.
create table dividend_splits (
  symbol text not null,
  effective_date date not null,
  ratio numeric(18,8) not null check (ratio > 0),
  source text not null check (source in ('alphavantage', 'yahoo')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (symbol, effective_date)
);

-- What the feed last checked, per share and kind. An event is listed when the
-- latest successful dividends check of its share listed it: every check reads
-- the share's whole history, so "not listed" means the source no longer has it.
create table dividend_feed_state (
  symbol text not null,
  provider text not null check (provider in ('alphavantage', 'yahoo')),
  kind text not null check (kind in ('dividends', 'splits')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  fail_count integer not null default 0 check (fail_count >= 0),
  last_error text,
  covered_from date,
  needs_splits boolean not null default false,
  primary key (symbol, provider, kind)
);

-- ---------------------------------------------------------------------------
-- 2. What a household earned and received
-- ---------------------------------------------------------------------------

-- A member's answer about how much of one event was a one-off: sources combine
-- an ordinary and a special dividend paid on the same day into one amount.
-- It matters only to projections, which the app works out.
create table dividend_special_parts (
  household_id uuid not null references households (id) on delete cascade,
  event_id uuid not null references dividend_events (id),
  special_per_share numeric(18,6) not null check (special_per_share >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (household_id, event_id)
);

-- One row per holding per dividend. Expected figures are worked out from the
-- units held on the ex-date, the amount per share, the holding's withholding
-- rate and its fee per share; received figures come only from evidence (a
-- member's confirmation or a company's credit intimation). Dirham figures
-- are not stored: the app converts when it reads, as "Profit on sales" does.
-- A receipt's effect on its fund is not stored either: it is worked out from
-- the receipt and the fund's current confirmation, as a trade's is.
create table holding_dividends (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  holding_id uuid not null,
  event_id uuid references dividend_events (id),
  ex_date date,
  record_date date,
  pay_date date,
  currency text not null,
  units numeric(20,8) not null check (units > 0),
  units_basis text not null check (units_basis in ('trades', 'stated')),
  per_share numeric(18,6) not null check (per_share >= 0),
  tax_pct numeric(5,2) check (tax_pct between 0 and 100),
  expected_gross numeric(16,4) not null,
  expected_tax numeric(16,4) not null,
  expected_fees numeric(16,4) not null default 0,
  expected_net numeric(16,4) not null,
  received_gross numeric(16,4),
  received_tax numeric(16,4),
  received_fees numeric(16,4),
  received_net numeric(16,4),
  status text not null default 'earned' check (status in ('earned', 'received', 'presumed', 'skipped')),
  evidence text check (evidence in ('member', 'intimation')),
  credited_on date,
  credited_on_estimated boolean not null default false,
  paid_into_account_id uuid,
  review_reason text check (review_reason in ('trades_changed', 'feed_changed', 'split_on_ex_date', 'possible_duplicate', 'moved_ex_date')),
  review_event_id uuid references dividend_events (id),
  review_baseline jsonb,
  fixed boolean not null default false,
  source text not null check (source in ('feed', 'app', 'bot', 'import')),
  import_ref text,
  -- Not unique: one "yes" to the bot can receive several dividends. That a
  -- proposal is applied once is kept on the proposal itself.
  proposal_id uuid references bot_proposals (id) on delete set null,
  version integer not null default 1,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  foreign key (household_id, holding_id) references holdings (household_id, id) on delete cascade,
  -- Deleting a household deletes its dividends first, so the destination
  -- below never holds the household's own deletion up.
  foreign key (household_id) references households (id) on delete cascade,
  -- The destination belongs to the household; no cascade, so an account a
  -- dividend landed in cannot be deleted from under it.
  foreign key (household_id, paid_into_account_id) references accounts (household_id, id),
  constraint holding_dividends_expected_adds_up check (
    expected_gross >= 0 and expected_tax >= 0 and expected_fees >= 0
    and expected_tax + expected_fees <= expected_gross
    and expected_net = expected_gross - expected_tax - expected_fees),
  constraint holding_dividends_received_adds_up check (
    (received_gross is null and received_tax is null and received_fees is null and received_net is null)
    or (received_gross >= 0 and received_tax >= 0 and received_fees >= 0
        and received_tax + received_fees <= received_gross
        and received_net = received_gross - received_tax - received_fees)),
  constraint holding_dividends_received_only_when_received check (
    (received_gross is not null) = (status = 'received') and (evidence is not null) = (status = 'received')),
  constraint holding_dividends_credited_when_paid check (
    (credited_on is not null) = (status in ('received', 'presumed')))
);

create unique index holding_dividends_one_per_event on holding_dividends (holding_id, event_id) where event_id is not null;
create unique index holding_dividends_one_per_ex_date on holding_dividends (holding_id, ex_date) where ex_date is not null;
create unique index holding_dividends_one_per_import on holding_dividends (household_id, import_ref) where import_ref is not null;
-- Every foreign key has an index led by its own columns, so removing a
-- referenced row never scans this table (a partial index does not count).
create index holding_dividends_holding on holding_dividends (household_id, holding_id);
create index holding_dividends_event on holding_dividends (event_id);
create index holding_dividends_review_event on holding_dividends (review_event_id);
create index holding_dividends_proposal on holding_dividends (proposal_id);
create index holding_dividends_paid_into on holding_dividends (household_id, paid_into_account_id);
create index dividend_events_superseded_by on dividend_events (superseded_by);
create index dividend_special_parts_event on dividend_special_parts (event_id);

create trigger holding_dividends_touch_updated_at before update on holding_dividends for each row execute function touch_updated_at();
create trigger dividend_special_parts_touch_updated_at before update on dividend_special_parts for each row execute function touch_updated_at();

comment on table holding_dividends is
  'What each holding earned (ex-date passed with units held) and received, with expected and received figures kept apart. Written only by the dividend functions.';

-- ---------------------------------------------------------------------------
-- 3. Withholding per holding, and where a broker fund's dividends land
-- ---------------------------------------------------------------------------

-- A default, not a fact: 30% on a US share at the household's dollar broker
-- (no US-UAE treaty), 20.8% on an Indian share held as a non-resident without
-- a Tax Residency Certificate (20% plus 4% cess). A US-listed share of a
-- foreign company is withheld by its home country, so the rate is the
-- holding's own and editable.
alter table holdings add column dividend_tax_pct numeric(5,2) check (dividend_tax_pct between 0 and 100);
alter table holdings add column dividend_fee_per_share numeric(18,6) not null default 0 check (dividend_fee_per_share >= 0);

create or replace function private.default_dividend_tax_pct(p_asset_class text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_asset_class = 'india_equity' then 20.8
    when p_asset_class in ('us_equity', 'intl_equity') then 30
  end;
$$;

-- Security definer: a member's own holding insert fires it, and the helper it
-- calls lives in the private schema members cannot call into.
create or replace function private.default_dividend_tax()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.dividend_tax_pct is null then
    new.dividend_tax_pct := private.default_dividend_tax_pct(new.asset_class);
  end if;
  return new;
end;
$$;

-- On a class change too: a holding that becomes a share takes its class's
-- rate when it has none, rather than having nothing withheld.
create trigger holdings_default_dividend_tax
  before insert or update of asset_class on holdings
  for each row execute function private.default_dividend_tax();

update holdings set dividend_tax_pct = private.default_dividend_tax_pct(asset_class) where dividend_tax_pct is null;

-- Where a broker fund's holdings are paid their dividends. Null means the fund
-- itself (the dollar broker credits its cash); the rupee broker's fund names
-- the bank account linked to the demat account, which Indian companies pay.
-- A deleted destination falls back to the fund.
alter table accounts add column dividends_into_account_id uuid;
alter table accounts add constraint accounts_dividends_into_fkey
  foreign key (household_id, dividends_into_account_id) references accounts (household_id, id)
  on delete set null (dividends_into_account_id);
create index accounts_dividends_into on accounts (household_id, dividends_into_account_id);

create or replace function private.check_dividends_into()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_target public.accounts%rowtype;
begin
  -- Only a change to the destination, or to what it must match, is checked:
  -- an archived destination must not stop the fund's balance moving, its
  -- editor saving, or its trades. Its dividends then land in the fund
  -- itself (private.dividend_destination).
  if new.dividends_into_account_id is null or (tg_op = 'UPDATE'
     and new.dividends_into_account_id is not distinct from old.dividends_into_account_id
     and new.type is not distinct from old.type and new.currency is not distinct from old.currency
     and new.household_id is not distinct from old.household_id) then
    return new;
  end if;
  if new.type <> 'broker_funds' then
    raise exception 'only a broker fund names where its dividends are paid' using errcode = 'check_violation';
  end if;
  if new.dividends_into_account_id = new.id then
    raise exception 'a fund''s own dividends are named by leaving the destination empty' using errcode = 'check_violation';
  end if;
  select * into v_target from public.accounts where id = new.dividends_into_account_id;
  if not found or v_target.household_id <> new.household_id or v_target.currency <> new.currency or v_target.archived_at is not null then
    raise exception 'dividends are paid into an open account of the fund''s household and currency' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger accounts_check_dividends_into
  before insert or update on accounts
  for each row execute function private.check_dividends_into();

-- A dividend is in its holding's currency and lands only in an account of
-- that currency; converting one into another currency is out of scope.
create or replace function private.check_dividend_destination()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.currency is distinct from (select h.currency from public.holdings h where h.id = new.holding_id) then
    raise exception 'a dividend is in its holding''s currency' using errcode = 'check_violation';
  end if;
  if new.paid_into_account_id is not null
     and new.currency is distinct from (select a.currency from public.accounts a where a.id = new.paid_into_account_id) then
    raise exception 'a dividend lands only in an account of its currency' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger holding_dividends_check_destination
  before insert or update on holding_dividends
  for each row execute function private.check_dividend_destination();

-- A one-off part is between nothing and the whole of the event's amount.
create or replace function private.check_special_part()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.special_per_share > (select e.amount from public.dividend_events e where e.id = new.event_id) then
    raise exception 'a one-off part is at most the dividend itself' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger dividend_special_parts_check
  before insert or update on dividend_special_parts
  for each row execute function private.check_special_part();

revoke execute on function private.default_dividend_tax_pct(text) from public, anon, authenticated;
revoke execute on function private.default_dividend_tax() from public, anon, authenticated;
revoke execute on function private.check_dividends_into() from public, anon, authenticated;
revoke execute on function private.check_dividend_destination() from public, anon, authenticated;
revoke execute on function private.check_special_part() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Who reads what
-- ---------------------------------------------------------------------------

-- The feeds' data is public market data, read by every member; the feed's own
-- bookkeeping by nobody signed in. A household's dividends and one-off answers
-- are read by its members. Nobody writes any of it through the API.
alter table dividend_events enable row level security;
alter table dividend_splits enable row level security;
alter table dividend_feed_state enable row level security;
alter table dividend_special_parts enable row level security;
alter table holding_dividends enable row level security;

create policy "members can read dividend events" on dividend_events
  for select to authenticated using (true);
create policy "members can read splits" on dividend_splits
  for select to authenticated using (true);
create policy "members can read their one-off answers" on dividend_special_parts
  for select using (private.is_household_member(household_id));
create policy "members can read their dividends" on holding_dividends
  for select using (private.is_household_member(household_id));

revoke insert, update, delete on dividend_events, dividend_splits, dividend_feed_state, dividend_special_parts, holding_dividends
  from anon, authenticated;
revoke select on dividend_feed_state from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Recording what the feeds return
-- ---------------------------------------------------------------------------

-- Whether a source gives past amounts adjusted for the splits after them.
-- Yahoo does (a share that split 10:1 shows a tenth of its earlier dividend);
-- Alpha Vantage gives each dividend as it was paid (checked against a share
-- that split 10:1 in June 2024: its March 2024 dividend reads as paid).
create or replace function private.source_adjusts_for_splits(p_source text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_source = 'yahoo';
$$;

-- The product of the ratios of a share's splits after an ex-date and before a
-- day: the splits a source had applied to an amount it gave that day.
create or replace function private.split_factor_after(p_symbol text, p_ex_date date, p_before date)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_factor numeric := 1;
  v_ratio numeric;
begin
  for v_ratio in
    select s.ratio from public.dividend_splits s
    where s.symbol = p_symbol and s.effective_date > p_ex_date and s.effective_date < coalesce(p_before, 'infinity'::date)
  loop
    v_factor := v_factor * v_ratio;
  end loop;
  return round(v_factor, 8);
end;
$$;

-- Puts every event of a share back on its ex-date's basis from the splits
-- known now. Run after any splits or dividends are recorded, so a split
-- learnt of after the source applied it is applied as soon as it is known,
-- and one the source had not yet applied never is.
create or replace function private.recompute_event_amounts(p_symbol text)
returns void
language sql
set search_path = ''
as $$
  update public.dividend_events e
  set source_factor = x.factor, amount = round(e.source_amount * x.factor, 6)
  from (
    select ev.id,
      case when private.source_adjusts_for_splits(ev.source)
        then private.split_factor_after(ev.symbol, ev.ex_date, ev.source_fetched_on) else 1 end as factor
    from public.dividend_events ev
    where ev.symbol = p_symbol
  ) x
  where e.id = x.id and (e.source_factor is distinct from x.factor or e.amount is distinct from round(e.source_amount * x.factor, 6));
$$;

-- Records one check of one share: what it listed, or that it failed. Every
-- check reads the share's whole history, so a successful one marks each
-- event it lists as seen at the same moment it records the success: an event
-- is listed exactly when its last sighting is its share's last success. A
-- failure, or a response that does not read as a list, changes no event.
-- `p_now` exists for tests; the feed passes nothing. Service role only.
create or replace function public.record_dividend_fetch(
  p_symbol text, p_provider text, p_kind text, p_result jsonb, p_now timestamptz default clock_timestamp())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb := p_result -> 'items';
  v_item jsonb;
  v_today date := (p_now at time zone 'Asia/Dubai')::date;
  v_currency text;
  v_old public.dividend_events%rowtype;
  v_changed integer := 0;
  v_valid boolean := true;
begin
  if p_symbol is null or btrim(p_symbol) = '' or p_provider not in ('yahoo', 'alphavantage') or p_kind not in ('dividends', 'splits') then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  insert into public.dividend_feed_state (symbol, provider, kind) values (p_symbol, p_provider, p_kind)
  on conflict (symbol, provider, kind) do nothing;
  perform 1 from public.dividend_feed_state
  where symbol = p_symbol and provider = p_provider and kind = p_kind for update;

  -- Every item must read before anything is written: a list half-read would
  -- unlist the events it failed on.
  if not coalesce((p_result ->> 'ok')::boolean, false) or jsonb_typeof(v_items) is distinct from 'array' then
    v_valid := false;
  else
    begin
      for v_item in select * from jsonb_array_elements(v_items) loop
        if p_kind = 'dividends' then
          if (v_item ->> 'ex_date')::date is null or (v_item ->> 'amount')::numeric is null or (v_item ->> 'amount')::numeric < 0 then
            v_valid := false;
          end if;
          perform (v_item ->> 'pay_date')::date, (v_item ->> 'record_date')::date, (v_item ->> 'declared_on')::date;
        else
          if (v_item ->> 'effective_date')::date is null or not ((v_item ->> 'ratio')::numeric > 0) then
            v_valid := false;
          end if;
        end if;
      end loop;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
      v_valid := false;
    end;
    -- A source that suddenly lists no dividends for a share it listed some
    -- for has failed to answer, not told us the share never paid.
    if v_valid and p_kind = 'dividends' and jsonb_array_length(v_items) = 0 and exists (
      select 1 from public.dividend_events e
      join public.dividend_feed_state st on st.symbol = e.symbol and st.provider = p_provider and st.kind = 'dividends'
      where e.symbol = p_symbol and e.last_seen_at = st.last_success_at) then
      v_valid := false;
      p_result := jsonb_set(p_result, '{error}', '"the source listed no dividends for a share it had listed some for"');
    end if;
  end if;

  if not v_valid then
    update public.dividend_feed_state
    set last_attempt_at = p_now, last_failure_at = p_now, fail_count = fail_count + 1,
        last_error = left(coalesce(p_result ->> 'error', 'the response did not read as a list'), 500)
    where symbol = p_symbol and provider = p_provider and kind = p_kind;
    return jsonb_build_object('ok', true, 'failed', true, 'listed', 0, 'changed_past', 0);
  end if;

  if p_kind = 'splits' then
    -- Two splits on one date are one split of both ratios.
    insert into public.dividend_splits (symbol, effective_date, ratio, source, first_seen_at, last_seen_at)
    select p_symbol, x.effective_date, round(exp(sum(ln(x.ratio)))::numeric, 8), p_provider, p_now, p_now
    from (select (i ->> 'effective_date')::date as effective_date, (i ->> 'ratio')::numeric as ratio from jsonb_array_elements(v_items) i) x
    group by x.effective_date
    on conflict (symbol, effective_date) do update set ratio = excluded.ratio, source = excluded.source, last_seen_at = excluded.last_seen_at;
    -- A splits check answers the question a changed past amount raised.
    update public.dividend_feed_state set needs_splits = false
    where symbol = p_symbol and provider = p_provider and kind = 'dividends';
  else
    -- The currency the source states, else the share's own.
    v_currency := coalesce(
      (select h.currency from public.holdings h where h.price_symbol = p_symbol order by h.created_at, h.id limit 1),
      case when p_provider = 'alphavantage' then 'USD' else 'INR' end);
    -- Two dividends on one ex-date (a regular and a supplemental one) are one
    -- dividend of both amounts.
    v_items := (
      select coalesce(jsonb_agg(jsonb_build_object(
        'ex_date', g.ex_date, 'amount', g.amount, 'currency', g.currency,
        'pay_date', g.pay_date, 'record_date', g.record_date, 'declared_on', g.declared_on) order by g.ex_date), '[]'::jsonb)
      from (
        select (i ->> 'ex_date')::date as ex_date, sum((i ->> 'amount')::numeric) as amount,
          max(nullif(i ->> 'currency', '')) as currency, max((i ->> 'pay_date')::date) as pay_date,
          max((i ->> 'record_date')::date) as record_date, max((i ->> 'declared_on')::date) as declared_on
        from jsonb_array_elements(v_items) i
        group by (i ->> 'ex_date')::date
      ) g);
    for v_item in select * from jsonb_array_elements(v_items) loop
      select * into v_old from public.dividend_events where symbol = p_symbol and ex_date = (v_item ->> 'ex_date')::date;
      if found and v_old.source_amount <> (v_item ->> 'amount')::numeric and v_old.ex_date < v_today then
        v_changed := v_changed + 1;
      end if;
      insert into public.dividend_events (
        symbol, ex_date, amount, source_amount, source_factor, source_fetched_on, currency,
        pay_date, record_date, declared_on, source, first_seen_at, last_seen_at)
      values (
        p_symbol, (v_item ->> 'ex_date')::date, (v_item ->> 'amount')::numeric, (v_item ->> 'amount')::numeric, 1, v_today,
        coalesce(nullif(v_item ->> 'currency', ''), v_currency),
        (v_item ->> 'pay_date')::date, (v_item ->> 'record_date')::date, (v_item ->> 'declared_on')::date, p_provider, p_now, p_now)
      on conflict (symbol, ex_date) do update set
        source_amount = excluded.source_amount,
        source_fetched_on = excluded.source_fetched_on,
        currency = excluded.currency,
        -- A date the source once gave is not forgotten when a later answer omits it.
        pay_date = coalesce(excluded.pay_date, dividend_events.pay_date),
        record_date = coalesce(excluded.record_date, dividend_events.record_date),
        declared_on = coalesce(excluded.declared_on, dividend_events.declared_on),
        source = excluded.source,
        last_seen_at = excluded.last_seen_at,
        -- Listed again: whatever replaced it did not, after all.
        missed_checks = 0,
        superseded_by = null;
    end loop;
    update public.dividend_events set missed_checks = missed_checks + 1
    where symbol = p_symbol and last_seen_at <> p_now;
  end if;

  update public.dividend_feed_state
  set last_attempt_at = p_now, last_success_at = p_now, fail_count = 0, last_error = null,
      covered_from = (p_result ->> 'covered_from')::date,
      needs_splits = case when p_kind = 'dividends' and p_provider = 'alphavantage' and v_changed > 0 then true else needs_splits end
  where symbol = p_symbol and provider = p_provider and kind = p_kind;

  perform private.recompute_event_amounts(p_symbol);
  return jsonb_build_object('ok', true, 'listed', jsonb_array_length(v_items), 'changed_past', v_changed);
end;
$$;

-- The shares the feed follows, with what it needs to plan the run: held now,
-- with a dividend still owed, or sold within the last year (checked weekly,
-- so a dividend found late is still earned). Indian shares come from Yahoo,
-- US-listed ones from Alpha Vantage; nothing else pays a dividend the feeds
-- know about. Service role only.
create or replace function public.dividend_symbols()
returns table (
  symbol text, provider text, held boolean,
  dividends_last_success_at timestamptz, splits_last_success_at timestamptz,
  ex_passed_since_success boolean, needs_splits boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with h as (
    select h.price_symbol as symbol,
      case
        when h.asset_class = 'india_equity' and h.price_provider = 'yahoo' then 'yahoo'
        when h.asset_class in ('us_equity', 'intl_equity') and h.currency = 'USD' then 'alphavantage'
      end as provider,
      coalesce(h.quantity, 0) > 0 as held_now,
      exists (select 1 from public.holding_dividends d where d.holding_id = h.id and d.status = 'earned') as owed,
      (select max(t.trade_date) from public.holding_trades t where t.holding_id = h.id and t.kind = 'sell') as last_sale
    from public.holdings h
    where h.price_symbol is not null and btrim(h.price_symbol) <> ''
  ), followed as (
    select h.symbol, h.provider, bool_or(h.held_now) as held
    from h
    where h.provider is not null and (h.held_now or h.owed or h.last_sale >= public.household_today() - 365)
    group by h.symbol, h.provider
  )
  select f.symbol, f.provider, f.held,
    d.last_success_at, s.last_success_at,
    exists (
      select 1 from public.dividend_events e
      where e.symbol = f.symbol and e.last_seen_at = d.last_success_at
        and e.ex_date > (d.last_success_at at time zone 'Asia/Dubai')::date and e.ex_date <= public.household_today()),
    coalesce(d.needs_splits, false)
  from followed f
  left join public.dividend_feed_state d on d.symbol = f.symbol and d.provider = f.provider and d.kind = 'dividends'
  left join public.dividend_feed_state s on s.symbol = f.symbol and s.provider = f.provider and s.kind = 'splits'
  order by f.symbol;
$$;

revoke execute on function private.source_adjusts_for_splits(text) from public, anon, authenticated;
revoke execute on function private.split_factor_after(text, date, date) from public, anon, authenticated;
revoke execute on function private.recompute_event_amounts(text) from public, anon, authenticated;
revoke execute on function public.record_dividend_fetch(text, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.dividend_symbols() from public, anon, authenticated;
grant execute on function public.record_dividend_fetch(text, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.dividend_symbols() to service_role;

-- ---------------------------------------------------------------------------
-- 6. Earning: what each holding was entitled to on each ex-date
-- ---------------------------------------------------------------------------

-- The units a holding held on an ex-date: its opening entry (the units at the
-- start of its date) and every entry of a market day before the ex-date,
-- replayed as the trades replay them. A trade's market day is its time in the
-- exchange's zone where known: a US trade confirmed after midnight in Dubai
-- belongs to the day before in New York. A buyer on the ex-date itself is not
-- paid. Null when the holding has no opening entry on or before the ex-date,
-- since its units before then are unknown.
create or replace function private.units_on_ex_date(p_holding_id uuid, p_ex_date date)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_zone text;
  v_opening date;
  v_entries jsonb;
  v_result jsonb;
begin
  select case when h.currency = 'USD' then 'America/New_York' else 'Asia/Kolkata' end into v_zone
  from public.holdings h where h.id = p_holding_id;
  if v_zone is null then
    return null;
  end if;
  select min(t.trade_date) into v_opening from public.holding_trades t where t.holding_id = p_holding_id and t.kind = 'opening';
  if v_opening is null or v_opening > p_ex_date then
    return null;
  end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_entries
  from jsonb_array_elements(private.holding_entries(p_holding_id, null)) x
  where x ->> 'kind' = 'opening'
     or coalesce(((x ->> 'traded_at')::timestamptz at time zone v_zone)::date, (x ->> 'trade_date')::date) < p_ex_date;
  v_result := private.replay_entries(v_entries, false);
  if not coalesce((v_result ->> 'ok')::boolean, false) then
    return null;
  end if;
  return (v_result ->> 'units')::numeric;
end;
$$;

-- What a dividend should pay: gross at the amount per share, withholding at
-- the holding's rate, its fee per share (never more than what is left), net.
create or replace function private.dividend_expected(p_units numeric, p_per_share numeric, p_tax_pct numeric, p_fee_per_share numeric)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_gross numeric := round(p_units * p_per_share, 4);
  v_tax numeric := round(v_gross * coalesce(p_tax_pct, 0) / 100, 4);
  v_fees numeric := least(round(p_units * coalesce(p_fee_per_share, 0), 4), v_gross - v_tax);
begin
  return jsonb_build_object('gross', v_gross, 'tax', v_tax, 'fees', v_fees, 'net', v_gross - v_tax - v_fees);
end;
$$;

-- Where a holding's dividends land: what its fund names, else the fund,
-- and the fund too once the account it names has been closed.
create or replace function private.dividend_destination(p_holding public.holdings)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case when t.id is not null and t.archived_at is null then t.id else a.id end
  from public.accounts a
  left join public.accounts t on t.id = a.dividends_into_account_id
  where a.id = p_holding.funds_account_id;
$$;

-- The feed's provider for a holding, as dividend_symbols decides it.
create or replace function private.dividend_provider(p_holding public.holdings)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_holding.asset_class = 'india_equity' and p_holding.price_provider = 'yahoo' then 'yahoo'
    when p_holding.asset_class in ('us_equity', 'intl_equity') and p_holding.currency = 'USD' then 'alphavantage'
  end;
$$;

-- Decides, once per share and before any holding is locked, which dropped
-- events were replaced by a moved ex-date. An event that two successful
-- checks in a row have not listed, and that a holding has a dividend on, is
-- replaced by the one listed event of its share within 15 days of it, when
-- there is exactly one; otherwise nothing is decided and the dividends on it
-- are asked about. It writes only reference data, so it takes no holding
-- lock and cannot wait on a trade. The service role runs it, through
-- earn_dividends.
create or replace function private.supersede_moved_events()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.dividend_events%rowtype;
  v_next uuid;
  v_count integer := 0;
begin
  for a in
    select e.* from public.dividend_events e
    where e.missed_checks >= 2 and e.superseded_by is null
      and exists (select 1 from public.holding_dividends d where d.event_id = e.id)
    order by e.symbol, e.ex_date
  loop
    select case when count(*) = 1 then min(x.id::text)::uuid end into v_next
    from public.dividend_events x
    where x.symbol = a.symbol and x.id <> a.id and x.superseded_by is null and x.missed_checks = 0
      and abs(x.ex_date - a.ex_date) <= 15;
    if v_next is not null then
      update public.dividend_events set superseded_by = v_next where id = a.id;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- Makes, re-works and flags one holding's dividends with an ex-date on or
-- after p_from (all of them when null). It must run with the holding's row
-- lock held, and writes only this holding's dividends: every writer locks the
-- holding first, then its dividends, then funds, so no two writers wait on
-- each other.
--
-- An earned row nobody has fixed follows what it was worked out from (the
-- units, the feed's amount and dates, the holding's rate and fee, the fund's
-- destination). A received, presumed or fixed row keeps its figures, and a
-- change under it is flagged for a member, unless it matches what a member
-- last kept (review_baseline). A flag is raised only on a row that has none,
-- so two causes never take turns. Nothing changes, and no version moves, when
-- nothing differs, so running it again is a no-op.
create or replace function private.sync_holding_dividends(p_holding_id uuid, p_from date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h public.holdings%rowtype;
  v_provider text;
  v_state public.dividend_feed_state%rowtype;
  v_today date := public.household_today();
  v_from date := coalesce(p_from, '-infinity'::date);
  v_dest uuid;
  e public.dividend_events%rowtype;
  r public.holding_dividends%rowtype;
  v_units numeric;
  v_exp jsonb;
  v_made integer := 0;
  v_updated integer := 0;
  v_removed integer := 0;
  v_flagged integer := 0;
  v_presumed integer := 0;
  v_split_on_ex boolean;
begin
  select * into v_h from public.holdings where id = p_holding_id;
  if not found or v_h.price_symbol is null then
    return jsonb_build_object('made', 0, 'updated', 0, 'removed', 0, 'flagged', 0, 'presumed', 0);
  end if;
  v_provider := private.dividend_provider(v_h);
  if v_provider is null then
    return jsonb_build_object('made', 0, 'updated', 0, 'removed', 0, 'flagged', 0, 'presumed', 0);
  end if;
  select * into v_state from public.dividend_feed_state s
  where s.symbol = v_h.price_symbol and s.provider = v_provider and s.kind = 'dividends';
  v_dest := private.dividend_destination(v_h);

  -- 1. Dividends on an event the source has dropped (two checks in a row) or
  -- that a moved ex-date replaced. An earned one nobody fixed moves to the
  -- replacement (or goes, if no units were held then or its date has not
  -- passed), unless this holding already has a dividend on the replacement's
  -- date. Every other one, and every one with no replacement, is asked about.
  for r in
    select d.* from public.holding_dividends d
    join public.dividend_events a on a.id = d.event_id
    where d.holding_id = v_h.id and d.status <> 'skipped' and coalesce(d.ex_date, a.ex_date) >= v_from
      and (a.superseded_by is not null or a.missed_checks >= 2)
    order by d.ex_date, d.id
  loop
    select * into e from public.dividend_events x where x.id = (select a.superseded_by from public.dividend_events a where a.id = r.event_id);
    if found and r.status = 'earned' and not r.fixed
       and not exists (select 1 from public.holding_dividends y where y.holding_id = v_h.id and y.id <> r.id and (y.event_id = e.id or y.ex_date = e.ex_date)) then
      v_units := case when e.ex_date <= v_today then coalesce(private.units_on_ex_date(v_h.id, e.ex_date), 0) else 0 end;
      if v_units = 0 then
        delete from public.holding_dividends where id = r.id;
        v_removed := v_removed + 1;
      else
        v_exp := private.dividend_expected(v_units, e.amount, v_h.dividend_tax_pct, v_h.dividend_fee_per_share);
        update public.holding_dividends set
          event_id = e.id, ex_date = e.ex_date, pay_date = e.pay_date, record_date = e.record_date,
          units = v_units, per_share = e.amount, tax_pct = v_h.dividend_tax_pct,
          expected_gross = (v_exp ->> 'gross')::numeric, expected_tax = (v_exp ->> 'tax')::numeric,
          expected_fees = (v_exp ->> 'fees')::numeric, expected_net = (v_exp ->> 'net')::numeric,
          review_reason = case when review_reason = 'moved_ex_date' then null else review_reason end,
          version = version + 1
        where id = r.id;
        v_updated := v_updated + 1;
      end if;
    elsif r.review_reason is null
       and ((r.review_baseline ->> 'ex_date')::date is distinct from r.ex_date
            or (r.review_baseline ->> 'per_share')::numeric is distinct from r.per_share) then
      update public.holding_dividends set review_reason = 'moved_ex_date', version = version + 1 where id = r.id;
      v_flagged := v_flagged + 1;
    end if;
  end loop;

  -- 2. Every listed event whose ex-date has passed, as listed by a check made
  -- on or after it, so a date that moved before then is never earned.
  for e in
    select * from public.dividend_events ev
    where ev.symbol = v_h.price_symbol and ev.ex_date >= v_from and ev.ex_date <= v_today
      and ev.superseded_by is null
      and v_state.last_success_at is not null and ev.last_seen_at = v_state.last_success_at
      and (v_state.last_success_at at time zone 'Asia/Dubai')::date >= ev.ex_date
    order by ev.ex_date
  loop
    v_units := coalesce(private.units_on_ex_date(v_h.id, e.ex_date), 0);
    v_split_on_ex := exists (select 1 from public.dividend_splits sp where sp.symbol = e.symbol and sp.effective_date = e.ex_date);

    select * into r from public.holding_dividends d where d.holding_id = v_h.id and d.event_id = e.id;
    if found then
      if r.status = 'skipped' then
        continue;
      end if;
      -- A split found later on the ex-date leaves its basis unclear: asked
      -- about, and not worked out again until a member looks.
      if v_split_on_ex then
        if r.review_reason is null then
          update public.holding_dividends set review_reason = 'split_on_ex_date', version = version + 1 where id = r.id;
          v_flagged := v_flagged + 1;
        end if;
        continue;
      end if;
      -- Listed again after it went missing: the question no longer stands.
      if r.review_reason = 'moved_ex_date' then
        update public.holding_dividends set review_reason = null, version = version + 1 where id = r.id
        returning * into r;
        v_updated := v_updated + 1;
      end if;
      if r.status = 'earned' and not r.fixed then
        if v_units = 0 then
          delete from public.holding_dividends where id = r.id;
          v_removed := v_removed + 1;
          continue;
        end if;
        v_exp := private.dividend_expected(v_units, e.amount, v_h.dividend_tax_pct, v_h.dividend_fee_per_share);
        if r.units is distinct from v_units or r.per_share is distinct from e.amount or r.ex_date is distinct from e.ex_date
           or r.pay_date is distinct from e.pay_date or r.record_date is distinct from e.record_date
           or r.tax_pct is distinct from v_h.dividend_tax_pct or r.expected_net is distinct from (v_exp ->> 'net')::numeric
           or r.expected_fees is distinct from (v_exp ->> 'fees')::numeric then
          update public.holding_dividends set
            units = v_units, per_share = e.amount, ex_date = e.ex_date, pay_date = e.pay_date, record_date = e.record_date,
            tax_pct = v_h.dividend_tax_pct,
            expected_gross = (v_exp ->> 'gross')::numeric, expected_tax = (v_exp ->> 'tax')::numeric,
            expected_fees = (v_exp ->> 'fees')::numeric, expected_net = (v_exp ->> 'net')::numeric,
            version = version + 1
          where id = r.id;
          v_updated := v_updated + 1;
        end if;
      elsif r.review_reason is null then
        -- A row a member received, presumed or fixed keeps its figures; a
        -- change under it is asked about once, unless already kept.
        if r.units is distinct from v_units and (r.review_baseline ->> 'units')::numeric is distinct from v_units then
          update public.holding_dividends set review_reason = 'trades_changed', version = version + 1 where id = r.id;
          v_flagged := v_flagged + 1;
        elsif r.per_share is distinct from e.amount and (r.review_baseline ->> 'per_share')::numeric is distinct from e.amount then
          update public.holding_dividends set review_reason = 'feed_changed', version = version + 1 where id = r.id;
          v_flagged := v_flagged + 1;
        end if;
      end if;
      continue;
    end if;

    -- From here a new dividend would be made. A pay date before the ex-date
    -- (some large special distributions) and a split on the ex-date itself
    -- are left for a member to add by hand.
    if v_units = 0 or e.pay_date < e.ex_date or v_split_on_ex then
      continue;
    end if;
    -- Nothing is made beside a dividend that stayed on an older date this
    -- event replaced, or on one the source has stopped listing nearby: either
    -- may be this very dividend.
    if exists (
      select 1 from public.holding_dividends d join public.dividend_events a on a.id = d.event_id
      where d.holding_id = v_h.id and d.event_id <> e.id and d.status <> 'skipped'
        and (a.superseded_by = e.id
             or (a.superseded_by is null and a.last_seen_at <> v_state.last_success_at and abs(a.ex_date - e.ex_date) <= 15))) then
      continue;
    end if;

    -- A dividend a member added for the same ex-date is this event: link it,
    -- keeping its figures, and ask about it if the feed's amount differs.
    select * into r from public.holding_dividends d
    where d.holding_id = v_h.id and d.event_id is null and d.ex_date = e.ex_date;
    if found then
      update public.holding_dividends set
        event_id = e.id,
        review_reason = case
          when review_reason is null and per_share is distinct from e.amount
            and (review_baseline ->> 'per_share')::numeric is distinct from e.amount then 'feed_changed'
          else review_reason end,
        version = version + 1
      where id = r.id
      returning * into r;
      if r.review_reason = 'feed_changed' then v_flagged := v_flagged + 1; else v_updated := v_updated + 1; end if;
      continue;
    end if;

    -- One added for a date close to it may be the same dividend under a date
    -- the member remembered differently: nothing is made, and it is asked,
    -- once, about the first such event.
    select * into r from public.holding_dividends d
    where d.holding_id = v_h.id and d.event_id is null
      and (abs(d.ex_date - e.ex_date) <= 10 or abs(d.pay_date - e.pay_date) <= 10)
    order by abs(coalesce(d.ex_date, d.pay_date) - coalesce(e.ex_date, e.pay_date)), d.id
    limit 1;
    if found then
      if r.review_reason is null and (r.review_baseline ->> 'not_duplicate_of') is distinct from e.id::text then
        update public.holding_dividends set review_reason = 'possible_duplicate', review_event_id = e.id, version = version + 1
        where id = r.id;
        v_flagged := v_flagged + 1;
      end if;
      continue;
    end if;

    v_exp := private.dividend_expected(v_units, e.amount, v_h.dividend_tax_pct, v_h.dividend_fee_per_share);
    insert into public.holding_dividends (
      household_id, holding_id, event_id, ex_date, record_date, pay_date, currency, units, units_basis, per_share, tax_pct,
      expected_gross, expected_tax, expected_fees, expected_net, status, paid_into_account_id, source)
    values (
      v_h.household_id, v_h.id, e.id, e.ex_date, e.record_date, e.pay_date, v_h.currency, v_units, 'trades', e.amount, v_h.dividend_tax_pct,
      (v_exp ->> 'gross')::numeric, (v_exp ->> 'tax')::numeric, (v_exp ->> 'fees')::numeric, (v_exp ->> 'net')::numeric,
      'earned', v_dest, 'feed');
    v_made := v_made + 1;
  end loop;

  -- 3. An earned row nobody fixed follows a change of where the fund's
  -- dividends land.
  with moved as (
    update public.holding_dividends set paid_into_account_id = v_dest, version = version + 1
    where holding_id = v_h.id and status = 'earned' and not fixed and paid_into_account_id is distinct from v_dest
    returning 1)
  select v_updated + count(*) into v_updated from moved;

  -- 4. A dividend that lands outside a broker fund moves no balance and is
  -- never asked about: it is presumed received 30 days after its ex-date (an
  -- Indian company must pay within 30 days of declaring, and declares before
  -- the record date), or once its pay date has passed if that is later. One
  -- whose event the source has dropped may never be paid, so it is not.
  with presumed as (
    update public.holding_dividends d set
      status = 'presumed',
      credited_on = greatest(d.ex_date + 30, coalesce(d.pay_date, d.ex_date + 30)),
      credited_on_estimated = true,
      version = d.version + 1
    where d.holding_id = v_h.id and d.status = 'earned' and d.ex_date is not null
      and d.review_reason is distinct from 'moved_ex_date'
      and greatest(d.ex_date + 30, coalesce(d.pay_date, d.ex_date + 30)) <= v_today
      and not exists (select 1 from public.accounts a where a.id = d.paid_into_account_id and a.type = 'broker_funds')
    returning 1)
  select count(*) into v_presumed from presumed;

  return jsonb_build_object('made', v_made, 'updated', v_updated, 'removed', v_removed, 'flagged', v_flagged, 'presumed', v_presumed);
end;
$$;

-- The nightly run. First the moved ex-dates, decided once per share without
-- any holding lock; then every holding with dividends to earn, in id order,
-- each under its row lock and in its own subtransaction, so one holding that
-- cannot be done is reported and the rest are still earned. Service role only.
create or replace function public.earn_dividends()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_result jsonb;
  v_superseded integer;
  v_total jsonb := jsonb_build_object('made', 0, 'updated', 0, 'removed', 0, 'flagged', 0, 'presumed', 0);
  v_failures jsonb := '[]'::jsonb;
  k text;
begin
  v_superseded := private.supersede_moved_events();
  for v_id in
    select h.id from public.holdings h
    where h.price_symbol is not null
      and exists (select 1 from public.dividend_events e where e.symbol = h.price_symbol)
    order by h.id
  loop
    begin
      perform 1 from public.holdings where id = v_id for update;
      v_result := private.sync_holding_dividends(v_id, null);
      foreach k in array array['made', 'updated', 'removed', 'flagged', 'presumed'] loop
        v_total := jsonb_set(v_total, array[k], to_jsonb((v_total ->> k)::int + (v_result ->> k)::int));
      end loop;
    exception when others then
      v_failures := v_failures || jsonb_build_object('holding_id', v_id, 'error', sqlerrm);
    end;
  end loop;
  return v_total || jsonb_build_object('superseded', v_superseded, 'failures', v_failures);
end;
$$;

revoke execute on function private.units_on_ex_date(uuid, date) from public, anon, authenticated;
revoke execute on function private.dividend_expected(numeric, numeric, numeric, numeric) from public, anon, authenticated;
revoke execute on function private.dividend_destination(public.holdings) from public, anon, authenticated;
revoke execute on function private.dividend_provider(public.holdings) from public, anon, authenticated;
revoke execute on function private.sync_holding_dividends(uuid, date) from public, anon, authenticated;
revoke execute on function private.supersede_moved_events() from public, anon, authenticated;
revoke execute on function public.earn_dividends() from public, anon, authenticated;
grant execute on function public.earn_dividends() to service_role;

-- ---------------------------------------------------------------------------
-- 7. Trades and rates re-work what was earned
-- ---------------------------------------------------------------------------

-- A trade saved, fixed or deleted changes the units on every later ex-date,
-- so the holding's dividends from the day before it (a US trade's market day
-- can be the day before its date) are re-worked in the same transaction. The
-- trade functions lock the holding before they write the trade, so this runs
-- under that lock, as every writer of a holding's dividends must. A holding
-- being deleted takes its dividends with it; nothing is re-worked for it.
create or replace function private.trades_sync_dividends()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holding uuid := coalesce(new.holding_id, old.holding_id);
  v_from date;
begin
  if not exists (select 1 from public.holdings where id = v_holding) then
    return null;
  end if;
  v_from := case tg_op
    when 'INSERT' then new.trade_date
    when 'DELETE' then old.trade_date
    else least(old.trade_date, new.trade_date)
  end - 1;
  -- A dividend that cannot be re-worked never stops the trade: the nightly
  -- run tries again and reports what it cannot do.
  begin
    perform private.sync_holding_dividends(v_holding, v_from);
  exception when others then
    raise warning 'dividends of holding % were not re-worked after a trade: %', v_holding, sqlerrm;
  end;
  return null;
end;
$$;

create trigger holding_trades_sync_dividends
  after insert or delete or update of trade_date, traded_at, units, kind on holding_trades
  for each row execute function private.trades_sync_dividends();

-- A new withholding rate or fee re-works the holding's earned dividends
-- nobody fixed; received, presumed and fixed ones keep the figures they had.
-- The update that changed the rate holds the holding's row lock.
create or replace function private.holding_rates_sync_dividends()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.dividend_tax_pct is distinct from old.dividend_tax_pct
     or new.dividend_fee_per_share is distinct from old.dividend_fee_per_share then
    perform private.sync_holding_dividends(new.id, null);
  end if;
  return null;
end;
$$;

create trigger holdings_rates_sync_dividends
  after update of dividend_tax_pct, dividend_fee_per_share on holdings
  for each row execute function private.holding_rates_sync_dividends();

revoke execute on function private.trades_sync_dividends() from public, anon, authenticated;
revoke execute on function private.holding_rates_sync_dividends() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. The nightly dividend run
-- ---------------------------------------------------------------------------

-- The whole of schedule_all_jobs as 20261011195208_scheduler_secret.sql has
-- it, with the fourth job, daily-dividend-refresh, added.
create or replace function schedule_all_jobs(p_base_url text)
returns table (jobname text, schedule text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := rtrim(coalesce(p_base_url, ''), '/');
begin
  -- A bare ref, an http:// URL or a /functions/v1 suffix each produce jobs
  -- that dispatch successfully and are answered by nothing -- cheap to refuse
  -- here, expensive to notice later. A trailing slash is the one mistake
  -- worth absorbing rather than rejecting: it is what copying the URL out of
  -- the dashboard gives you, and the rtrim above has already removed it.
  if v_base !~ '^https://[a-z0-9-]+\.supabase\.co$' then
    raise exception 'base url must look like https://<project-ref>.supabase.co, got %', p_base_url
      using errcode = '22023',
            hint = 'Pass the replacement project''s URL, with no trailing slash and no /functions/v1 suffix.';
  end if;

  -- cron.schedule replaces a job of the same name, so this is idempotent and
  -- safe to re-run. The unschedule is kept for the jobs that already exist
  -- under these names, matching what the earlier migrations did.
  if exists (select 1 from cron.job j where j.jobname = 'weekday-price-refresh') then
    perform cron.unschedule('weekday-price-refresh');
  end if;
  if exists (select 1 from cron.job j where j.jobname = 'daily-recurring-nudge-check') then
    perform cron.unschedule('daily-recurring-nudge-check');
  end if;
  if exists (select 1 from cron.job j where j.jobname = 'daily-fd-accrual') then
    perform cron.unschedule('daily-fd-accrual');
  end if;
  if exists (select 1 from cron.job j where j.jobname = 'daily-dividend-refresh') then
    perform cron.unschedule('daily-dividend-refresh');
  end if;

  -- The secret is read when the job runs, not written into the job, so
  -- rotating it in the vault needs no reschedule. An unset secret sends an
  -- empty header, which the function refuses and logs as a 403, rather than
  -- a job that errors before any request is made. 120s: a real refresh paces
  -- Twelve Data batches a minute apart, and a shorter timeout reports a
  -- client-side failure while the function is still running fine.
  perform cron.schedule(
    'weekday-price-refresh',
    '0 23 * * 0,1,2,3,4',
    format($job$select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'X-Rokda-Scheduler-Secret', coalesce(public.get_scheduler_secret(), ''),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )$job$, v_base || '/functions/v1/price-refresh')
  );

  -- The webhook rejects any request without this shared secret, before it
  -- parses anything -- including this one.
  perform cron.schedule(
    'daily-recurring-nudge-check',
    '0 5 * * *',
    format($job$select net.http_get(
    url := %L,
    headers := jsonb_build_object('X-Telegram-Bot-Api-Secret-Token', get_telegram_webhook_secret()),
    timeout_milliseconds := 60000
  )$job$, v_base || '/functions/v1/telegram-webhook?run_recurring_check=1')
  );

  perform cron.schedule(
    'daily-fd-accrual',
    '0 23 * * *',
    format($job$select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'X-Rokda-Scheduler-Secret', coalesce(public.get_scheduler_secret(), ''),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )$job$, v_base || '/functions/v1/fd-accrual')
  );

  -- SHR-366: the dividend run, before the morning check (05:00) so what it
  -- earns is there to ask about. 120s: up to five Alpha Vantage calls are
  -- spaced twelve seconds apart, after the Indian shares.
  perform cron.schedule(
    'daily-dividend-refresh',
    '30 1 * * *',
    format($job$select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'X-Rokda-Scheduler-Secret', coalesce(public.get_scheduler_secret(), ''),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )$job$, v_base || '/functions/v1/dividend-refresh')
  );

  return query select j.jobname::text, j.schedule::text from cron.job j order by j.jobname;
end;
$$;

revoke execute on function schedule_all_jobs(text) from public, anon, authenticated;

comment on function schedule_all_jobs is
  'Creates or replaces all four scheduled jobs against a given project base URL (https://<ref>.supabase.co). The one call recovery makes to retarget everything after restoring into a replacement project -- see docs/backup-restore.md §5 and scripts/verify-cron-targets.sql.';

select schedule_all_jobs('https://erggbzbbutsvhleqcddq.supabase.co');
