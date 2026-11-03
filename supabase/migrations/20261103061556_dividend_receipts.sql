-- Dividends (SHR-366), PR 2: receipts.
--
-- Design: docs/superpowers/specs/2026-11-02-dividends-design.md, sections
-- 5.4 to 5.6. A dividend paid into a broker's fund is received once a member
-- confirms it, in the app or the bot, and moves the fund exactly once across
-- fixes, skips, moves between funds and balance check-ins. One function,
-- private.dividend_change, works out and applies every member change, so the
-- preview and the save cannot disagree, and the bot's "yes" goes through it
-- too.

-- ---------------------------------------------------------------------------
-- 1. Receipts and the balance rule
-- ---------------------------------------------------------------------------

-- The moment a receipt counts at, when its day alone cannot say: a balance
-- confirmed in the app is dated at the start of its day, so a receipt on that
-- day is before or after it only by the member's word. Null means the end of
-- the credit date in Dubai, as for a trade with no time (traded_at).
alter table holding_dividends add column credited_at timestamptz;
alter table holding_dividends add constraint holding_dividends_credited_at_when_received
  check (credited_at is null or status = 'received');

-- What a receipt adds to the account it was paid into, by the trades' rule:
-- its received net when it is received into a broker fund after the fund's
-- last confirmation, and nothing otherwise, since a confirmed balance already
-- holds what arrived before it. Bank balances are snapshots and never move.
-- It reads the account as it now is: a writer locks the account first.
create or replace function private.dividend_contribution(
  p_status text, p_net numeric, p_credited_on date, p_credited_at timestamptz, p_account_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select case
      when p_status = 'received' and a.type = 'broker_funds'
        and private.trade_moves_fund(a.balance_as_of, p_credited_on, p_credited_at) then p_net
      else 0 end
    from public.accounts a where a.id = p_account_id), 0);
$$;

