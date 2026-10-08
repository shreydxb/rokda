-- A bank SMS or receipt with no date is dated the day it was sent to the bot
-- and marked intake.date_guessed (20260929090343_intake_date_guessed.sql).
-- The Inbox and the bot keep such an entry out of a one-word confirm and out
-- of bulk approval, but approve_intake itself would record the guess as the
-- day it was paid: a backlog of pasted SMS approved as read lands on the day
-- it was pasted. approve_intake now refuses a guessed date unless the caller
-- says a person set or confirmed it (p_date_confirmed).
--
-- The new parameter is last and defaults to false, so every existing call --
-- the bot's fast confirm, the Inbox, scripts/verify-concurrency.sh and the
-- tests -- still resolves, and none of them confirms a date by accident. The
-- ten-parameter function is dropped rather than left beside the new one: with
-- both present PostgREST cannot choose between them for a call that leaves
-- the new argument out, and the old one would still approve a guess. The
-- Inbox that sends p_date_confirmed has to ship after this: PostgREST finds
-- no function for a named argument the ten-parameter one does not have.
--
-- Otherwise unchanged from 20260913090000_tenant_qualified_foreign_keys.sql:
-- SECURITY INVOKER, idempotent on an approved row (checked before the date,
-- so a retry still returns its transaction), AED-only, same-household ids
-- only. The intake row keeps date_guessed and parsed_date as the bot wrote
-- them; the transaction carries the day that was confirmed.
drop function if exists approve_intake(uuid, uuid, numeric, date, text, uuid, text, text, boolean, uuid);

create function approve_intake(
  p_intake_id uuid,
  p_account_id uuid,
  p_amount numeric,
  p_occurred_at date,
  p_kind text default 'expense',
  p_category_id uuid default null,
  p_currency text default 'AED',
  p_merchant text default null,
  p_is_shared boolean default true,
  p_owner_member_id uuid default null,
  p_date_confirmed boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_intake intake;
  v_transaction_id uuid;
  v_signed numeric;
begin
  if p_kind not in ('expense', 'income', 'refund') then
    raise exception 'unknown intake kind %', p_kind using errcode = '22023';
  end if;
  if p_account_id is null then
    raise exception 'an account is required' using errcode = '22023';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'an amount is required' using errcode = '22023';
  end if;
  if upper(coalesce(p_currency, 'AED')) <> 'AED' then
    raise exception 'only AED is supported for approval right now' using errcode = 'P0001';
  end if;

  select * into v_intake from intake where id = p_intake_id for update;
  if not found then
    raise exception 'intake row % not found', p_intake_id using errcode = 'P0002';
  end if;

  if v_intake.status = 'approved' then
    return jsonb_build_object('transaction_id', v_intake.transaction_id, 'already_approved', true);
  end if;
  if v_intake.status = 'rejected' then
    raise exception 'intake row % was already rejected', p_intake_id using errcode = 'P0001';
  end if;

  -- The message gave no date, so parsed_date is only the day it reached the
  -- bot. It becomes the day it was paid when a person says so, never by
  -- default. Read from the locked row, so a screen holding an older copy of
  -- the entry cannot approve past it.
  if v_intake.date_guessed and not coalesce(p_date_confirmed, false) then
    raise exception 'the message had no date: set the day it was paid, or confirm the date shown, before approving'
      using errcode = '22023';
  end if;

  -- The intake row's household is the authority. Every id the caller supplied
  -- has to belong to it; none of them may silently pull a row from elsewhere.
  if not exists (select 1 from accounts where id = p_account_id and household_id = v_intake.household_id) then
    raise exception 'account % does not belong to this intake row''s household', p_account_id using errcode = '42501';
  end if;
  if p_category_id is not null
     and not exists (select 1 from categories where id = p_category_id and household_id = v_intake.household_id) then
    raise exception 'category % does not belong to this intake row''s household', p_category_id using errcode = '42501';
  end if;
  if p_owner_member_id is not null
     and not exists (select 1 from household_members where id = p_owner_member_id and household_id = v_intake.household_id) then
    raise exception 'member % does not belong to this intake row''s household', p_owner_member_id using errcode = '42501';
  end if;

  v_signed := case when p_kind = 'expense' then -abs(p_amount) else abs(p_amount) end;

  insert into transactions (
    household_id, account_id, category_id, amount, currency, kind, merchant,
    occurred_at, is_shared, owner_member_id, needs_review, confidence
  )
  values (
    v_intake.household_id, p_account_id, p_category_id, v_signed, 'AED', p_kind,
    nullif(btrim(p_merchant), ''), p_occurred_at, coalesce(p_is_shared, true), p_owner_member_id, false,
    v_intake.confidence
  )
  returning id into v_transaction_id;

  update intake
     set status = 'approved',
         transaction_id = v_transaction_id
   where id = p_intake_id;

  return jsonb_build_object('transaction_id', v_transaction_id, 'already_approved', false);
end;
$$;

comment on function approve_intake is
  'Approves a pending intake row into exactly one transaction, carrying the intake confidence across. Idempotent: an already-approved row returns its existing transaction. AED-only: refuses a non-AED currency rather than storing an unconverted amount as if it were AED. Refuses an account, category or member belonging to a different household than the intake row. Refuses an entry whose date was guessed (intake.date_guessed) unless p_date_confirmed says a person set or confirmed the date.';

-- The old function had no explicit grants and relied on default privileges.
-- Recreating it must not depend on them: the Inbox calls it as
-- authenticated, the bot as service_role.
grant execute on function approve_intake(uuid, uuid, numeric, date, text, uuid, text, text, boolean, uuid, boolean) to authenticated, service_role;

-- PostgREST caches function signatures; make sure it sees the new one now.
notify pgrst, 'reload schema';
