-- Approving an intake row into a transaction discarded intake.confidence
-- entirely, so a transaction that was parsed with real uncertainty looked
-- identical to a manually-entered, fully-confident one everywhere
-- downstream (Activity had nothing to flag it with). This carries the
-- number across so Activity can show a low-confidence/needs-attention badge
-- the same way the design intends.
alter table transactions add column confidence numeric(3, 2) check (confidence between 0 and 1);

create or replace function approve_intake(
  p_intake_id uuid,
  p_account_id uuid,
  p_amount numeric,
  p_occurred_at date,
  p_kind text default 'expense',
  p_category_id uuid default null,
  p_currency text default 'AED',
  p_merchant text default null,
  p_is_shared boolean default true,
  p_owner_member_id uuid default null
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
  'Approves a pending intake row into exactly one transaction, carrying the intake confidence across. Idempotent: an already-approved row returns its existing transaction. AED-only: refuses a non-AED currency rather than storing an unconverted amount as if it were AED.';
