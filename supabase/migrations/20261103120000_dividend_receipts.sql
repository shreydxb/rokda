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
        v_new.credited_on := coalesce(v_old.pay_date, v_today);
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
            v_new.credited_on := coalesce(v_old.pay_date, v_today);
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
      'version', v_version, 'asks', v_asks, 'warnings', '[]'::jsonb);
  end if;

  if v_asks is not null then
    return jsonb_build_object('ok', false, 'error', 'needs_answer');
  end if;
  if v_action <> 'add' and v_old.version is distinct from p_expected_version then
    return jsonb_build_object('ok', false, 'error', 'stale');
  end if;
  foreach v_key in array coalesce(array(select jsonb_object_keys(v_confirmations)), '{}'::text[]) loop
    if (v_confirmations ->> v_key) is distinct from (coalesce(p_expected_confirmations, '{}'::jsonb) ->> v_key) then
      return jsonb_build_object('ok', false, 'error', 'fund_confirmed_since');
    end if;
  end loop;

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
-- of it, or for the service role the member it names. Evidence and an import
-- reference come only from the service role (the import of credit
-- intimations), never from the app.
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
  if p_dividend_id is null then
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