-- Works out, and when p_save applies, one member change to a dividend:
-- record (it arrived), fix (any figure, date or destination), skip (it never
-- came), restore (back to earned) or add (one the feed missed, or an older
-- receipt). The caller has checked the member belongs to the household.
--
-- Each fund moves by what the receipt will contribute less what it does now,
-- both against the fund's current confirmation, so nothing about a receipt's
-- effect is stored and every change, both ways, follows the same rule. A save
-- locks the holding, then the dividend, then the funds, and only then reads
-- the confirmations; it saves only at the version and the confirmations the
-- preview showed. Figures are worked out here; the client's net is ignored.
create or replace function private.dividend_change(
  p_dividend_id uuid, p_change jsonb, p_member uuid, p_save boolean,
  p_expected_version integer, p_expected_confirmations jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text := p_change ->> 'action';
  v_today date := public.household_today();
  v_old public.holding_dividends%rowtype;
  v_new public.holding_dividends%rowtype;
  v_h public.holdings%rowtype;
  v_dest public.accounts%rowtype;
  v_acc public.accounts%rowtype;
  v_existing uuid;
  v_defaulted boolean := false;
  v_answer boolean;
  v_timing boolean := false;
  v_asks text;
  v_asks_on date;
  v_ambiguous boolean := false;
  v_old_c numeric := 0;
  v_new_c numeric := 0;
  v_deltas jsonb := '{}'::jsonb;
  v_movements jsonb := '[]'::jsonb;
  v_confirmations jsonb := '{}'::jsonb;
  v_key text;
  v_delta numeric;
  v_accounts uuid[];
  v_version integer;
begin
  if v_action is null or v_action not in ('record', 'fix', 'skip', 'restore', 'add') then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  begin
    v_answer := (p_change ->> 'already_included')::boolean;
    perform (p_change ->> 'credited_on')::date, (p_change ->> 'ex_date')::date, (p_change ->> 'pay_date')::date,
      (p_change ->> 'record_date')::date, (p_change ->> 'units')::numeric, (p_change ->> 'per_share')::numeric,
      (p_change ->> 'tax_pct')::numeric, (p_change ->> 'expected_fees')::numeric, (p_change ->> 'received_gross')::numeric,
      (p_change ->> 'received_tax')::numeric, (p_change ->> 'received_fees')::numeric, (p_change ->> 'paid_into_account_id')::uuid,
      (p_change ->> 'holding_id')::uuid;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end;
  -- A receipt is never dated after today: a future date would count after
  -- every later confirmation of the fund, including one that already holds it.
  if (p_change ->> 'credited_on')::date > v_today then
    return jsonb_build_object('ok', false, 'error', 'credited_in_future');
  end if;

  if v_action = 'add' then
    select * into v_h from public.holdings where id = (p_change ->> 'holding_id')::uuid;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'holding_not_found');
    end if;
    if p_save then
      perform 1 from public.holdings where id = v_h.id for update;
    end if;
    -- An import names its evidence: run again, it finds what it made.
    if p_change ? 'import_ref' then
      select d.id into v_existing from public.holding_dividends d
      where d.household_id = v_h.household_id and d.import_ref = p_change ->> 'import_ref';
      if found then
        return jsonb_build_object('ok', true, 'existing', true, 'dividend', (select to_jsonb(d) from public.holding_dividends d where d.id = v_existing),
          'movements', '[]'::jsonb, 'confirmations', '{}'::jsonb, 'version', (select d.version from public.holding_dividends d where d.id = v_existing),
          'asks', null, 'warnings', '[]'::jsonb);
      end if;
    end if;
    if not (p_change ? 'ex_date' or p_change ? 'credited_on') or not ((p_change ->> 'units')::numeric > 0)
       or (p_change ->> 'per_share') is null or (p_change ->> 'per_share')::numeric < 0 then
      return jsonb_build_object('ok', false, 'error', 'bad_input');
    end if;
    v_new.id := gen_random_uuid();
    v_new.household_id := v_h.household_id;
    v_new.holding_id := v_h.id;
    v_new.ex_date := (p_change ->> 'ex_date')::date;
    v_new.pay_date := (p_change ->> 'pay_date')::date;
    v_new.record_date := (p_change ->> 'record_date')::date;
    v_new.currency := v_h.currency;
    v_new.units := (p_change ->> 'units')::numeric;
    v_new.units_basis := 'stated';
    v_new.per_share := (p_change ->> 'per_share')::numeric;
    v_new.tax_pct := coalesce((p_change ->> 'tax_pct')::numeric, v_h.dividend_tax_pct);
    v_new.expected_fees := coalesce((p_change ->> 'expected_fees')::numeric, 0);
    v_new.paid_into_account_id := coalesce((p_change ->> 'paid_into_account_id')::uuid, private.dividend_destination(v_h));
    v_new.source := case when p_change ? 'import_ref' then 'import' else 'app' end;
    v_new.import_ref := p_change ->> 'import_ref';
    v_new.fixed := true;
    v_new.credited_on_estimated := false;
    v_new.version := 1;
    v_new.note := p_change ->> 'note';
    if p_change ? 'credited_on' then
      v_new.status := 'received';
      v_new.credited_on := (p_change ->> 'credited_on')::date;
      v_new.evidence := coalesce(p_change ->> 'evidence', 'member');
    else
      v_new.status := 'earned';
    end if;
    v_timing := v_new.status = 'received';
  else
    select * into v_old from public.holding_dividends where id = p_dividend_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'dividend_not_found');
    end if;
    if p_save then
      perform 1 from public.holdings where id = v_old.holding_id for update;
      select * into v_old from public.holding_dividends where id = p_dividend_id for update;
      -- Changed since the preview: stale, before anything else about it is
      -- judged, so a member who lost a race is told to look again.
      if v_old.version is distinct from p_expected_version then
        return jsonb_build_object('ok', false, 'error', 'stale');
      end if;
    end if;
    select * into v_h from public.holdings where id = v_old.holding_id;
    v_new := v_old;

    if v_action = 'record' then
      if v_old.status not in ('earned', 'presumed') then
        return jsonb_build_object('ok', false, 'error', 'wrong_status');
      end if;
      v_new.status := 'received';
      v_new.evidence := coalesce(p_change ->> 'evidence', 'member');
      if p_change ? 'credited_on' then
        v_new.credited_on := (p_change ->> 'credited_on')::date;
        v_new.credited_on_estimated := false;
      elsif v_old.status = 'presumed' then
        -- Marking a presumed one checked keeps the date it was presumed on.
        v_new.credited_on := v_old.credited_on;
      else
        -- The pay date, until the member says otherwise: when the fund was
        -- confirmed on or after it, whether it was already in is asked.
        -- Recorded before its pay date, it arrived today.
        v_new.credited_on := least(coalesce(v_old.pay_date, v_today), v_today);
        v_new.credited_on_estimated := false;
        v_defaulted := true;
      end if;
      v_timing := true;
    elsif v_action = 'fix' then
      if v_old.status = 'skipped' then
        return jsonb_build_object('ok', false, 'error', 'wrong_status');
      end if;
      v_new.units := coalesce((p_change ->> 'units')::numeric, v_new.units);
      v_new.per_share := coalesce((p_change ->> 'per_share')::numeric, v_new.per_share);
      v_new.tax_pct := coalesce((p_change ->> 'tax_pct')::numeric, v_new.tax_pct);
      v_new.expected_fees := coalesce((p_change ->> 'expected_fees')::numeric, v_new.expected_fees);
      v_new.paid_into_account_id := case when p_change ? 'paid_into_account_id' then (p_change ->> 'paid_into_account_id')::uuid else v_new.paid_into_account_id end;
      v_new.note := coalesce(p_change ->> 'note', v_new.note);
      v_new.fixed := true;
      if p_change ? 'received_gross' or p_change ? 'received_tax' or p_change ? 'received_fees' then
        -- Received figures make it a receipt, from the member's evidence.
        if v_new.status <> 'received' then
          v_new.status := 'received';
          v_new.evidence := coalesce(p_change ->> 'evidence', 'member');
          if not p_change ? 'credited_on' and v_new.credited_on is null then
            v_new.credited_on := least(coalesce(v_old.pay_date, v_today), v_today);
            v_defaulted := true;
          end if;
        end if;
      end if;
      if p_change ? 'credited_on' then
        if v_new.status <> 'received' and v_new.status <> 'presumed' then
          return jsonb_build_object('ok', false, 'error', 'wrong_status');
        end if;
        v_new.credited_on := (p_change ->> 'credited_on')::date;
        v_new.credited_on_estimated := false;
      end if;
      v_timing := v_new.status = 'received'
        and (v_old.status <> 'received' or p_change ? 'credited_on' or p_change ? 'paid_into_account_id');
    elsif v_action = 'skip' then
      if v_old.status not in ('earned', 'received', 'presumed') then
        return jsonb_build_object('ok', false, 'error', 'wrong_status');
      end if;
      v_new.status := 'skipped';
    else
      if v_old.status <> 'skipped' then
        return jsonb_build_object('ok', false, 'error', 'wrong_status');
      end if;
      v_new.status := 'earned';
    end if;
  end if;

  -- Expected figures follow units, amount, withholding and fees.
  if v_new.units is null or v_new.units <= 0 or v_new.per_share is null or v_new.per_share < 0
     or (v_new.tax_pct is not null and (v_new.tax_pct < 0 or v_new.tax_pct > 100)) or coalesce(v_new.expected_fees, 0) < 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  v_new.expected_gross := round(v_new.units * v_new.per_share, 4);
  v_new.expected_tax := round(v_new.expected_gross * coalesce(v_new.tax_pct, 0) / 100, 4);
  v_new.expected_fees := round(coalesce(v_new.expected_fees, 0), 4);
  if v_new.expected_tax + v_new.expected_fees > v_new.expected_gross then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  v_new.expected_net := v_new.expected_gross - v_new.expected_tax - v_new.expected_fees;

  -- Received figures: what the member gave, else what was received, else
  -- what was expected; the net is always worked out here.
  if v_new.status = 'received' then
    v_new.received_gross := round(coalesce((p_change ->> 'received_gross')::numeric, v_new.received_gross, v_new.expected_gross), 4);
    v_new.received_tax := round(coalesce((p_change ->> 'received_tax')::numeric, v_new.received_tax, v_new.expected_tax), 4);
    v_new.received_fees := round(coalesce((p_change ->> 'received_fees')::numeric, v_new.received_fees, v_new.expected_fees), 4);
    if v_new.received_gross < 0 or v_new.received_tax < 0 or v_new.received_fees < 0
       or v_new.received_tax + v_new.received_fees > v_new.received_gross then
      return jsonb_build_object('ok', false, 'error', 'bad_figures');
    end if;
    v_new.received_net := v_new.received_gross - v_new.received_tax - v_new.received_fees;
  else
    v_new.received_gross := null;
    v_new.received_tax := null;
    v_new.received_fees := null;
    v_new.received_net := null;
    v_new.evidence := null;
    v_new.credited_at := null;
    if v_new.status in ('earned', 'skipped') then
      v_new.credited_on := null;
      v_new.credited_on_estimated := false;
    end if;
  end if;

  -- The destination is the household's and in the dividend's currency.
  if v_new.paid_into_account_id is not null then
    select * into v_dest from public.accounts where id = v_new.paid_into_account_id;
    if not found or v_dest.household_id <> v_new.household_id then
      return jsonb_build_object('ok', false, 'error', 'bad_input');
    end if;
    if v_dest.currency <> v_new.currency then
      return jsonb_build_object('ok', false, 'error', 'currency_mismatch');
    end if;
  end if;

  -- The funds the change touches, locked before their confirmations are read.
  v_accounts := array(
    select distinct x from unnest(array[v_old.paid_into_account_id, v_new.paid_into_account_id]) x
    where x is not null and exists (select 1 from public.accounts a where a.id = x and a.type = 'broker_funds')
    order by x);
  if p_save and cardinality(v_accounts) > 0 then
    perform private.lock_funds(v_accounts);
  end if;

  -- Whether it was already in the fund's confirmed balance, asked only when
  -- the dates cannot say: a credit date taken from the pay date with the fund
  -- confirmed on or after it, or a credit date on the confirmation's own day.
  if v_timing then
    v_new.credited_at := null;
    select * into v_dest from public.accounts where id = v_new.paid_into_account_id;
    if found and v_dest.type = 'broker_funds' and v_dest.balance_as_of is not null then
      v_ambiguous := (v_defaulted and v_dest.balance_as_of >= (v_new.credited_on::timestamp at time zone 'Asia/Dubai'))
        or (not v_defaulted and (v_dest.balance_as_of at time zone 'Asia/Dubai')::date = v_new.credited_on);
      if v_ambiguous then
        if v_answer is null then
          v_asks := 'already_included';
          -- The day the question names: the confirmation as it is now.
          v_asks_on := (v_dest.balance_as_of at time zone 'Asia/Dubai')::date;
        elsif v_answer then
          v_new.credited_at := v_dest.balance_as_of - interval '1 second';
        elsif v_defaulted then
          v_new.credited_on := v_today;
        else
          v_new.credited_at := v_dest.balance_as_of + interval '1 second';
        end if;
      end if;
    end if;
  end if;

  -- The movement: each fund by what the receipt will add less what it adds.
  if v_action <> 'add' then
    v_old_c := private.dividend_contribution(v_old.status, v_old.received_net, v_old.credited_on, v_old.credited_at, v_old.paid_into_account_id);
  end if;
  v_new_c := private.dividend_contribution(v_new.status, v_new.received_net, v_new.credited_on, v_new.credited_at, v_new.paid_into_account_id);
  if v_old.paid_into_account_id is not null and v_old_c <> 0 then
    v_deltas := jsonb_set(v_deltas, array[v_old.paid_into_account_id::text], to_jsonb(-v_old_c));
  end if;
  if v_new.paid_into_account_id is not null and v_new_c <> 0 then
    v_deltas := jsonb_set(v_deltas, array[v_new.paid_into_account_id::text],
      to_jsonb(coalesce((v_deltas ->> v_new.paid_into_account_id::text)::numeric, 0) + v_new_c));
  end if;
  foreach v_key in array coalesce(array(select jsonb_object_keys(v_deltas)), '{}'::text[]) loop
    v_delta := round((v_deltas ->> v_key)::numeric, 2);
    continue when v_delta = 0;
    select * into v_acc from public.accounts where id = v_key::uuid;
    if v_acc.archived_at is not null then
      return jsonb_build_object('ok', false, 'error', 'fund_archived');
    end if;
    v_movements := v_movements || jsonb_build_object('account_id', v_acc.id, 'account_name', v_acc.name, 'currency', v_acc.currency,
      'delta', v_delta, 'balance_after', v_acc.balance + v_delta);
  end loop;
  foreach v_key in array coalesce(array(select x::text from unnest(v_accounts) x), '{}'::text[]) loop
    v_confirmations := v_confirmations || jsonb_build_object(v_key, (select a.balance_as_of::text from public.accounts a where a.id = v_key::uuid));
  end loop;

  v_version := case when v_action = 'add' then 0 else v_old.version end;
  if not p_save then
    return jsonb_build_object('ok', true, 'dividend', to_jsonb(v_new), 'movements', v_movements, 'confirmations', v_confirmations,
      'version', v_version, 'asks', v_asks, 'asks_confirmed_on', v_asks_on, 'warnings', '[]'::jsonb);
  end if;

  -- A fund confirmed since the preview makes the preview itself out of date,
  -- question and all, so it is reported first.
  foreach v_key in array coalesce(array(select jsonb_object_keys(v_confirmations)), '{}'::text[]) loop
    if (v_confirmations ->> v_key) is distinct from (coalesce(p_expected_confirmations, '{}'::jsonb) ->> v_key) then
      return jsonb_build_object('ok', false, 'error', 'fund_confirmed_since');
    end if;
  end loop;
  if v_asks is not null then
    return jsonb_build_object('ok', false, 'error', 'needs_answer');
  end if;

  if v_action = 'add' then
    begin
      insert into public.holding_dividends (
        id, household_id, holding_id, ex_date, record_date, pay_date, currency, units, units_basis, per_share, tax_pct,
        expected_gross, expected_tax, expected_fees, expected_net, received_gross, received_tax, received_fees, received_net,
        status, evidence, credited_on, credited_on_estimated, credited_at, paid_into_account_id, fixed, source, import_ref,
        version, note, updated_by)
      values (
        v_new.id, v_new.household_id, v_new.holding_id, v_new.ex_date, v_new.record_date, v_new.pay_date, v_new.currency, v_new.units,
        v_new.units_basis, v_new.per_share, v_new.tax_pct, v_new.expected_gross, v_new.expected_tax, v_new.expected_fees, v_new.expected_net,
        v_new.received_gross, v_new.received_tax, v_new.received_fees, v_new.received_net, v_new.status, v_new.evidence, v_new.credited_on,
        v_new.credited_on_estimated, v_new.credited_at, v_new.paid_into_account_id, true, v_new.source, v_new.import_ref, 1, v_new.note, p_member);
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'already_recorded');
    end;
  else
    update public.holding_dividends set
      units = v_new.units, per_share = v_new.per_share, tax_pct = v_new.tax_pct,
      expected_gross = v_new.expected_gross, expected_tax = v_new.expected_tax, expected_fees = v_new.expected_fees, expected_net = v_new.expected_net,
      received_gross = v_new.received_gross, received_tax = v_new.received_tax, received_fees = v_new.received_fees, received_net = v_new.received_net,
      status = v_new.status, evidence = v_new.evidence, credited_on = v_new.credited_on, credited_on_estimated = v_new.credited_on_estimated,
      credited_at = v_new.credited_at, paid_into_account_id = v_new.paid_into_account_id, fixed = v_new.fixed, note = v_new.note,
      version = version + 1, updated_by = p_member
    where id = v_new.id;
  end if;

  foreach v_key in array coalesce(array(select jsonb_object_keys(v_deltas)), '{}'::text[]) loop
    v_delta := round((v_deltas ->> v_key)::numeric, 2);
    continue when v_delta = 0;
    perform private.move_fund(v_key::uuid, v_delta, p_source, p_member);
  end loop;

  return jsonb_build_object('ok', true, 'dividend', (select to_jsonb(d) from public.holding_dividends d where d.id = v_new.id),
    'movements', v_movements, 'confirmations', v_confirmations,
    'version', (select d.version from public.holding_dividends d where d.id = v_new.id), 'asks', null, 'warnings', '[]'::jsonb);
