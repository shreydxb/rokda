-- One transaction across several categories (docs/decisions.md, "A
-- transaction can be split across categories"; SHR-233).
--
-- A supermarket receipt of 400 groceries and 100 household goods had to be
-- filed under one of them, so one category read 100 too high and the other
-- 100 too low, in Budget, Insights, Overview and the "running high" alert.
-- A split keeps the one transaction (the money that left the account) and
-- adds its lines: each a category and an amount.
--
-- The database holds the rules, checked at commit so a function can rewrite a
-- transaction's amount and its lines together:
--   * a split transaction has at least two lines, and no category of its own;
--   * its lines add up to its amount, to the cent, each the same direction;
--   * a transfer is never split (it has no category);
--   * a transaction that isn't split has no lines.
-- Scope (Me / Partner) still follows the transaction's own owner. Each line's
-- category decides whose responsibility it is in the household share, as a
-- whole transaction's category does.

alter table transactions add column is_split boolean not null default false;

create table transaction_splits (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  transaction_id uuid not null,
  category_id uuid not null,
  -- Signed like its transaction: negative for an expense's lines.
  amount numeric(14, 2) not null check (amount <> 0),
  created_at timestamptz not null default now(),
  constraint transaction_splits_transaction_fk foreign key (household_id, transaction_id)
    references transactions (household_id, id) on delete cascade,
  constraint transaction_splits_category_fk foreign key (household_id, category_id)
    references categories (household_id, id),
  -- One line per category; two lines in one category are one line.
  constraint transaction_splits_one_line_per_category unique (transaction_id, category_id)
);

create index transaction_splits_household_transaction_idx on transaction_splits (household_id, transaction_id);
create index transaction_splits_household_category_idx on transaction_splits (household_id, category_id);

-- The split rules, for one transaction.
create or replace function check_split(p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx public.transactions;
  v_lines int;
  v_total numeric;
  v_wrong_way int;
begin
  select * into v_tx from public.transactions where id = p_transaction_id;
  if not found then
    return;
  end if;
  select count(*), coalesce(sum(amount), 0), count(*) filter (where sign(amount) <> sign(v_tx.amount))
    into v_lines, v_total, v_wrong_way
  from public.transaction_splits where transaction_id = p_transaction_id;

  if not v_tx.is_split then
    if v_lines > 0 then
      raise exception 'transaction % has split lines but is not split', p_transaction_id using errcode = '23514';
    end if;
    return;
  end if;
  if v_tx.kind = 'transfer' then
    raise exception 'a transfer has no category, so it is never split' using errcode = '23514';
  end if;
  if v_tx.category_id is not null then
    raise exception 'a split transaction''s categories are in its lines, not on the transaction' using errcode = '23514';
  end if;
  if v_lines < 2 then
    raise exception 'a split has at least two lines; transaction % has %', p_transaction_id, v_lines using errcode = '23514';
  end if;
  if v_wrong_way > 0 then
    raise exception 'every line of a split goes the same way as its transaction' using errcode = '23514';
  end if;
  if v_total <> v_tx.amount then
    raise exception 'a split''s lines add up to its amount (% in lines, % on the transaction)', v_total, v_tx.amount using errcode = '23514';
  end if;
end;
$$;

revoke execute on function check_split(uuid) from public, anon, authenticated;

create or replace function check_split_on_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.check_split(new.id);
  return null;
end;
$$;

create or replace function check_split_on_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.check_split(case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end);
  return null;
end;
$$;

revoke execute on function check_split_on_transaction() from public, anon, authenticated;
revoke execute on function check_split_on_line() from public, anon, authenticated;

create constraint trigger transactions_split_rules
  after insert or update on transactions
  deferrable initially deferred
  for each row execute function check_split_on_transaction();

create constraint trigger transaction_splits_rules
  after insert or update or delete on transaction_splits
  deferrable initially deferred
  for each row execute function check_split_on_line();

alter table transaction_splits enable row level security;

create policy "members can read split lines" on transaction_splits
  for select using (private.is_household_member(household_id));
create policy "members can add split lines" on transaction_splits
  for insert with check (private.is_household_member(household_id));
create policy "members can remove split lines" on transaction_splits
  for delete using (private.is_household_member(household_id));

comment on table transaction_splits is
  'The categories one transaction is split across: each line a category and an amount, signed like the transaction. The lines of a split transaction add up to its amount; the rules are checked at commit.';
comment on column transactions.is_split is
  'True when the transaction''s categories are its lines in transaction_splits (and its own category_id is null).';

-- Writing splits. Each runs as the caller (SECURITY INVOKER), so row-level
-- security decides what it may touch, and changes the amount and the lines
-- together.

-- Splits a transaction, or re-splits one, into the lines given: a JSON array
-- of {"category_id": ..., "amount": ...} with positive amounts, signed here to
-- match the transaction. p_amount, when given, is the transaction's new
-- amount (positive), so an edit to the total and its lines lands as one.
create or replace function split_transaction(p_transaction_id uuid, p_lines jsonb, p_amount numeric default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tx transactions;
  v_sign int;
  v_line jsonb;
  v_before text;
  v_after text;
begin
  select * into v_tx from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'transaction % not found', p_transaction_id using errcode = 'P0002';
  end if;
  if v_tx.kind = 'transfer' then
    raise exception 'a transfer has no category, so it is never split' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'a split needs at least two lines' using errcode = '22023';
  end if;
  v_sign := case when v_tx.kind = 'expense' then -1 else 1 end;

  select coalesce(string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name), (select name from categories where id = v_tx.category_id))
    into v_before
  from transaction_splits s join categories c on c.id = s.category_id
  where s.transaction_id = p_transaction_id;

  delete from transaction_splits where transaction_id = p_transaction_id;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if coalesce((v_line ->> 'amount')::numeric, 0) <= 0 or v_line ->> 'category_id' is null then
      raise exception 'each line needs a category and an amount above zero' using errcode = '22023';
    end if;
    insert into transaction_splits (household_id, transaction_id, category_id, amount)
    values (v_tx.household_id, p_transaction_id, (v_line ->> 'category_id')::uuid, v_sign * round((v_line ->> 'amount')::numeric, 2));
  end loop;

  update transactions
     set is_split = true,
         category_id = null,
         amount = case when p_amount is null then amount else v_sign * round(abs(p_amount), 2) end
   where id = p_transaction_id;

  select string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name)
    into v_after
  from transaction_splits s join categories c on c.id = s.category_id
  where s.transaction_id = p_transaction_id;

  if v_before is distinct from v_after then
    insert into transaction_edits (transaction_id, field, old_value, new_value)
    values (p_transaction_id, 'category', coalesce(v_before, 'Uncategorised'), 'Split: ' || v_after);
  end if;
end;
$$;

-- One category again: the lines go, and the transaction takes the category
-- given (or none).
create or replace function unsplit_transaction(p_transaction_id uuid, p_category_id uuid default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tx transactions;
  v_before text;
begin
  select * into v_tx from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'transaction % not found', p_transaction_id using errcode = 'P0002';
  end if;
  if not v_tx.is_split then
    return;
  end if;
  select string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name)
    into v_before
  from transaction_splits s join categories c on c.id = s.category_id
  where s.transaction_id = p_transaction_id;

  delete from transaction_splits where transaction_id = p_transaction_id;
  update transactions set is_split = false, category_id = p_category_id where id = p_transaction_id;

  insert into transaction_edits (transaction_id, field, old_value, new_value)
  values (p_transaction_id, 'category', 'Split: ' || v_before,
          coalesce((select name from categories where id = p_category_id), 'Uncategorised'));
end;
$$;

revoke execute on function split_transaction(uuid, jsonb, numeric) from public, anon;
revoke execute on function unsplit_transaction(uuid, uuid) from public, anon;
grant execute on function split_transaction(uuid, jsonb, numeric) to authenticated;
grant execute on function unsplit_transaction(uuid, uuid) to authenticated;
