-- Transfers between the household's own accounts (docs/decisions.md,
-- "Transfers are neither income nor spending"; SHR-234).
--
-- Moving money from the current account to savings, or paying a card from
-- the current account, was recorded as an expense on one side and income on
-- the other, so it inflated both. A transfer is now its own kind: two rows,
-- money out of one account and the same money into another, joined by a link,
-- and counted as neither income nor spending anywhere.
--
-- The database holds the rules, so no path that writes transactions (the app,
-- the bot, the SQL editor) can leave half a transfer:
--   * a transfer row always has exactly one counterpart;
--   * the two sides are on different accounts, one out and one in, for the
--     same amount to the cent (a fee is a separate expense);
--   * both sides belong to the same household.
-- The checks run at commit, so the functions below can write both sides
-- and the link in one transaction.
--
-- transaction_links is general on purpose: refund-to-purchase links and
-- confirmed duplicates (SHR-234 items 2 and 5) can use it later. Only
-- 'transfer' links are made today.

alter table transactions drop constraint transactions_kind_check;
alter table transactions add constraint transactions_kind_check
  check (kind in ('expense', 'income', 'refund', 'transfer'));

create table transaction_links (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  kind text not null check (kind in ('transfer', 'refund', 'duplicate_confirmed')),
  -- For a transfer, the money-out side and the money-in side.
  from_transaction_id uuid not null,
  to_transaction_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint transaction_links_distinct check (from_transaction_id <> to_transaction_id),
  constraint transaction_links_from_fk foreign key (household_id, from_transaction_id)
    references transactions (household_id, id) on delete cascade,
  constraint transaction_links_to_fk foreign key (household_id, to_transaction_id)
    references transactions (household_id, id) on delete cascade,
  constraint transaction_links_created_by_fk foreign key (household_id, created_by)
    references household_members (household_id, id) on delete set null (created_by)
);

-- One link per pair, whichever way round it was made.
create unique index transaction_links_pair_idx
  on transaction_links (least(from_transaction_id, to_transaction_id), greatest(from_transaction_id, to_transaction_id));
create index transaction_links_household_from_idx on transaction_links (household_id, from_transaction_id);
create index transaction_links_household_to_idx on transaction_links (household_id, to_transaction_id);
create index transaction_links_household_created_by_idx on transaction_links (household_id, created_by);

create or replace function set_transaction_link_author()
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

revoke execute on function set_transaction_link_author() from public, anon, authenticated;

create trigger transaction_links_set_author
  before insert on transaction_links
  for each row execute function set_transaction_link_author();