end;
$$;

-- The household a change is in, and the member making it: a signed-in member
-- of it, or for the service role the member it names. An add is in the
-- household of the holding it adds to, and names no dividend: the household
-- is taken from what the change writes to, never from another row the call
-- names. Evidence and an import reference come only from the service role
-- (the import of credit intimations), never from the app.
create or replace function private.dividend_caller(p_dividend_id uuid, p_change jsonb, p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_member uuid;
begin
  if p_change ->> 'action' = 'add' then
    if p_dividend_id is not null then
      return jsonb_build_object('error', 'bad_input');
    end if;
    begin
      select h.household_id into v_household from public.holdings h where h.id = (p_change ->> 'holding_id')::uuid;
    exception when others then
      return jsonb_build_object('error', 'bad_input');
    end;
    if v_household is null then
      return jsonb_build_object('error', 'holding_not_found');
    end if;
  else
    select d.household_id into v_household from public.holding_dividends d where d.id = p_dividend_id;
    if v_household is null then
      return jsonb_build_object('error', 'dividend_not_found');
    end if;
  end if;
  v_member := private.trade_caller(v_household, p_member_id);
  if v_member is null then
    return jsonb_build_object('error', 'not_member');
  end if;
  if auth.uid() is not null and (p_change ? 'evidence' or p_change ? 'import_ref') then
    return jsonb_build_object('error', 'bad_input');
  end if;
  return jsonb_build_object('member', v_member, 'source', case when auth.uid() is not null then 'app' else 'bot' end);
end;
$$;

-- What a change would do: the dividend after it, each fund's movement, the
-- confirmations it was worked out against, the version, and whether the
-- member must say if it was already in a confirmed balance. Saves nothing.
create or replace function public.preview_dividend(p_dividend_id uuid, p_change jsonb, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.dividend_caller(p_dividend_id, p_change, p_member_id);
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_caller ->> 'error');
  end if;
  return private.dividend_change(p_dividend_id, p_change, (v_caller ->> 'member')::uuid, false, null, null, v_caller ->> 'source');
end;
$$;

-- Saves exactly what was previewed: refused, saving nothing, if the dividend
-- or any fund's confirmation changed since.
create or replace function public.save_dividend(
  p_dividend_id uuid, p_change jsonb, p_expected_version integer, p_expected_confirmations jsonb, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.dividend_caller(p_dividend_id, p_change, p_member_id);
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_caller ->> 'error');
  end if;
  return private.dividend_change(p_dividend_id, p_change, (v_caller ->> 'member')::uuid, true,
    p_expected_version, p_expected_confirmations, v_caller ->> 'source');
end;
$$;

revoke execute on function private.dividend_contribution(text, numeric, date, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function private.dividend_change(uuid, jsonb, uuid, boolean, integer, jsonb, text) from public, anon, authenticated;
revoke execute on function private.dividend_caller(uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.preview_dividend(uuid, jsonb, uuid) from public, anon;
revoke execute on function public.save_dividend(uuid, jsonb, integer, jsonb, uuid) from public, anon;
grant execute on function public.preview_dividend(uuid, jsonb, uuid) to authenticated, service_role;
grant execute on function public.save_dividend(uuid, jsonb, integer, jsonb, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Review and one-off answers
-- ---------------------------------------------------------------------------

-- "Keep as it is": a member has looked at what changed under a dividend and
-- keeps its figures. What they saw is added to its baseline, so the same
-- change is not raised again: the feed's amount (for a feed change), the
-- units the trades now give (for a trade change), the row's own amount and
-- date (for a missing or moved date), for a possible duplicate the events it
-- is not, and for a split on its ex-date that it was looked at.
create or replace function public.keep_dividend(p_dividend_id uuid, p_expected_version integer, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.dividend_caller(p_dividend_id, '{}'::jsonb, p_member_id);
  r public.holding_dividends%rowtype;
  v_baseline jsonb;
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_caller ->> 'error');
  end if;
  select * into r from public.holding_dividends where id = p_dividend_id;
  perform 1 from public.holdings where id = r.holding_id for update;
  select * into r from public.holding_dividends where id = p_dividend_id for update;
  if r.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'error', 'stale');
  end if;
  -- Each answer adds to what was kept before: keeping a trade change must not
  -- undo a feed change kept earlier, or the feed's question comes back.
  v_baseline := coalesce(r.review_baseline, '{}'::jsonb) || jsonb_build_object(
    'per_share', case r.review_reason
      when 'feed_changed' then coalesce((select e.amount from public.dividend_events e where e.id = r.event_id), r.per_share)
      when 'moved_ex_date' then r.per_share
      else coalesce((r.review_baseline ->> 'per_share')::numeric, r.per_share) end,
    'units', case r.review_reason
      when 'trades_changed' then coalesce(case when r.ex_date is not null then private.units_on_ex_date(r.holding_id, r.ex_date) end, r.units)
      else coalesce((r.review_baseline ->> 'units')::numeric, r.units) end,
    'ex_date', r.ex_date);
  if r.review_reason = 'possible_duplicate' and r.review_event_id is not null then
    v_baseline := jsonb_set(v_baseline, '{not_duplicate_of}',
      coalesce(case when jsonb_typeof(v_baseline -> 'not_duplicate_of') = 'array' then v_baseline -> 'not_duplicate_of' end, '[]'::jsonb)
        || to_jsonb(r.review_event_id::text));
  elsif r.review_reason = 'split_on_ex_date' then
    v_baseline := v_baseline || jsonb_build_object('split_kept', true);
  end if;
  update public.holding_dividends
  set review_baseline = v_baseline, review_reason = null, review_event_id = null, version = version + 1,
      updated_by = (v_caller ->> 'member')::uuid
  where id = r.id;
  return jsonb_build_object('ok', true, 'version', r.version + 1);
end;
$$;

-- "It's this one": a dividend a member added is the feed's event it was
-- asked about. It keeps the member's figures, and its baseline holds the
-- event's amount and the units the trades give on the event's date, so the
-- link raises no question of its own.
create or replace function public.link_dividend(p_dividend_id uuid, p_event_id uuid, p_expected_version integer, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.dividend_caller(p_dividend_id, '{}'::jsonb, p_member_id);
  r public.holding_dividends%rowtype;
  e public.dividend_events%rowtype;
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_caller ->> 'error');
  end if;
  select * into r from public.holding_dividends where id = p_dividend_id;
  perform 1 from public.holdings where id = r.holding_id for update;
  select * into r from public.holding_dividends where id = p_dividend_id for update;
  if r.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'error', 'stale');
  end if;
  select * into e from public.dividend_events where id = p_event_id
    and symbol = (select h.price_symbol from public.holdings h where h.id = r.holding_id);
  if not found then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  if r.event_id is not null or exists (
    select 1 from public.holding_dividends d where d.holding_id = r.holding_id and d.event_id = p_event_id) then
    return jsonb_build_object('ok', false, 'error', 'already_linked');
  end if;
  update public.holding_dividends
  set event_id = e.id, review_reason = null, review_event_id = null, version = version + 1,
      review_baseline = jsonb_build_object('per_share', e.amount,
        'units', coalesce(private.units_on_ex_date(r.holding_id, e.ex_date), r.units), 'ex_date', r.ex_date),
      updated_by = (v_caller ->> 'member')::uuid
  where id = r.id;
  return jsonb_build_object('ok', true, 'version', r.version + 1);
end;
$$;

-- A member's answer about how much of an event was a one-off, from nothing to
-- the whole amount; null removes it. Only for an event one of the household's
-- holdings has a dividend on.
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
  if v_member is null or not exists (
    select 1 from public.holding_dividends d where d.household_id = v_household and d.event_id = p_event_id) then
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

revoke execute on function public.keep_dividend(uuid, integer, uuid) from public, anon;
revoke execute on function public.link_dividend(uuid, uuid, integer, uuid) from public, anon;
revoke execute on function public.set_special_part(uuid, numeric, uuid) from public, anon;
grant execute on function public.keep_dividend(uuid, integer, uuid) to authenticated, service_role;
grant execute on function public.link_dividend(uuid, uuid, integer, uuid) to authenticated, service_role;
grant execute on function public.set_special_part(uuid, numeric, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The bot's proposal and its "yes"
-- ---------------------------------------------------------------------------

-- The morning question: the dividends paid into one fund, asked once, and
-- received together on a "yes".
alter table bot_proposals drop constraint bot_proposals_kind_check;
alter table bot_proposals add constraint bot_proposals_kind_check
  check (kind in ('account_balances', 'goal_contribution', 'autopay_payment', 'transfer', 'trade', 'trade_undo', 'dividends_received'));

comment on table bot_proposals is
  'Changes the Telegram bot is waiting for a member to confirm: balances, goal contributions, transfers and share trades read from a message, the undo of a trade, autopay bills it asked about on their due date, and dividends it asked about once they were due in a fund. A trade still missing an answer waits as an asking row. Applied only by apply_bot_proposal(), once, on a "yes", a "paid" or a thumbs-up to the bot''s message.';

alter table holding_dividends add column asked_at timestamptz;
comment on column holding_dividends.asked_at is
  'When the bot''s morning question about this dividend went out, so it is asked once. Cleared to ask again.';

alter table telegram_notification_prefs add column dividends_enabled boolean not null default true;
comment on column telegram_notification_prefs.dividends_enabled is
  'Whether the bot asks each morning about dividends due in a broker''s fund.';

-- The morning check marks what it asked, or clears it when the question
-- could not be sent, so it is asked again the next morning.
create or replace function public.mark_dividends_asked(p_ids uuid[], p_asked boolean default true)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.holding_dividends
  set asked_at = case when p_asked then now() else null end
  where id = any(p_ids);
$$;

revoke execute on function public.mark_dividends_asked(uuid[], boolean) from public, anon, authenticated;
grant execute on function public.mark_dividends_asked(uuid[], boolean) to service_role;

-- Receives every dividend in a morning question on the member's "yes",
-- exactly as it was shown, or none of them. Each line must still be at the
-- version it was asked at and paid into the fund it was asked about, and the
-- fund must still have the confirmation it had; otherwise nothing is saved and
-- the question is stale. Each line is recorded like a member's "it arrived" in
-- the app: its credit date is its pay date, and when the fund was confirmed
-- on or after it, the answer the member gave says whether it was already in.
create or replace function private.apply_dividends_proposal(p_proposal public.bot_proposals)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fund uuid;
  v_lines jsonb := p_proposal.payload -> 'lines';
  v_ids uuid[];
  v_line jsonb;
  v_div public.holding_dividends%rowtype;
  v_account public.accounts%rowtype;
  v_change jsonb;
  v_out jsonb;
  v_error text;
  v_saved jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_moved numeric := 0;
  v_line_moved numeric;
begin
  begin
    v_fund := (p_proposal.payload ->> 'fund_id')::uuid;
    v_ids := array(select (l ->> 'dividend_id')::uuid from jsonb_array_elements(v_lines) l);
    perform (p_proposal.payload ->> 'confirmation')::timestamptz;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end;
  if v_fund is null or cardinality(v_ids) = 0 or array_position(v_ids, null) is not null then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  -- The trades' order: holdings, then the dividends, then the fund.
  perform 1 from public.holdings h
  where h.id in (select d.holding_id from public.holding_dividends d where d.id = any(v_ids))
  order by h.id for update;
  perform 1 from public.holding_dividends d where d.id = any(v_ids) order by d.id for update;
  perform private.lock_funds(array[v_fund]);

  select * into v_account from public.accounts where id = v_fund and household_id = p_proposal.household_id;
  if not found or v_account.balance_as_of is distinct from (p_proposal.payload ->> 'confirmation')::timestamptz then
    return jsonb_build_object('ok', false, 'error', 'stale');
  end if;
  -- Each line is the household's and still paid into this fund. Its version
  -- is checked by the save itself.
  for v_line in select value from jsonb_array_elements(v_lines) loop
    select * into v_div from public.holding_dividends where id = (v_line ->> 'dividend_id')::uuid;
    if not found or v_div.household_id <> p_proposal.household_id or v_div.paid_into_account_id is distinct from v_fund then
      return jsonb_build_object('ok', false, 'error', 'stale');
    end if;
  end loop;

  -- One subtransaction: a line refused rolls back the lines saved before it.
  begin
    for v_line in select value from jsonb_array_elements(v_lines) order by value ->> 'dividend_id' loop
      v_change := jsonb_build_object('action', 'record');
      if p_proposal.payload ->> 'ask' = 'already_included' and p_proposal.payload ? 'answer' then
        v_change := v_change || jsonb_build_object('already_included', p_proposal.payload ->> 'answer' = 'included');
      end if;
      v_out := private.dividend_change((v_line ->> 'dividend_id')::uuid, v_change, p_proposal.member_id, true,
        (v_line ->> 'version')::integer, jsonb_build_object(v_fund::text, v_account.balance_as_of::text), 'bot');
      if not coalesce((v_out ->> 'ok')::boolean, false) then
        v_error := v_out ->> 'error';
        raise exception 'dividend line refused' using errcode = 'RD001';
      end if;
      update public.holding_dividends set proposal_id = p_proposal.id where id = (v_line ->> 'dividend_id')::uuid;
      v_line_moved := coalesce((select sum((m ->> 'delta')::numeric) from jsonb_array_elements(v_out -> 'movements') m), 0);
      -- The figures saved, as the bot's reply shows them.
      v_saved := v_saved || jsonb_build_object('dividend_id', v_line -> 'dividend_id', 'holding_name', v_line -> 'holding_name',
        'units', v_out -> 'dividend' -> 'units', 'per_share', v_out -> 'dividend' -> 'per_share',
        'gross', v_out -> 'dividend' -> 'received_gross', 'tax', v_out -> 'dividend' -> 'received_tax',
        'fees', v_out -> 'dividend' -> 'received_fees', 'net', v_out -> 'dividend' -> 'received_net',
        'pay_date', v_out -> 'dividend' -> 'pay_date', 'credited_on', v_out -> 'dividend' -> 'credited_on', 'moved', v_line_moved);
      v_total := v_total + (v_out -> 'dividend' ->> 'received_net')::numeric;
      v_moved := v_moved + v_line_moved;
    end loop;
  exception when sqlstate 'RD001' then
    -- A line the fund's confirmation or the dividend no longer allows is the
    -- question gone stale; any other refusal is the save's own.
    if v_error in ('stale', 'fund_confirmed_since', 'needs_answer') then
      return jsonb_build_object('ok', false, 'error', 'stale');
    end if;
    return jsonb_build_object('ok', false, 'error', v_error);
  end;

  -- The same dividends asked of another member (a shared holding) are
  -- answered now, and that question says so. A dividend only such a question
  -- asked about is asked again in the morning. A question being answered at
  -- this very moment is skipped rather than waited for, which could deadlock:
  -- its own save then finds these dividends changed.
  with answered as (
    update public.bot_proposals b
    set status = 'expired', decided_at = now(), result = jsonb_build_object('kind', 'dividends_received', 'error', 'answered')
    where b.id in (
      select o.id from public.bot_proposals o
      where o.household_id = p_proposal.household_id and o.kind = 'dividends_received' and o.status = 'proposed' and o.id <> p_proposal.id
        and exists (select 1 from jsonb_array_elements(o.payload -> 'lines') l where l ->> 'dividend_id' = any(v_ids::text[]))
      for update skip locked)
    returning b.payload)
  update public.holding_dividends d set asked_at = null
  where d.status = 'earned' and not (d.id = any(v_ids))
    and d.id::text in (select l ->> 'dividend_id' from answered a, jsonb_array_elements(a.payload -> 'lines') l);

  return jsonb_build_object('ok', true, 'lines', v_saved, 'total', v_total, 'moved', v_moved);
end;
$$;

revoke execute on function private.apply_dividends_proposal(public.bot_proposals) from public, anon, authenticated;

-- The same function as 20261031092242_bot_trades, with the morning question
-- about dividends: its lines are received together, or the proposal expires
-- as stale or refused, as a trade's does.
create or replace function apply_bot_proposal(p_proposal_id uuid, p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.bot_proposals%rowtype;
  v_item jsonb;
  v_account public.accounts%rowtype;
  v_new numeric;
  v_goal public.goals%rowtype;
  v_inserted int;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_result jsonb;
  v_now timestamptz := now();
  v_recurring public.recurring%rowtype;
  v_amount numeric;
  v_due date;
  v_tx uuid;
  v_from public.accounts%rowtype;
  v_to public.accounts%rowtype;
  v_day date;
  v_link uuid;
  v_out uuid;
  v_in uuid;
  v_joined_out boolean;
  v_joined_in boolean;
  v_note text;
  v_trade jsonb;
  v_dividends jsonb;
begin
  select * into v_proposal from public.bot_proposals where id = p_proposal_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_proposal.member_id is distinct from p_member_id then
    return jsonb_build_object('outcome', 'not_yours');
  end if;
  if v_proposal.status <> 'proposed' then
    return jsonb_build_object('outcome', v_proposal.status, 'result', v_proposal.result);
  end if;
  if v_proposal.expires_at <= v_now then
    update public.bot_proposals set status = 'expired', decided_at = v_now where id = v_proposal.id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  -- Read by the balance-history trigger, for this transaction only.
  perform set_config('rokda.balance_source', 'bot', true);
  perform set_config('rokda.balance_member', v_proposal.member_id::text, true);

  if v_proposal.kind = 'dividends_received' then
    v_dividends := private.apply_dividends_proposal(v_proposal);
    if coalesce((v_dividends ->> 'ok')::boolean, false) then
      v_result := jsonb_build_object('kind', v_proposal.kind, 'lines', v_dividends -> 'lines', 'total', v_dividends -> 'total',
        'moved', v_dividends -> 'moved');
      update public.bot_proposals set status = 'applied', decided_at = v_now, result = v_result where id = v_proposal.id;
      return jsonb_build_object('outcome', 'applied') || v_result;
    end if;
    v_result := jsonb_build_object('kind', v_proposal.kind, 'error', v_dividends ->> 'error');
    update public.bot_proposals set status = 'expired', decided_at = v_now, result = v_result where id = v_proposal.id;
    if v_dividends ->> 'error' = 'stale' then
      return jsonb_build_object('outcome', 'stale', 'kind', v_proposal.kind);
    end if;
    return jsonb_build_object('outcome', 'refused', 'kind', v_proposal.kind, 'error', v_dividends ->> 'error');
  end if;

  if v_proposal.kind in ('trade', 'trade_undo') then
    if v_proposal.kind = 'trade_undo' then
      v_trade := public.delete_trade((v_proposal.payload ->> 'trade_id')::uuid,
        (v_proposal.payload ->> 'expected_version')::integer, v_proposal.member_id);
    elsif v_proposal.payload ? 'new_holding' and exists (
      select 1 from public.holdings h
      where h.household_id = v_proposal.household_id
        and h.owner_member_id = (v_proposal.payload -> 'new_holding' ->> 'owner_member_id')::uuid
        and lower(h.name) = lower(btrim(v_proposal.payload -> 'new_holding' ->> 'name'))
    ) then
      -- The member has a holding of that name now (another first buy of the
      -- stock was confirmed first): this one is stale, so the bot asks again
      -- on that holding rather than making a second one.
      v_trade := jsonb_build_object('ok', false, 'error', 'stale');
    elsif v_proposal.payload ? 'new_holding' then
      v_trade := public.record_new_holding_trade(v_proposal.payload -> 'new_holding',
        (v_proposal.payload ->> 'trade_date')::date, (v_proposal.payload ->> 'units')::numeric,
        (v_proposal.payload ->> 'price')::numeric, coalesce((v_proposal.payload ->> 'fees')::numeric, 0),
        (v_proposal.payload ->> 'traded_at')::timestamptz, (v_proposal.payload ->> 'funds_account_id')::uuid,
        'bot', v_proposal.id, v_proposal.member_id);
    else
      v_trade := public.record_trade((v_proposal.payload ->> 'holding_id')::uuid, v_proposal.payload ->> 'kind',
        (v_proposal.payload ->> 'trade_date')::date, (v_proposal.payload ->> 'units')::numeric,
        (v_proposal.payload ->> 'price')::numeric, coalesce((v_proposal.payload ->> 'fees')::numeric, 0),
        coalesce((v_proposal.payload ->> 'tax_withheld')::numeric, 0), (v_proposal.payload ->> 'traded_at')::timestamptz,
        (v_proposal.payload ->> 'funds_account_id')::uuid, 'bot', v_proposal.id, v_proposal.member_id,
        (v_proposal.payload ->> 'expected_version')::integer,
        coalesce((v_proposal.payload ->> 'tax_to_confirm')::boolean, false));
    end if;
    if coalesce((v_trade ->> 'ok')::boolean, false) then
      v_result := jsonb_build_object('kind', v_proposal.kind, 'effect', v_trade);
      update public.bot_proposals set status = 'applied', decided_at = v_now, result = v_result where id = v_proposal.id;
      return jsonb_build_object('outcome', 'applied') || v_result;
    end if;
    v_result := jsonb_build_object('kind', v_proposal.kind, 'error', v_trade ->> 'error');
    update public.bot_proposals set status = 'expired', decided_at = v_now, result = v_result where id = v_proposal.id;
    if v_trade ->> 'error' = 'stale' then
      return jsonb_build_object('outcome', 'stale', 'kind', v_proposal.kind);
    end if;
    return jsonb_build_object('outcome', 'refused', 'kind', v_proposal.kind, 'error', v_trade ->> 'error');
  end if;

  if v_proposal.kind = 'account_balances' then
    for v_item in select value from jsonb_array_elements(coalesce(v_proposal.payload -> 'items', '[]'::jsonb)) loop
      v_new := (v_item ->> 'new_balance')::numeric;
      select * into v_account
      from public.accounts a
      where a.id = (v_item ->> 'account_id')::uuid
        and a.household_id = v_proposal.household_id
        and a.archived_at is null
      for update;
      if not found or v_account.type = 'fd' or v_new is null then
        v_skipped := v_skipped || jsonb_build_object('account_id', v_item -> 'account_id', 'name', v_item -> 'name', 'reason', 'unavailable');
        continue;
      end if;
      if v_account.balance is distinct from (v_item ->> 'old_balance')::numeric then
        v_skipped := v_skipped || jsonb_build_object(
          'account_id', v_account.id, 'name', v_account.name, 'type', v_account.type, 'currency', v_account.currency,
          'reason', 'changed', 'balance', v_account.balance);
        continue;
      end if;
      update public.accounts
      set balance = v_new, balance_as_of = v_now, updated_at = v_now
      where id = v_account.id;
      v_applied := v_applied || jsonb_build_object(
        'account_id', v_account.id, 'name', v_account.name, 'type', v_account.type, 'currency', v_account.currency,
        'old_balance', v_account.balance, 'new_balance', v_new);
    end loop;

  elsif v_proposal.kind = 'goal_contribution' then
    select * into v_goal
    from public.goals g
    where g.id = (v_proposal.payload ->> 'goal_id')::uuid
      and g.household_id = v_proposal.household_id;
    if not found or coalesce((v_proposal.payload ->> 'amount')::numeric, 0) <= 0 then
      v_skipped := v_skipped || jsonb_build_object('goal_id', v_proposal.payload -> 'goal_id', 'reason', 'unavailable');
    else
      -- Keyed like the bot's direct writes used to be, so a contribution the
      -- bot recorded before this migration for the same message is not
      -- recorded a second time.
      insert into public.goal_contributions (goal_id, amount, occurred_at, source, source_ref)
      values (
        v_goal.id,
        (v_proposal.payload ->> 'amount')::numeric,
        coalesce((v_proposal.payload ->> 'occurred_at')::date, public.household_today(v_now)),
        'telegram',
        coalesce(v_proposal.source_ref, v_proposal.id::text)
      )
      on conflict (goal_id, source, source_ref) where source_ref is not null do nothing;
      get diagnostics v_inserted = row_count;
      v_applied := v_applied || jsonb_build_object(
        'goal_id', v_goal.id, 'name', v_goal.name,
        'amount', (v_proposal.payload ->> 'amount')::numeric,
        'occurred_at', coalesce((v_proposal.payload ->> 'occurred_at')::date, public.household_today(v_now)),
        'already_recorded', v_inserted = 0);
    end if;

  elsif v_proposal.kind = 'autopay_payment' then
    v_amount := (v_proposal.payload ->> 'amount')::numeric;
    v_due := (v_proposal.payload ->> 'due_date')::date;
    -- Locked, so two members confirming the same bill at the same moment
    -- record it once: the second waits here, then finds the first's.
    select * into v_recurring
    from public.recurring r
    where r.id = (v_proposal.payload ->> 'recurring_id')::uuid
      and r.household_id = v_proposal.household_id
    for update;
    if not found or v_recurring.account_id is null or v_amount is null or v_amount <= 0 or v_due is null then
      v_skipped := v_skipped || jsonb_build_object('recurring_id', v_proposal.payload -> 'recurring_id', 'name', v_proposal.payload -> 'name', 'reason', 'unavailable');
    else
      -- Recorded already: confirmed by someone else, or logged another way
      -- (a pasted bank SMS, the app). Same match as the bot's own check: the
      -- bill's account and category, an amount within 20%, a few days either
      -- side of the due date.
      select t.id into v_tx
      from public.transactions t
      where t.household_id = v_recurring.household_id
        and t.account_id = v_recurring.account_id
        and (v_recurring.category_id is null or t.category_id = v_recurring.category_id)
        and t.occurred_at between v_due - 5 and v_due + 5
        and abs(abs(t.amount) - v_amount) <= v_amount * 0.2
      order by abs(t.occurred_at - v_due), t.created_at
      limit 1;
      if v_tx is null then
        insert into public.transactions
          (household_id, account_id, category_id, owner_member_id, is_shared, amount, currency, kind, merchant, note, occurred_at, needs_review)
        values (
          v_recurring.household_id, v_recurring.account_id, v_recurring.category_id, v_recurring.owner_member_id, v_recurring.is_shared,
          -v_amount, 'AED', 'expense', v_recurring.name, 'Autopay, confirmed on Telegram', v_due, false
        )
        returning id into v_tx;
        v_inserted := 1;
      else
        v_inserted := 0;
      end if;
      v_applied := v_applied || jsonb_build_object(
        'recurring_id', v_recurring.id, 'name', v_recurring.name, 'transaction_id', v_tx,
        'amount', v_amount, 'occurred_at', v_due, 'next_due', v_proposal.payload -> 'next_due',
        'already_recorded', v_inserted = 0);
      -- The same question asked of another member is answered now.
      update public.bot_proposals p
      set status = 'expired', decided_at = v_now
      where p.household_id = v_proposal.household_id
        and p.kind = 'autopay_payment'
        and p.status = 'proposed'
        and p.id <> v_proposal.id
        and p.payload ->> 'recurring_id' = v_recurring.id::text
        and p.payload ->> 'due_date' = v_due::text;
    end if;

  elsif v_proposal.kind = 'transfer' then
    v_amount := round((v_proposal.payload ->> 'amount')::numeric, 2);
    v_day := (v_proposal.payload ->> 'occurred_at')::date;
    v_note := nullif(btrim(v_proposal.payload ->> 'note'), '');
    select * into v_from from public.accounts a
    where a.id = (v_proposal.payload ->> 'from_account_id')::uuid and a.household_id = v_proposal.household_id and a.archived_at is null;
    select * into v_to from public.accounts a
    where a.id = (v_proposal.payload ->> 'to_account_id')::uuid and a.household_id = v_proposal.household_id and a.archived_at is null;
    if v_from.id is null or v_to.id is null or v_from.id = v_to.id or v_amount is null or v_amount <= 0 or v_day is null then
      v_skipped := v_skipped || jsonb_build_object('name', v_proposal.payload -> 'from_name', 'reason', 'unavailable');
    else
      -- Recorded already: a transfer between these two accounts, for this
      -- amount, within the four days the app's own matching allows.
      select l.id into v_link
      from public.transaction_links l
      join public.transactions o on o.id = l.from_transaction_id
      join public.transactions i on i.id = l.to_transaction_id
      where l.kind = 'transfer' and l.household_id = v_proposal.household_id
        and o.account_id = v_from.id and i.account_id = v_to.id and i.amount = v_amount
        and o.occurred_at between v_day - 4 and v_day + 4
      limit 1;
      if v_link is not null then
        v_applied := v_applied || jsonb_build_object(
          'from_name', v_from.name, 'to_name', v_to.name, 'amount', v_amount, 'occurred_at', v_day, 'already_recorded', true);
      else
        -- A side already in the ledger as an ordinary record (the card
        -- payment pasted from the bank's SMS as an expense, the money
        -- arriving as income) becomes that side, rather than a second copy of
        -- it. Only a record nothing else is linked to, and never a split one.
        select t.id into v_out from public.transactions t
        where t.household_id = v_proposal.household_id and t.account_id = v_from.id and t.kind = 'expense'
          and t.amount = -v_amount and not t.is_split and t.occurred_at between v_day - 4 and v_day + 4
          and not exists (select 1 from public.transaction_links l where l.from_transaction_id = t.id or l.to_transaction_id = t.id)
        order by abs(t.occurred_at - v_day), t.created_at
        limit 1;
        select t.id into v_in from public.transactions t
        where t.household_id = v_proposal.household_id and t.account_id = v_to.id and t.kind = 'income'
          and t.amount = v_amount and not t.is_split and t.occurred_at between v_day - 4 and v_day + 4
          and not exists (select 1 from public.transaction_links l where l.from_transaction_id = t.id or l.to_transaction_id = t.id)
        order by abs(t.occurred_at - v_day), t.created_at
        limit 1;
        v_joined_out := v_out is not null;
        v_joined_in := v_in is not null;

        if v_joined_out then
          update public.transactions set kind = 'transfer', category_id = null where id = v_out;
          insert into public.transaction_edits (transaction_id, field, old_value, new_value) values (v_out, 'kind', 'Expense', 'Transfer');
        else
          insert into public.transactions (household_id, account_id, amount, currency, kind, note, occurred_at, is_shared, owner_member_id, needs_review)
          values (v_proposal.household_id, v_from.id, -v_amount, 'AED', 'transfer', coalesce(v_note, 'Transfer, confirmed on Telegram'), v_day, true, null, false)
          returning id into v_out;
        end if;
        if v_joined_in then
          update public.transactions set kind = 'transfer', category_id = null where id = v_in;
          insert into public.transaction_edits (transaction_id, field, old_value, new_value) values (v_in, 'kind', 'Income', 'Transfer');
        else
          insert into public.transactions (household_id, account_id, amount, currency, kind, note, occurred_at, is_shared, owner_member_id, needs_review)
          values (v_proposal.household_id, v_to.id, v_amount, 'AED', 'transfer', coalesce(v_note, 'Transfer, confirmed on Telegram'), v_day, true, null, false)
          returning id into v_in;
        end if;
        insert into public.transaction_links (household_id, kind, from_transaction_id, to_transaction_id)
        values (v_proposal.household_id, 'transfer', v_out, v_in);

        v_applied := v_applied || jsonb_build_object(
          'from_name', v_from.name, 'to_name', v_to.name, 'amount', v_amount, 'occurred_at', v_day,
          'joined_out', v_joined_out, 'joined_in', v_joined_in, 'already_recorded', false);
      end if;
    end if;
  end if;

  v_result := jsonb_build_object('kind', v_proposal.kind, 'applied', v_applied, 'skipped', v_skipped);
  update public.bot_proposals
  set status = 'applied', decided_at = v_now, result = v_result
  where id = v_proposal.id;
  return jsonb_build_object('outcome', 'applied') || v_result;
end;
$$;

revoke execute on function apply_bot_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function apply_bot_proposal(uuid, uuid) to service_role;

comment on function apply_bot_proposal(uuid, uuid) is
  'Applies a bot_proposals row once, on the confirming member''s behalf: sets the proposed balances that are still the figure the member was shown, records the goal contribution, records the autopay bill unless it is already recorded, records the transfer (joining a side already in the ledger, and not again if it is recorded), records or undoes a share trade, refused as stale if the holding changed since it was shown, or receives the dividends it asked about, refused as stale if any of them or their fund changed since. A proposal still asking a question cannot be applied. Repeating it returns the first outcome and changes nothing.';

-- ---------------------------------------------------------------------------
-- 4. What a member kept stays kept
-- ---------------------------------------------------------------------------

-- The same function as 20261102181711_dividends, with two answers honoured
-- that it could not see before keep_dividend existed: a split on the ex-date
-- a member kept is not asked about again, and an added dividend a member
-- kept apart from a feed's event no longer stops that event's own dividend
-- from being earned beside it.
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
        if r.review_reason is null and not coalesce((r.review_baseline ->> 'split_kept')::boolean, false) then
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
      and not coalesce(d.review_baseline -> 'not_duplicate_of', '[]'::jsonb) ? e.id::text
    order by abs(coalesce(d.ex_date, d.pay_date) - coalesce(e.ex_date, e.pay_date)), d.id
    limit 1;
    if found then
      if r.review_reason is null then
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
