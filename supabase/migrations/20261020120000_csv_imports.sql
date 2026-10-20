-- Statement imports from a CSV file (SHR-302; docs/decisions.md, "A
-- statement is imported in one reviewed batch").
--
-- A bank or card statement exported as CSV is read in the browser, mapped and
-- reviewed there, and committed here in one transaction: every row the person
-- kept, or none. Each batch is remembered, with the statement's period and
-- balances when they were given, so it can be undone and so a re-import of
-- the same file adds nothing.
--
-- Idempotency rests on transactions.import_key: a key the app derives from the
-- row itself (date, amount, description, and how many identical rows came
-- before it in the file). It is unique per account, so the same statement
-- imported twice, by two people at once or after a failed attempt, inserts
-- each row once. The key outlives the batch on purpose: undoing a batch
-- deletes its rows, and with them their keys, so they can be imported again.

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  account_id uuid not null,
  file_name text not null check (char_length(btrim(file_name)) between 1 and 200),
  -- Rows in the file, rows inserted, and rows not inserted: left out in the
  -- review, or already imported before.
  row_count integer not null check (row_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  -- What the statement itself says, when the person entered it: the period it
  -- covers and the balances at its start and end, for reconciliation.
  period_start date,
  period_end date,
  statement_opening numeric(14, 2),
  statement_closing numeric(14, 2),
  status text not null default 'committed' check (status in ('committed', 'undone')),
  created_by uuid,
  created_at timestamptz not null default now(),
  undone_by uuid,
  undone_at timestamptz,
  -- Rows an undo left in place because someone had changed them since, or
  -- joined them to a record outside the batch.
  kept_on_undo integer check (kept_on_undo is null or kept_on_undo >= 0),
  constraint import_batches_household_id_id_key unique (household_id, id),
  constraint import_batches_period check (period_start is null or period_end is null or period_start <= period_end),
  constraint import_batches_undone check ((status = 'undone') = (undone_at is not null)),
  constraint import_batches_account_fk foreign key (household_id, account_id)
    references accounts (household_id, id) on delete cascade,
  constraint import_batches_created_by_fk foreign key (household_id, created_by)
    references household_members (household_id, id) on delete set null (created_by),
  constraint import_batches_undone_by_fk foreign key (household_id, undone_by)
    references household_members (household_id, id) on delete set null (undone_by)
);

create index import_batches_household_account_idx on import_batches (household_id, account_id);
create index import_batches_household_created_by_idx on import_batches (household_id, created_by);
create index import_batches_household_undone_by_idx on import_batches (household_id, undone_by);

comment on table import_batches is
  'One row per statement imported from a CSV file: its account, file name, counts, the period and balances the statement gave, and whether it has been undone. commit_import creates it; undo_import closes it.';

alter table import_batches enable row level security;

-- Members read their household's imports. Writes go through commit_import and
-- undo_import, which run as the caller, so the same membership test applies;
-- nothing deletes a batch, so the record of an import survives its undo.
create policy "members can read import batches" on import_batches
  for select using (private.is_household_member(household_id));
create policy "members can add import batches" on import_batches
  for insert with check (private.is_household_member(household_id));
create policy "members can update import batches" on import_batches
  for update using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- Who imported is the signed-in member, never what the client says.
create or replace function set_import_batch_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select m.id into new.created_by
  from public.household_members m
  where m.household_id = new.household_id and m.user_id = auth.uid()
  limit 1;
  return new;
end;
$$;

revoke execute on function set_import_batch_author() from public, anon, authenticated;

create trigger import_batches_set_author
  before insert on import_batches
  for each row execute function set_import_batch_author();

alter table transactions
  add column import_batch_id uuid,
  add column import_key text check (import_key is null or char_length(import_key) between 1 and 300),
  add constraint transactions_import_batch_fk foreign key (household_id, import_batch_id)
    references import_batches (household_id, id) on delete set null (import_batch_id);

create index transactions_household_import_batch_idx on transactions (household_id, import_batch_id);
create unique index transactions_account_import_key_idx on transactions (account_id, import_key) where import_key is not null;

comment on column transactions.import_batch_id is
  'The CSV import that added this record, if one did (import_batches).';
comment on column transactions.import_key is
  'Identifies the statement row this record was imported from, unique per account, so importing the same statement again adds nothing.';

-- One reviewed statement, committed together.
--
-- p_rows is the rows the person kept, each an object:
--   occurred_at   the day, yyyy-mm-dd
--   amount        AED, signed: negative money out, positive money in
--   kind          expense | income | refund | transfer
--   merchant      the statement's description
--   import_key    see above; required
--   category_id   optional
--   currency, native_amount, aed_estimated
--                 for an account in another currency: the amount as the
--                 statement gave it, and whether the AED is an estimate
--   other_account_id     a transfer's other account
--   pair_transaction_id  a transfer's other side, when it is already recorded
--
-- A transfer whose other side is already recorded is joined to it
-- (link_transfer); otherwise its other side is added on the other account and
-- belongs to the batch too. A row already imported is skipped and counted.
create or replace function commit_import(
  p_household_id uuid,
  p_account_id uuid,
  p_file_name text,
  p_rows jsonb,
  p_row_count integer,
  p_period_start date default null,
  p_period_end date default null,
  p_statement_opening numeric default null,
  p_statement_closing numeric default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_account accounts;
  v_batch uuid;
  v_row jsonb;
  v_kind text;
  v_amount numeric;
  v_id uuid;
  v_other uuid;
  v_imported integer := 0;
  v_already integer := 0;
begin
  select * into v_account from accounts where id = p_account_id and household_id = p_household_id;
  if not found then
    raise exception 'the account must belong to this household' using errcode = '42501';
  end if;
  if v_account.archived_at is not null then
    raise exception 'a closed account takes no imports' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'there are no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'one import takes at most 2000 rows' using errcode = '22023';
  end if;
  if p_row_count is null or p_row_count < jsonb_array_length(p_rows) then
    raise exception 'the file has fewer rows than are being imported' using errcode = '22023';
  end if;

  insert into import_batches (household_id, account_id, file_name, row_count, period_start, period_end, statement_opening, statement_closing)
  values (p_household_id, p_account_id, btrim(p_file_name), p_row_count, p_period_start, p_period_end, p_statement_opening, p_statement_closing)
  returning id into v_batch;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_id := null;
    v_kind := v_row ->> 'kind';
    v_amount := round((v_row ->> 'amount')::numeric, 2);
    if v_kind is null or v_kind not in ('expense', 'income', 'refund', 'transfer') then
      raise exception 'row % has no type the import knows', v_row ->> 'import_key' using errcode = '22023';
    end if;
    if v_amount is null or v_amount = 0 then
      raise exception 'row % has no amount', v_row ->> 'import_key' using errcode = '22023';
    end if;
    if nullif(btrim(v_row ->> 'import_key'), '') is null then
      raise exception 'every imported row needs its key' using errcode = '22023';
    end if;
    if (v_kind = 'expense' and v_amount > 0) or (v_kind in ('income', 'refund') and v_amount < 0) then
      raise exception 'row % is a % with the wrong sign', v_row ->> 'import_key', v_kind using errcode = '22023';
    end if;

    insert into transactions (
      household_id, account_id, amount, currency, native_amount, aed_estimated, kind, merchant, category_id,
      occurred_at, is_shared, owner_member_id, import_batch_id, import_key
    )
    values (
      p_household_id, p_account_id, v_amount,
      coalesce(nullif(v_row ->> 'currency', ''), 'AED'),
      (v_row ->> 'native_amount')::numeric,
      coalesce((v_row ->> 'aed_estimated')::boolean, false),
      -- A transfer's side goes in as the plain record it is, then is joined.
      case when v_kind = 'transfer' then (case when v_amount < 0 then 'expense' else 'income' end) else v_kind end,
      nullif(btrim(v_row ->> 'merchant'), ''),
      case when v_kind = 'transfer' then null else nullif(v_row ->> 'category_id', '')::uuid end,
      (v_row ->> 'occurred_at')::date,
      v_account.is_shared,
      case when v_account.is_shared then null else v_account.owner_member_id end,
      v_batch,
      btrim(v_row ->> 'import_key')
    )
    on conflict (account_id, import_key) where import_key is not null do nothing
    returning id into v_id;

    if v_id is null then
      v_already := v_already + 1;
      continue;
    end if;
    v_imported := v_imported + 1;

    if v_kind = 'transfer' then
      v_other := nullif(v_row ->> 'pair_transaction_id', '')::uuid;
      if v_other is null then
        if nullif(v_row ->> 'other_account_id', '') is null or (v_row ->> 'other_account_id')::uuid = p_account_id then
          raise exception 'transfer % needs its other account', v_row ->> 'import_key' using errcode = '22023';
        end if;
        insert into transactions (household_id, account_id, amount, currency, kind, merchant, occurred_at, is_shared, owner_member_id, import_batch_id)
        values (p_household_id, (v_row ->> 'other_account_id')::uuid, -v_amount, 'AED',
                case when v_amount < 0 then 'income' else 'expense' end,
                nullif(btrim(v_row ->> 'merchant'), ''), (v_row ->> 'occurred_at')::date,
                v_account.is_shared, case when v_account.is_shared then null else v_account.owner_member_id end, v_batch)
        returning id into v_other;
      end if;
      if v_amount < 0 then
        perform link_transfer(v_id, v_other);
      else
        perform link_transfer(v_other, v_id);
      end if;
    end if;
  end loop;

  update import_batches
  set imported_count = v_imported,
      skipped_count = p_row_count - v_imported
  where id = v_batch;

  return jsonb_build_object('batch_id', v_batch, 'imported', v_imported, 'already', v_already);
end;
$$;

-- Undoing an import removes the records it added, and only those. A record
-- someone has changed since, or joined to a record that was not part of the
-- import, stays, and so does whatever it is joined to: an undo never takes
-- away work done after the import. The batch is kept, marked undone, with how
-- many records were left.
create or replace function undo_import(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch import_batches;
  v_kept uuid[];
  v_grown uuid[];
  v_removed integer;
begin
  select * into v_batch from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'import % not found', p_batch_id using errcode = 'P0002';
  end if;
  if v_batch.status = 'undone' then
    raise exception 'this import has already been undone' using errcode = '22023';
  end if;

  -- Changed since the import, or joined to a record outside it.
  select coalesce(array_agg(t.id), '{}') into v_kept
  from transactions t
  where t.import_batch_id = p_batch_id
    and (
      t.updated_at > v_batch.created_at
      or exists (
        select 1 from transaction_links l
        join transactions o on o.id = (case when l.from_transaction_id = t.id then l.to_transaction_id else l.from_transaction_id end)
        where (l.from_transaction_id = t.id or l.to_transaction_id = t.id)
          and o.import_batch_id is distinct from p_batch_id
      )
    );

  -- And whatever a kept record is joined to inside the batch.
  loop
    select coalesce(array_agg(distinct t.id), '{}') into v_grown
    from transactions t
    join transaction_links l on t.id in (l.from_transaction_id, l.to_transaction_id)
    where t.import_batch_id = p_batch_id
      and (l.from_transaction_id = any (v_kept) or l.to_transaction_id = any (v_kept));
    v_grown := array(select distinct unnest(v_kept || v_grown));
    exit when cardinality(v_grown) = cardinality(v_kept);
    v_kept := v_grown;
  end loop;

  delete from transactions where import_batch_id = p_batch_id and not (id = any (v_kept));
  get diagnostics v_removed = row_count;

  update import_batches
  set status = 'undone',
      undone_at = now(),
      undone_by = (select m.id from household_members m where m.household_id = v_batch.household_id and m.user_id = auth.uid() limit 1),
      kept_on_undo = cardinality(v_kept)
  where id = p_batch_id;

  return jsonb_build_object('removed', v_removed, 'kept', cardinality(v_kept));
end;
$$;

revoke execute on function commit_import(uuid, uuid, text, jsonb, integer, date, date, numeric, numeric) from public, anon;
revoke execute on function undo_import(uuid) from public, anon;
grant execute on function commit_import(uuid, uuid, text, jsonb, integer, date, date, numeric, numeric) to authenticated;
grant execute on function undo_import(uuid) to authenticated;
