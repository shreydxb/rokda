-- Earmarks a share of a real account or holding toward a goal, so goal
-- progress can include money that's actually sitting in an FD or an
-- investment (interest/growth included) rather than only manually logged
-- goal_contributions. A single account/holding can back more than one goal
-- (e.g. one FD split 60% Emergency Fund / 40% House) as long as its shares
-- never exceed 100% in total.
create table goal_allocations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  goal_id uuid not null references goals(id) on delete cascade,
  account_id uuid references accounts(id) on delete cascade,
  holding_id uuid references holdings(id) on delete cascade,
  share_pct numeric not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint goal_allocations_one_target check (
    (account_id is not null and holding_id is null) or (account_id is null and holding_id is not null)
  ),
  constraint goal_allocations_share_pct_range check (share_pct > 0 and share_pct <= 100)
);

-- A goal can only link a given account/holding once -- adjust the share on
-- the existing row instead of adding a second one.
create unique index goal_allocations_goal_account_key on goal_allocations (goal_id, account_id) where account_id is not null;
create unique index goal_allocations_goal_holding_key on goal_allocations (goal_id, holding_id) where holding_id is not null;

alter table goal_allocations enable row level security;

create policy "members can read goal allocations"
on goal_allocations for select
using (is_household_member(household_id));

create policy "members can write goal allocations"
on goal_allocations for insert
with check (is_household_member(household_id));

create policy "members can update goal allocations"
on goal_allocations for update
using (is_household_member(household_id));

create policy "members can delete goal allocations"
on goal_allocations for delete
using (is_household_member(household_id));

-- Cross-household safety (a client could otherwise pass a household_id that
-- doesn't match the goal or account/holding it's linking) plus the
-- aggregate "shares can't exceed 100%" rule, which a plain CHECK constraint
-- can't express since it spans multiple rows.
create or replace function guard_goal_allocation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_goal_household uuid;
  v_target_household uuid;
  v_existing_total numeric;
begin
  select household_id into v_goal_household from goals where id = new.goal_id;
  if v_goal_household is null or v_goal_household <> new.household_id then
    raise exception 'goal_id must belong to the same household' using errcode = '23514';
  end if;

  if new.account_id is not null then
    select household_id into v_target_household from accounts where id = new.account_id;
  else
    select household_id into v_target_household from holdings where id = new.holding_id;
  end if;
  if v_target_household is null or v_target_household <> new.household_id then
    raise exception 'linked account/holding must belong to the same household' using errcode = '23514';
  end if;

  select coalesce(sum(share_pct), 0) into v_existing_total
  from goal_allocations
  where id <> new.id
    and account_id is not distinct from new.account_id
    and holding_id is not distinct from new.holding_id;

  if v_existing_total + new.share_pct > 100 then
    raise exception 'allocations for this account/holding would exceed 100%% (already % allocated)', v_existing_total using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger goal_allocations_guard
  before insert or update on goal_allocations
  for each row execute function guard_goal_allocation();

comment on table goal_allocations is 'Earmarks a share (0-100%) of one real account or holding toward one goal. Goal progress = manual goal_contributions + each linked account/holding''s current value * share_pct/100.';
