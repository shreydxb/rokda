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

-- ---------------------------------------------------------------------------
-- 4. A "yes" to the bot: one holding, one transfer, the account it named
-- ---------------------------------------------------------------------------

-- apply_bot_proposal as before, with three changes from the outside review:
-- a first buy takes turns on its household, owner and name (C-02/D-04); a
-- transfer locks its two accounts before looking for a duplicate (D-03); and
-- an autopay "yes" records only if the bill still has the account and
-- category its question named and is still on autopay (D-05).
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
    -- Two first buys of one stock confirmed at once (by two members, or two
    -- questions) each found no holding and made one. They now take turns on
    -- the household, owner and name, so the second finds the first's holding
    -- below and is stale (the outside review, C-02/D-04).
    if v_proposal.payload ? 'new_holding' then
      perform pg_advisory_xact_lock(hashtextextended('new_holding:' || v_proposal.household_id || ':'
        || coalesce(v_proposal.payload -> 'new_holding' ->> 'owner_member_id', '') || ':'
        || lower(btrim(v_proposal.payload -> 'new_holding' ->> 'name')), 0));
    end if;
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
    elsif (v_proposal.payload ? 'account_id' and v_recurring.account_id::text is distinct from v_proposal.payload ->> 'account_id')
       or (v_proposal.payload ? 'account_id' and v_recurring.category_id::text is distinct from v_proposal.payload ->> 'category_id')
       or v_recurring.active is false or v_recurring.autopay is not true then
      -- Changed since it was asked: another account or category, or no
      -- longer on autopay. The "yes" was to the question as shown, so nothing
      -- is recorded (the outside review, D-05). A question saved before the
      -- account was kept with it (no account_id) is checked as before.
      -- Left open rather than decided: the morning check asks again about
      -- the bill as it is now, and that question's "yes" records it. Deciding
      -- it here left the cycle unasked, and the payment unrecorded, after the
      -- likeliest reason for the change: the question named the wrong account.
      return jsonb_build_object('outcome', 'changed', 'kind', v_proposal.kind, 'applied', '[]'::jsonb,
        'skipped', jsonb_build_array(jsonb_build_object('recurring_id', v_recurring.id, 'name', v_recurring.name, 'reason', 'changed')));
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
    -- Two members confirming the same transfer at once each found none and
    -- recorded one. Locking both accounts, always in the same order, makes
    -- the second wait and then find the first's (the outside review, D-03).
    perform 1 from public.accounts a
    where a.household_id = v_proposal.household_id
      and a.id in ((v_proposal.payload ->> 'from_account_id')::uuid, (v_proposal.payload ->> 'to_account_id')::uuid)
    order by a.id
    for update;
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

-- ---------------------------------------------------------------------------
-- 5. "Not yet" puts off the question and its dividends together
-- ---------------------------------------------------------------------------

-- The bot cancelled the question and then, in a separate call it never
-- checked, cleared the dividends' asked marks. If that second call failed,
-- the bot still promised to ask tomorrow, but the morning check skips a
-- dividend still marked asked, so it never did (the outside review, D-08).
-- Both now happen in one transaction, or neither.
create or replace function public.postpone_dividends_proposal(p_proposal_id uuid, p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.bot_proposals%rowtype;
begin
  select * into v_proposal from public.bot_proposals where id = p_proposal_id and kind = 'dividends_received' for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;
  if v_proposal.member_id is distinct from p_member_id then
    return jsonb_build_object('ok', false, 'status', 'not_yours');
  end if;
  if v_proposal.status <> 'proposed' then
    return jsonb_build_object('ok', false, 'status', v_proposal.status, 'result', v_proposal.result);
  end if;
  update public.bot_proposals
  set status = 'cancelled', decided_at = now(), result = jsonb_build_object('kind', 'dividends_received', 'not_yet', true)
  where id = v_proposal.id;
  update public.holding_dividends d
  set asked_at = null
  where d.household_id = v_proposal.household_id
    and d.id in (select (l ->> 'dividend_id')::uuid from jsonb_array_elements(v_proposal.payload -> 'lines') l);
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.postpone_dividends_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.postpone_dividends_proposal(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. A bare answer delivered again answers what it first meant
-- ---------------------------------------------------------------------------
-- A bare "yes" or "no" names nothing, so the bot resolves it against whatever
-- is waiting. If the reply after acting failed, Telegram delivered the answer
-- again, and by then a question asked or an entry captured in the meantime
-- could be what it resolved to, saved without the member answering it. The
-- bot now records the target with the update before acting, and a redelivery
-- answers that target. A reply or a reaction names its message, so only bare
-- answers are recorded.
alter table public.telegram_update_log
  add column answer_target jsonb,
  add constraint telegram_update_log_answer_target_shape check (
    answer_target is null or coalesce(
      jsonb_typeof(answer_target) = 'object'
      and answer_target ->> 'kind' in ('proposal', 'intake')
      and (answer_target ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      false)
  );

comment on column public.telegram_update_log.answer_target is
  'What a bare "yes" or "no" in this update resolved to, recorded before the bot acted on it: {"kind": "proposal" | "intake", "id": uuid}. A redelivery of the update answers this, not whatever is waiting by then. Null for every other update.';
