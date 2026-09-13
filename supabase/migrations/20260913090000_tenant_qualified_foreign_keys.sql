-- Make cross-household references structurally impossible (QA re-run §7).
--
-- The 10 September QA pass ran 25 integrity checks against production and
-- every one came back clean. That is worth less than it sounds: production
-- holds exactly one household, so no cross-household check in that list was
-- capable of failing. The database was not proven correct; it was never asked
-- a hard question.
--
-- Nothing in Postgres stopped a transaction in household A from pointing at an
-- account, category or member of household B. Every reference was a plain
-- single-column foreign key to a primary key, which proves the row exists and
-- says nothing about whose it is. RLS did not close the gap either: the
-- policies test the row's OWN household_id, so a row with a correct
-- household_id and a foreign account_id satisfies them. The only thing keeping
-- the ledger clean was application code getting it right every time.
--
-- The fix is the standard tenant-qualified key: every household-scoped parent
-- gets a `unique (household_id, id)`, and every reference from one
-- household-scoped table to another becomes a composite foreign key carrying
-- household_id through. A child row can then only reference a parent in its
-- own household, enforced by the database on every write, including writes
-- that never go through the application.
--
-- Two details this turns on:
--
-- MATCH SIMPLE (the default) is what makes optional references still work. A
-- composite foreign key with any NULL column is not checked, so a nullable
-- account_id stays nullable and means "unset" exactly as before. MATCH FULL
-- would demand all-or-nothing across the pair and break every optional
-- reference here, so it is deliberately not used.
--
-- ON DELETE SET NULL (column) -- the parenthesised column list -- is required,
-- not stylistic. A bare SET NULL on a composite key nulls EVERY column in it,
-- household_id included, and household_id is NOT NULL on all of these tables:
-- deleting a member would fail with a not-null violation instead of clearing
-- the reference. Naming the column nulls only that one. This syntax needs
-- PostgreSQL 15 or newer (production is 17).
--
-- Scope: the 21 references where BOTH sides carry a household_id, so there are
-- two values to compare. Tables that inherit tenancy through a single parent
-- and hold no household_id of their own (credit_card_nudges, goal_contributions,
-- holding_value_history, recurring_nudges) cannot contradict anything and are
-- left alone. transaction_edits is the one real exception and is NOT fixed
-- here: it has no household_id, so its edited_by/transaction_id pair could in
-- principle disagree. That needs a column added before it can be constrained,
-- which is a separate change rather than something to bury in this one.

-- 1. Tenant-qualified keys on every parent a household-scoped row can point at.
--
-- Redundant on its own -- id is already unique by itself -- but a composite
-- foreign key can only reference a uniquely-constrained column pair, so this
-- is what makes the rest of the file possible.
alter table accounts          add constraint accounts_household_id_id_key          unique (household_id, id);
alter table categories        add constraint categories_household_id_id_key        unique (household_id, id);
alter table goals             add constraint goals_household_id_id_key             unique (household_id, id);
alter table holdings          add constraint holdings_household_id_id_key          unique (household_id, id);
alter table household_members add constraint household_members_household_id_id_key unique (household_id, id);
alter table transactions      add constraint transactions_household_id_id_key      unique (household_id, id);

-- 2. Every household-scoped reference, re-pointed through household_id.
--
-- Each constraint keeps the name and the ON DELETE behaviour it had before, so
-- this changes what the database REFUSES and nothing about what it does on a
-- legitimate delete.

-- accounts -> household_members
alter table accounts
  drop constraint accounts_owner_member_id_fkey,
  add constraint accounts_owner_member_id_fkey
    foreign key (household_id, owner_member_id) references household_members (household_id, id) on delete set null (owner_member_id);

-- budget_alert_nudges -> categories
alter table budget_alert_nudges
  drop constraint budget_alert_nudges_category_id_fkey,
  add constraint budget_alert_nudges_category_id_fkey
    foreign key (household_id, category_id) references categories (household_id, id) on delete cascade;

-- budgets -> categories
alter table budgets
  drop constraint budgets_category_id_fkey,
  add constraint budgets_category_id_fkey
    foreign key (household_id, category_id) references categories (household_id, id) on delete cascade;

