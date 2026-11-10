-- Round 2 of the outside review (November 2026; docs/decisions.md, "What the
-- outside review changed", Round 2). Each section fixes one finding; the
-- behaviour it guarantees is tested in supabase/test (R2-01 to R2-05).

-- ---------------------------------------------------------------------------
-- A number, not NaN or infinity
-- ---------------------------------------------------------------------------

-- Postgres's numeric takes 'NaN' (greater than every number and equal to
-- itself, so it passes every "not negative" check) and, unconstrained,
-- 'Infinity'. Neither is money.
create or replace function private.is_finite_number(p numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is null or p not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric);
$$;

revoke all on function private.is_finite_number(numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Dividends: a retried add is recorded once; figures are numbers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.dividend_change(p_dividend_id uuid, p_change jsonb, p_member uuid, p_save boolean, p_expected_version integer, p_expected_confirmations jsonb, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      (p_change ->> 'holding_id')::uuid, (p_change ->> 'id')::uuid;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end;
  -- NaN and infinity are valid numerics, and NaN passes every "not
  -- negative" check, so a figure that is not a number is refused before it
  -- can reach a fund (round 2 of the outside review).
  if not (private.is_finite_number((p_change ->> 'units')::numeric) and private.is_finite_number((p_change ->> 'per_share')::numeric)
     and private.is_finite_number((p_change ->> 'tax_pct')::numeric) and private.is_finite_number((p_change ->> 'expected_fees')::numeric)
     and private.is_finite_number((p_change ->> 'received_gross')::numeric) and private.is_finite_number((p_change ->> 'received_tax')::numeric)
     and private.is_finite_number((p_change ->> 'received_fees')::numeric)) then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
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
    -- The app names a dividend it adds, once, when its form opens, so a save
    -- sent again (a retry after a lost response) finds the first instead of
    -- recording it twice. With no ex-date nothing else told them apart
    -- (round 2 of the outside review).
    if p_change ? 'id' then
      select d.id into v_existing from public.holding_dividends d
      where d.id = (p_change ->> 'id')::uuid and d.household_id = v_h.household_id and d.holding_id = v_h.id;
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
    v_new.id := coalesce((p_change ->> 'id')::uuid, gen_random_uuid());
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
$function$;

-- A receipt moves its fund by whole cents, so a correction's difference is
-- exact: 1.0049 corrected to 1.0051 moved nothing, and skipping it then took
-- 1.01 back.
CREATE OR REPLACE FUNCTION private.dividend_contribution(p_status text, p_net numeric, p_credited_on date, p_credited_at timestamp with time zone, p_account_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce((
    select case
      when p_status = 'received' and a.type = 'broker_funds'
        and private.trade_moves_fund(a.balance_as_of, p_credited_on, p_credited_at) then round(p_net, 2)
      else 0 end
    from public.accounts a where a.id = p_account_id), 0);
$function$;

-- ---------------------------------------------------------------------------
-- Trades: figures are numbers; a deleted trade gives back the cents it moved
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.trade_effect(p_holding public.holdings, p_kind text, p_trade_date date, p_units numeric, p_price numeric, p_fees numeric, p_tax_withheld numeric, p_traded_at timestamp with time zone, p_funds_account_id uuid, p_replace_trade_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
     or not (private.is_finite_number(v_units) and private.is_finite_number(v_price) and private.is_finite_number(v_fees) and private.is_finite_number(v_tax))
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
$function$;

CREATE OR REPLACE FUNCTION public.delete_trade(p_trade_id uuid, p_expected_version integer, p_member_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      -- The cents the trade moved, not its four-place cash: a sale at 1.005
      -- moved 1.01 and gave back 1.005, leaving a fils behind (round 2 of the
      -- outside review).
      v_delta := -round(v_trade.cash_amount, 2);
      perform private.move_fund(v_fund.id, v_delta, v_source, v_member);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'trade_id', v_trade.id, 'trades_version', v_holding.trades_version + 1,
    'holding_units_after', v_result -> 'units', 'holding_avg_after', v_result -> 'avg',
    'funds_account_id', v_trade.funds_account_id, 'funds_delta', v_delta);
end;
$function$;

CREATE OR REPLACE FUNCTION private.move_fund(p_fund_id uuid, p_delta numeric, p_source text, p_member_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_fund_id is null or p_delta is null or p_delta = 0 then
    return;
  end if;
  -- Every fund move passes here, so a figure that is not a number stops here
  -- whatever let it through (round 2 of the outside review).
  if not private.is_finite_number(p_delta) then
    raise exception 'a fund cannot move by %', p_delta using errcode = '22023';
  end if;
  perform set_config('rokda.balance_source', case when p_source = 'app' then 'app' else 'bot' end, true);
  perform set_config('rokda.balance_member', p_member_id::text, true);
  update public.accounts set balance = balance + p_delta where id = p_fund_id;
  perform set_config('rokda.balance_source', '', true);
  perform set_config('rokda.balance_member', '', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- A holding with received dividends is not deleted
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.guard_traded_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from public.households h where h.id = old.household_id) then
    return old;
  end if;
  if exists (select 1 from public.holding_trades t where t.holding_id = old.id and t.kind in ('buy', 'sell')) then
    raise exception 'a holding with buys or sales cannot be deleted; delete its trades first'
      using errcode = 'check_violation';
  end if;
  -- A received dividend moved money and is a tax record; deleting the holding
  -- cascaded it away, and recording it again moved the money twice (round 2
  -- of the outside review).
  if exists (select 1 from public.holding_dividends d where d.holding_id = old.id and d.status in ('received', 'presumed')) then
    raise exception 'a holding with received dividends cannot be deleted; skip them first'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The bot reads its webhook secret by an explicit grant
-- ---------------------------------------------------------------------------

-- Production relied on Supabase's default privileges for this; a rebuild on
-- plain Postgres left the bot unable to read it, so it refused every update.
-- get_scheduler_secret() already has the same grant.
grant execute on function public.get_telegram_webhook_secret() to service_role;
