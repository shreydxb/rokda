-- Hardening from the outside review of 8 November 2026 (docs/decisions.md,
-- "What the outside review changed"). Each section fixes one finding; the
-- behaviour it guarantees is tested in supabase/test.

-- ---------------------------------------------------------------------------
-- 1. The Telegram link code is kept only as its digest
-- ---------------------------------------------------------------------------

-- Every member can read the household's roster, so a live link code stored
-- there could be read by another member and sent to the bot from their own
-- Telegram, linking it as the code's owner. The roster now holds only the
-- code's SHA-256 (lowercase hex); the caller gets the code itself, and the
-- bot hashes what it receives. The code is random (122 bits), so its digest
-- gives nothing away.
create or replace function public.generate_telegram_link_code(p_member_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_household_id uuid;
  v_self boolean;
begin
  select m.household_id, m.user_id is not distinct from auth.uid() and m.user_id is not null
    into v_household_id, v_self
  from public.household_members m where m.id = p_member_id;
  if v_household_id is null or not private.is_household_member(v_household_id) then
    raise exception 'not a member of this household' using errcode = '42501';
  end if;
  if not v_self and not private.is_household_owner(v_household_id) then
    raise exception 'only an owner can link another member''s Telegram' using errcode = '42501';
  end if;

  v_code := replace(gen_random_uuid()::text, '-', '');

  perform set_config('app.bypass_telegram_link_guard', 'on', true);
  update public.household_members
    set telegram_link_code = encode(sha256(convert_to(v_code, 'UTF8')), 'hex'),
        telegram_link_code_expires_at = now() + interval '15 minutes'
    where id = p_member_id;

  return v_code;
end;
$$;

revoke execute on function public.generate_telegram_link_code(uuid) from public, anon;
grant execute on function public.generate_telegram_link_code(uuid) to authenticated;

comment on function public.generate_telegram_link_code(uuid) is
  'A one-time token to link a member''s Telegram, valid 15 minutes. For the caller''s own member row, or any member of the household if the caller is an owner. The roster keeps only its SHA-256.';
comment on column public.household_members.telegram_link_code is
  'The SHA-256 (hex) of a one-time link code from generate_telegram_link_code(); the bot matches the digest of what it is sent. Cleared on redemption or expiry.';

-- A code issued before this change was stored as itself: it is withdrawn, and
-- a member who had one asks for another.
select set_config('app.bypass_telegram_link_guard', 'on', true);
update public.household_members
  set telegram_link_code = null, telegram_link_code_expires_at = null
  where telegram_link_code is not null;
select set_config('app.bypass_telegram_link_guard', 'off', true);

-- ---------------------------------------------------------------------------
-- 2. A receipt has all its figures or none
-- ---------------------------------------------------------------------------

-- The arithmetic branch evaluated to null when one received figure was null,
-- and a CHECK accepts null, so a "received" row could hold a missing tax or a
-- made-up net. The data imports write through privileged SQL, so the rule
-- has to hold in the table itself, not only in the functions.
alter table public.holding_dividends drop constraint holding_dividends_received_adds_up;
alter table public.holding_dividends add constraint holding_dividends_received_adds_up check (
  (received_gross is null and received_tax is null and received_fees is null and received_net is null)
  or (received_gross is not null and received_tax is not null and received_fees is not null and received_net is not null
      and received_gross >= 0 and received_tax >= 0 and received_fees >= 0
      and received_tax + received_fees <= received_gross
      and received_net = received_gross - received_tax - received_fees));

-- ---------------------------------------------------------------------------
-- 3. A refund record changes only at the version it was opened on
-- ---------------------------------------------------------------------------

-- Two saves of one record were ordered by the return's lock, but nothing told
-- the second that the record had moved: an edit opened before a correction
-- wrote its older figures back over it. Each record now carries a version;
-- a change or a removal names the version it was opened on.
alter table public.tax_return_events add column version integer not null default 1;

drop function public.save_tax_return_event(uuid, integer, jsonb, uuid);
drop function public.remove_tax_return_event(uuid, uuid);

create or replace function public.save_tax_return_event(
  p_member_id uuid, p_financial_year integer, p_event jsonb, p_event_id uuid default null, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.tax_caller(p_member_id);
  v_today date := public.household_today();
  r public.tax_returns%rowtype;
  e public.tax_return_events%rowtype;
  v_kind text;
  v_version integer;
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if jsonb_typeof(p_event) is distinct from 'object' or p_financial_year is null
     or exists (select 1 from jsonb_object_keys(p_event) k where k not in (
       'kind', 'revision', 'happened_on', 'refund_determined', 'refund_interest', 'tds_allowed_total', 'amount', 'note'))
     or jsonb_typeof(p_event -> 'kind') is distinct from 'string' or jsonb_typeof(p_event -> 'happened_on') is distinct from 'string'
     or not private.tax_json_is(p_event -> 'revision', 'number') or not private.tax_json_is(p_event -> 'note', 'string')
     or exists (select 1 from unnest(array['refund_determined', 'refund_interest', 'tds_allowed_total', 'amount']) k
       where not private.tax_json_is(p_event -> k, 'number')) then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  select * into r from public.tax_returns t where t.member_id = p_member_id and t.financial_year = p_financial_year for update;
  if not found or r.revision = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_filed');
  end if;
  -- A change is made at the version it was opened on: the return's lock
  -- orders two saves, and the version tells the second that the record moved.
  if p_event_id is not null then
    select x.version into v_version from public.tax_return_events x where x.id = p_event_id and x.return_id = r.id for update;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'event_not_found');
    end if;
    if p_expected_version is null then
      return jsonb_build_object('ok', false, 'error', 'bad_input');
    end if;
    if v_version <> p_expected_version then
      return jsonb_build_object('ok', false, 'error', 'stale');
    end if;
  end if;

  if exists (select 1 from unnest(array['refund_determined', 'refund_interest', 'tds_allowed_total', 'amount']) k
             where not private.tax_amount_ok(abs((p_event ->> k)::numeric))) then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  begin
    v_kind := p_event ->> 'kind';
    e.revision := coalesce((p_event ->> 'revision')::numeric, r.revision);
    e.happened_on := (p_event ->> 'happened_on')::date;
    e.refund_determined := (p_event ->> 'refund_determined')::numeric;
    e.refund_interest := (p_event ->> 'refund_interest')::numeric;
    e.tds_allowed_total := (p_event ->> 'tds_allowed_total')::numeric;
    e.amount := (p_event ->> 'amount')::numeric;
    e.note := nullif(btrim(p_event ->> 'note'), '');
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end;
  if v_kind not in ('processed', 'refund_credited', 'offset_against_demand', 'refund_failed')
     or (p_event ? 'revision' and (p_event ->> 'revision')::numeric <> e.revision) or e.revision not between 1 and r.revision
     or e.happened_on < make_date(p_financial_year + 1, 4, 1) or length(e.note) > 500 then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  if e.happened_on > v_today then
    return jsonb_build_object('ok', false, 'error', 'in_future');
  end if;
  -- A demand is the one figure below zero.
  if not (private.tax_amount_ok(abs(e.refund_determined)) and private.tax_amount_ok(e.refund_interest)
          and private.tax_amount_ok(e.tds_allowed_total) and private.tax_amount_ok(e.amount))
     or not coalesce(case v_kind
       when 'processed' then e.refund_determined is not null and e.refund_interest is not null and e.amount is null
       when 'refund_failed' then e.refund_determined is null and e.refund_interest is null and e.tds_allowed_total is null
         and (e.amount is null or e.amount > 0)
       else e.refund_determined is null and e.refund_interest is null and e.tds_allowed_total is null and e.amount > 0
     end, false) then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  if private.has_identifier(e.note) then
    return jsonb_build_object('ok', false, 'error', 'identifier_in_text');
  end if;

  if p_event_id is null then
    insert into public.tax_return_events (household_id, return_id, revision, kind, happened_on, refund_determined, refund_interest,
      tds_allowed_total, amount, note, updated_by)
    values (r.household_id, r.id, e.revision, v_kind, e.happened_on, e.refund_determined, e.refund_interest,
      e.tds_allowed_total, e.amount, e.note, (v_caller ->> 'actor')::uuid)
    returning id into e.id;
    v_version := 0;
  else
    e.id := p_event_id;
    update public.tax_return_events
    set revision = e.revision, kind = v_kind, happened_on = e.happened_on, refund_determined = e.refund_determined,
        refund_interest = e.refund_interest, tds_allowed_total = e.tds_allowed_total, amount = e.amount, note = e.note,
        version = version + 1, updated_by = (v_caller ->> 'actor')::uuid
    where id = e.id;
    -- Removed since it was found: a removal committed while this waited.
    if not found then
      return jsonb_build_object('ok', false, 'error', 'event_not_found');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', e.id, 'version', v_version + 1);
end;
$$;

-- Removes something recorded against a member's return, at the version it
-- was opened on: a correction saved since is not removed unseen.
create or replace function public.remove_tax_return_event(p_member_id uuid, p_event_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.tax_caller(p_member_id);
  v_return uuid;
  v_version integer;
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  -- The return first, as save_tax_return_event locks it, then the record.
  select t.id into v_return from public.tax_return_events e join public.tax_returns t on t.id = e.return_id
  where e.id = p_event_id and t.member_id = p_member_id;
  if v_return is null then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;
  perform 1 from public.tax_returns where id = v_return for update;
  select e.version into v_version from public.tax_return_events e where e.id = p_event_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;
  if p_expected_version is null or v_version <> p_expected_version then
    return jsonb_build_object('ok', false, 'error', case when p_expected_version is null then 'bad_input' else 'stale' end);
  end if;
  delete from public.tax_return_events where id = p_event_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.save_tax_return_event(uuid, integer, jsonb, uuid, integer) from public, anon;
revoke execute on function public.remove_tax_return_event(uuid, uuid, integer) from public, anon;
grant execute on function public.save_tax_return_event(uuid, integer, jsonb, uuid, integer) to authenticated, service_role;
grant execute on function public.remove_tax_return_event(uuid, uuid, integer) to authenticated, service_role;