-- categories -> categories (a subcategory's parent must be in the same household)
alter table categories
  drop constraint categories_parent_id_fkey,
  add constraint categories_parent_id_fkey
    foreign key (household_id, parent_id) references categories (household_id, id) on delete set null (parent_id);

-- category_rules -> categories
alter table category_rules
  drop constraint category_rules_category_id_fkey,
  add constraint category_rules_category_id_fkey
    foreign key (household_id, category_id) references categories (household_id, id) on delete cascade;

-- debts -> household_members
alter table debts
  drop constraint debts_owner_member_id_fkey,
  add constraint debts_owner_member_id_fkey
    foreign key (household_id, owner_member_id) references household_members (household_id, id) on delete set null (owner_member_id);

-- goal_allocations -> accounts / goals / holdings
alter table goal_allocations
  drop constraint goal_allocations_account_id_fkey,
  add constraint goal_allocations_account_id_fkey
    foreign key (household_id, account_id) references accounts (household_id, id) on delete cascade;

alter table goal_allocations
  drop constraint goal_allocations_goal_id_fkey,
  add constraint goal_allocations_goal_id_fkey
    foreign key (household_id, goal_id) references goals (household_id, id) on delete cascade;

alter table goal_allocations
  drop constraint goal_allocations_holding_id_fkey,
  add constraint goal_allocations_holding_id_fkey
    foreign key (household_id, holding_id) references holdings (household_id, id) on delete cascade;

-- goals -> household_members
alter table goals
  drop constraint goals_owner_member_id_fkey,
  add constraint goals_owner_member_id_fkey
    foreign key (household_id, owner_member_id) references household_members (household_id, id) on delete set null (owner_member_id);

-- holdings -> household_members
alter table holdings
  drop constraint holdings_owner_member_id_fkey,
  add constraint holdings_owner_member_id_fkey
    foreign key (household_id, owner_member_id) references household_members (household_id, id) on delete set null (owner_member_id);

-- intake -> household_members / accounts / categories / transactions
--
-- These four are exactly the parameters approve_intake() takes, and the reason
-- this migration exists: that function combined caller-supplied ids with the
-- intake row's own household_id and never checked they agreed.
alter table intake
  drop constraint intake_member_id_fkey,
  add constraint intake_member_id_fkey
    foreign key (household_id, member_id) references household_members (household_id, id) on delete set null (member_id);

alter table intake
  drop constraint intake_parsed_account_id_fkey,
  add constraint intake_parsed_account_id_fkey
    foreign key (household_id, parsed_account_id) references accounts (household_id, id) on delete set null (parsed_account_id);

alter table intake
  drop constraint intake_parsed_category_id_fkey,
  add constraint intake_parsed_category_id_fkey
    foreign key (household_id, parsed_category_id) references categories (household_id, id) on delete set null (parsed_category_id);

alter table intake
  drop constraint intake_transaction_id_fkey,
  add constraint intake_transaction_id_fkey
    foreign key (household_id, transaction_id) references transactions (household_id, id) on delete set null (transaction_id);

-- recurring -> accounts / categories / household_members
alter table recurring
  drop constraint recurring_account_id_fkey,
  add constraint recurring_account_id_fkey
    foreign key (household_id, account_id) references accounts (household_id, id) on delete set null (account_id);

alter table recurring
  drop constraint recurring_category_id_fkey,
  add constraint recurring_category_id_fkey
    foreign key (household_id, category_id) references categories (household_id, id) on delete set null (category_id);

alter table recurring
  drop constraint recurring_owner_member_id_fkey,
  add constraint recurring_owner_member_id_fkey
    foreign key (household_id, owner_member_id) references household_members (household_id, id) on delete set null (owner_member_id);

-- transactions -> accounts / categories / household_members
--
-- account_id keeps NO ACTION: an account with history is archived, never
-- deleted out from under its transactions (SHR-242 / QA-01).
alter table transactions
  drop constraint transactions_account_id_fkey,
  add constraint transactions_account_id_fkey
    foreign key (household_id, account_id) references accounts (household_id, id);

alter table transactions
  drop constraint transactions_category_id_fkey,
  add constraint transactions_category_id_fkey
    foreign key (household_id, category_id) references categories (household_id, id) on delete set null (category_id);

alter table transactions
  drop constraint transactions_owner_member_id_fkey,
  add constraint transactions_owner_member_id_fkey
    foreign key (household_id, owner_member_id) references household_members (household_id, id) on delete set null (owner_member_id);

-- 3. Covering indexes for the new composite keys.
--
-- Postgres does not index the referencing side of a foreign key for you, and
-- without one every delete of a parent row seq-scans each child table to
-- enforce the constraint. These also answer the performance advisor's
-- "unindexed foreign keys" finding, since the foreign key columns are now
-- exactly these pairs.
--
-- budget_alert_nudges and budgets are deliberately absent: their existing
-- primary key and unique constraint already lead with (household_id,
-- category_id), which covers the new key without a second index.
create index if not exists accounts_household_owner_idx           on accounts          (household_id, owner_member_id);
create index if not exists categories_household_parent_idx        on categories        (household_id, parent_id);
create index if not exists category_rules_household_category_idx  on category_rules    (household_id, category_id);
create index if not exists debts_household_owner_idx              on debts             (household_id, owner_member_id);
create index if not exists goal_allocations_household_account_idx on goal_allocations  (household_id, account_id);
create index if not exists goal_allocations_household_goal_idx    on goal_allocations  (household_id, goal_id);
create index if not exists goal_allocations_household_holding_idx on goal_allocations  (household_id, holding_id);
create index if not exists goals_household_owner_idx              on goals             (household_id, owner_member_id);
create index if not exists holdings_household_owner_idx           on holdings          (household_id, owner_member_id);
create index if not exists intake_household_member_idx            on intake            (household_id, member_id);
create index if not exists intake_household_account_idx           on intake            (household_id, parsed_account_id);
create index if not exists intake_household_category_idx          on intake            (household_id, parsed_category_id);
create index if not exists intake_household_transaction_idx       on intake            (household_id, transaction_id);
create index if not exists recurring_household_account_idx        on recurring         (household_id, account_id);
create index if not exists recurring_household_category_idx       on recurring         (household_id, category_id);
create index if not exists recurring_household_owner_idx          on recurring         (household_id, owner_member_id);
create index if not exists transactions_household_account_idx     on transactions      (household_id, account_id);
create index if not exists transactions_household_category_idx    on transactions      (household_id, category_id);
create index if not exists transactions_household_owner_idx       on transactions      (household_id, owner_member_id);

-- 4. approve_intake(): say what is wrong, instead of letting a constraint say it.
--
-- The constraints above already make a cross-household approval impossible, so
-- this is not the security boundary -- it is the error message. Without it the
-- caller gets a foreign-key violation naming a constraint, which tells a
-- client nothing it can act on. These checks name the offending parameter and
-- fail before anything is written.
--
-- Unchanged from the previous definition apart from the three checks: still
-- SECURITY INVOKER, still idempotent on an already-approved row, still
-- AED-only.
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
  'Approves a pending intake row into exactly one transaction, carrying the intake confidence across. Idempotent: an already-approved row returns its existing transaction. AED-only: refuses a non-AED currency rather than storing an unconverted amount as if it were AED. Refuses an account, category or member belonging to a different household than the intake row.';
