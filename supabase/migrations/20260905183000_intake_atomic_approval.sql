-- QA-11 (SHR-252): Inbox approval was neither atomic nor idempotent.
--
-- Approval inserted a transaction and then, in a separate round trip, updated
-- the intake row. If the second step failed — or the response was lost — a
-- retry inserted a second transaction. Two reviewers approving at once did the
-- same. Nothing linked an intake row to the transaction it produced, and
-- nothing stopped the same source message arriving twice.

-- What the approval produced. Also the idempotency key: an approved row
-- already names its transaction, so a retry returns that instead of writing.
alter table intake add column transaction_id uuid references transactions(id) on delete set null;

-- The identity of the message this row came from (a Telegram update id, say).
-- Delivery retries carry the same one, so they cannot enqueue twice.
alter table intake add column source_ref text;

create unique index intake_source_ref_key
  on intake (household_id, source, source_ref)
  where source_ref is not null;

create unique index intake_transaction_id_key
  on intake (transaction_id)
  where transaction_id is not null;

comment on column intake.transaction_id is
  'The transaction this intake row was approved into. Null while pending or rejected.';
comment on column intake.source_ref is
  'Stable identifier from the source system (e.g. a Telegram update id), so a delivery retry cannot create a second intake row.';

-- Approve exactly once, in one transaction.
--
-- SECURITY INVOKER, so row-level security still applies to the caller: this
-- adds atomicity, not privilege. `for update` serialises two reviewers — the
-- second waits, then sees the row already approved and returns the existing
-- transaction rather than writing a second one.
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

  select * into v_intake from intake where id = p_intake_id for update;
  if not found then
    raise exception 'intake row % not found', p_intake_id using errcode = 'P0002';
  end if;

  -- Already done: return what was written. This is what makes a retry, a lost
  -- response, and a simultaneous approval all yield exactly one transaction.
  if v_intake.status = 'approved' then
    return jsonb_build_object('transaction_id', v_intake.transaction_id, 'already_approved', true);
  end if;
  if v_intake.status = 'rejected' then
    raise exception 'intake row % was already rejected', p_intake_id using errcode = 'P0001';
  end if;

  -- Money movement is explicit rather than inferred from a sign: an expense
  -- leaves, income and a refund arrive.
  v_signed := case when p_kind = 'expense' then -abs(p_amount) else abs(p_amount) end;

  insert into transactions (
    household_id, account_id, category_id, amount, currency, merchant,
    occurred_at, is_shared, owner_member_id, needs_review
  )
  values (
    v_intake.household_id, p_account_id, p_category_id, v_signed, coalesce(p_currency, 'AED'),
    nullif(btrim(p_merchant), ''), p_occurred_at, coalesce(p_is_shared, true), p_owner_member_id, false
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
  'Approves a pending intake row into exactly one transaction. Idempotent: an already-approved row returns its existing transaction.';