-- The transfer rules, for one transaction. Run at commit for every
-- transaction a write touched, so a function can write both sides before
-- they are checked.
create or replace function check_transfer(p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx public.transactions;
  v_links int;
  v_link public.transaction_links;
  v_out public.transactions;
  v_in public.transactions;
begin
  select * into v_tx from public.transactions where id = p_transaction_id;
  if not found then
    return;
  end if;

  select count(*) into v_links
  from public.transaction_links l
  where l.kind = 'transfer' and (l.from_transaction_id = p_transaction_id or l.to_transaction_id = p_transaction_id);

  if v_tx.kind = 'transfer' and v_links <> 1 then
    raise exception 'a transfer needs exactly one other side; transaction % has %', p_transaction_id, v_links
      using errcode = '23514';
  end if;
  if v_tx.kind <> 'transfer' and v_links > 0 then
    raise exception 'transaction % is one side of a transfer, so its type stays transfer until the two are unlinked', p_transaction_id
      using errcode = '23514';
  end if;
  if v_links = 0 then
    return;
  end if;

  select * into v_link
  from public.transaction_links l
  where l.kind = 'transfer' and (l.from_transaction_id = p_transaction_id or l.to_transaction_id = p_transaction_id);
  select * into v_out from public.transactions where id = v_link.from_transaction_id;
  select * into v_in from public.transactions where id = v_link.to_transaction_id;

  if v_out.id is null or v_in.id is null then
    raise exception 'a transfer needs both of its sides' using errcode = '23514';
  end if;
  if v_out.kind <> 'transfer' or v_in.kind <> 'transfer' then
    raise exception 'both sides of a transfer are of type transfer' using errcode = '23514';
  end if;
  if v_out.account_id = v_in.account_id then
    raise exception 'a transfer moves money between two different accounts' using errcode = '23514';
  end if;
  if not (v_out.amount < 0 and v_in.amount > 0) then
    raise exception 'a transfer takes money out of one account (negative) and into the other (positive)' using errcode = '23514';
  end if;
  if -v_out.amount <> v_in.amount then
    raise exception 'both sides of a transfer are the same amount (% out, % in); record a fee as its own expense', -v_out.amount, v_in.amount
      using errcode = '23514';
  end if;
end;
$$;

revoke execute on function check_transfer(uuid) from public, anon, authenticated;

create or replace function check_transfer_on_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.check_transfer(new.id);
  return null;
end;
$$;

create or replace function check_transfer_on_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.transaction_links;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  if v_row.kind = 'transfer' then
    perform public.check_transfer(v_row.from_transaction_id);
    perform public.check_transfer(v_row.to_transaction_id);
  end if;
  return null;
end;
$$;

revoke execute on function check_transfer_on_transaction() from public, anon, authenticated;
revoke execute on function check_transfer_on_link() from public, anon, authenticated;

create constraint trigger transactions_transfer_rules
  after insert or update on transactions
  deferrable initially deferred
  for each row execute function check_transfer_on_transaction();

create constraint trigger transaction_links_transfer_rules
  after insert or update or delete on transaction_links
  deferrable initially deferred
  for each row execute function check_transfer_on_link();

alter table transaction_links enable row level security;

-- Members read and make links; a link is never edited, only removed (by
-- unlinking or deleting the transfer).
create policy "members can read transaction links" on transaction_links
  for select using (private.is_household_member(household_id));
create policy "members can link transactions" on transaction_links
  for insert with check (private.is_household_member(household_id));
create policy "members can unlink transactions" on transaction_links
  for delete using (private.is_household_member(household_id));

comment on table transaction_links is
  'Pairs of transactions that belong together. Today only transfers: the money-out and money-in sides of moving money between two of the household''s accounts. The transfer rules (one counterpart, different accounts, opposite signs, equal amounts, same household) are checked at commit.';

-- Writing transfers. Each runs as the caller (SECURITY INVOKER), so row-level
-- security decides what it may touch, and writes both sides and the link
-- together or not at all.

create or replace function record_transfer(
  p_household_id uuid,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_amount numeric,
  p_occurred_at date,
  p_note text default null,
  p_is_shared boolean default true,
  p_owner_member_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_out uuid;
  v_in uuid;
  v_link uuid;
  v_amount numeric := round(abs(coalesce(p_amount, 0)), 2);
begin
  if v_amount = 0 then
    raise exception 'an amount is required' using errcode = '22023';
  end if;
  if p_from_account_id is null or p_to_account_id is null or p_from_account_id = p_to_account_id then
    raise exception 'a transfer needs two different accounts' using errcode = '22023';
  end if;
  if not exists (select 1 from accounts where id = p_from_account_id and household_id = p_household_id)
     or not exists (select 1 from accounts where id = p_to_account_id and household_id = p_household_id) then
    raise exception 'both accounts must belong to this household' using errcode = '42501';
  end if;

  insert into transactions (household_id, account_id, amount, currency, kind, note, occurred_at, is_shared, owner_member_id)
  values (p_household_id, p_from_account_id, -v_amount, 'AED', 'transfer', nullif(btrim(p_note), ''), coalesce(p_occurred_at, household_today()),
          coalesce(p_is_shared, true), case when coalesce(p_is_shared, true) then null else p_owner_member_id end)
  returning id into v_out;

  insert into transactions (household_id, account_id, amount, currency, kind, note, occurred_at, is_shared, owner_member_id)
  values (p_household_id, p_to_account_id, v_amount, 'AED', 'transfer', nullif(btrim(p_note), ''), coalesce(p_occurred_at, household_today()),
          coalesce(p_is_shared, true), case when coalesce(p_is_shared, true) then null else p_owner_member_id end)
  returning id into v_in;

  insert into transaction_links (household_id, kind, from_transaction_id, to_transaction_id)
  values (p_household_id, 'transfer', v_out, v_in)
  returning id into v_link;

  return jsonb_build_object('link_id', v_link, 'from_transaction_id', v_out, 'to_transaction_id', v_in);
end;
$$;

-- Two records already in the ledger (the card payment out of the current
-- account, and the same payment arriving on the card) turned into one
-- transfer. Each side keeps its date, account, merchant and note; only its
-- type changes, and the change goes in each one's edit history.
create or replace function link_transfer(p_out_transaction_id uuid, p_in_transaction_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_out transactions;
  v_in transactions;
  v_link uuid;
begin
  select * into v_out from transactions where id = p_out_transaction_id for update;
  select * into v_in from transactions where id = p_in_transaction_id for update;
  if v_out.id is null or v_in.id is null then
    raise exception 'both transactions must exist' using errcode = 'P0002';
  end if;
  if v_out.household_id <> v_in.household_id then
    raise exception 'both transactions must belong to the same household' using errcode = '42501';
  end if;
  if v_out.kind = 'transfer' or v_in.kind = 'transfer' then
    raise exception 'one of these is already a transfer' using errcode = '23514';
  end if;

  update transactions set kind = 'transfer' where id in (v_out.id, v_in.id);
  insert into transaction_edits (transaction_id, field, old_value, new_value)
  values (v_out.id, 'kind', initcap(v_out.kind), 'Transfer'), (v_in.id, 'kind', initcap(v_in.kind), 'Transfer');

  insert into transaction_links (household_id, kind, from_transaction_id, to_transaction_id)
  values (v_out.household_id, 'transfer', v_out.id, v_in.id)
  returning id into v_link;

  return jsonb_build_object('link_id', v_link);
end;
$$;

-- The reverse: two separate records again, an expense out of one account and
-- income into the other, each with the change in its history.
create or replace function unlink_transfer(p_link_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_link transaction_links;
begin
  -- The link has no update policy, so it is read plainly; its two
  -- transactions are locked instead.
  select * into v_link from transaction_links where id = p_link_id and kind = 'transfer';
  if not found then
    raise exception 'transfer % not found', p_link_id using errcode = 'P0002';
  end if;
  perform 1 from transactions where id in (v_link.from_transaction_id, v_link.to_transaction_id) for update;
  delete from transaction_links where id = p_link_id;
  update transactions set kind = 'expense' where id = v_link.from_transaction_id;
  update transactions set kind = 'income' where id = v_link.to_transaction_id;
  insert into transaction_edits (transaction_id, field, old_value, new_value)
  values (v_link.from_transaction_id, 'kind', 'Transfer', 'Expense'), (v_link.to_transaction_id, 'kind', 'Transfer', 'Income');
end;
$$;

-- Both sides at once: the amount, the day and the note are the transfer's,
-- not one side's.
create or replace function update_transfer(p_link_id uuid, p_amount numeric, p_occurred_at date, p_note text default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_link transaction_links;
  v_amount numeric := round(abs(coalesce(p_amount, 0)), 2);
begin
  if v_amount = 0 then
    raise exception 'an amount is required' using errcode = '22023';
  end if;
  -- The link has no update policy, so it is read plainly; its two
  -- transactions are locked instead.
  select * into v_link from transaction_links where id = p_link_id and kind = 'transfer';
  if not found then
    raise exception 'transfer % not found', p_link_id using errcode = 'P0002';
  end if;
  perform 1 from transactions where id in (v_link.from_transaction_id, v_link.to_transaction_id) for update;
  update transactions set amount = -v_amount, occurred_at = coalesce(p_occurred_at, occurred_at), note = nullif(btrim(p_note), '')
   where id = v_link.from_transaction_id;
  update transactions set amount = v_amount, occurred_at = coalesce(p_occurred_at, occurred_at), note = nullif(btrim(p_note), '')
   where id = v_link.to_transaction_id;
end;
$$;

-- Both sides at once, so a transfer is never left half there.
create or replace function delete_transfer(p_link_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_link transaction_links;
begin
  -- The link has no update policy, so it is read plainly; its two
  -- transactions are locked instead.
  select * into v_link from transaction_links where id = p_link_id and kind = 'transfer';
  if not found then
    raise exception 'transfer % not found', p_link_id using errcode = 'P0002';
  end if;
  perform 1 from transactions where id in (v_link.from_transaction_id, v_link.to_transaction_id) for update;
  delete from transactions where id in (v_link.from_transaction_id, v_link.to_transaction_id);
end;
$$;

revoke execute on function record_transfer(uuid, uuid, uuid, numeric, date, text, boolean, uuid) from public, anon;
revoke execute on function link_transfer(uuid, uuid) from public, anon;
revoke execute on function unlink_transfer(uuid) from public, anon;
revoke execute on function update_transfer(uuid, numeric, date, text) from public, anon;
revoke execute on function delete_transfer(uuid) from public, anon;
grant execute on function record_transfer(uuid, uuid, uuid, numeric, date, text, boolean, uuid) to authenticated;
grant execute on function link_transfer(uuid, uuid) to authenticated;
grant execute on function unlink_transfer(uuid) to authenticated;
grant execute on function update_transfer(uuid, numeric, date, text) to authenticated;
grant execute on function delete_transfer(uuid) to authenticated;
