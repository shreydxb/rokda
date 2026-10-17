-- A linked refund keeps its purchase's rules through every edit, not only
-- when it is linked (docs/decisions.md, "A refund is linked to its purchase";
-- QA re-review, 17 October).
--
-- Two gaps the review reproduced as an ordinary member:
--   * Editing a linked refund's amount skipped the purchase-plus-5% cap: the
--     cap was checked only when the purchase itself was written, so a refund
--     of 20 on a purchase of 100 could become 200 and stay linked.
--   * A linked refund's category could be changed on its own, so the purchase
--     sat in one category while its refund lowered another's spending.
--
-- Now:
--   * Whichever side is written, the purchase is checked: every refund's date,
--     and their total against the cap. The purchase row is locked for the
--     check, so two refunds edited at once can't both pass on a total that
--     counts only one of them.
--   * A linked refund's categories follow the purchase's: its category, or a
--     share of each of its lines for a split purchase. They are kept that way
--     here rather than once in link_refund: linking, recategorising or
--     splitting the purchase, and changing the refund's amount each set the
--     refund's allocation again, with the change in its history.
--   * Filing a linked refund elsewhere is refused at commit. Unlinking it
--     first is the way to do that.

-- The allocation a refund takes from its purchase, written to the refund if
-- it differs: the purchase's category, or for a split purchase a line in each
-- of its categories in proportion, cut to the cent, the largest line taking
-- what is left. Internal: run by the triggers below.
create or replace function sync_refund_allocation(p_refund_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.transactions;
  v_purchase public.transactions;
  v_lines int;
  v_left numeric;
  v_share numeric;
  v_line record;
  v_n int := 0;
  v_want jsonb := '[]'::jsonb;
  v_have jsonb;
  v_category uuid;
  v_before text;
  v_after text;
begin
  select * into v_refund from public.transactions where id = p_refund_id;
  if not found or v_refund.kind <> 'refund' then
    return;
  end if;
  select p.* into v_purchase
  from public.transaction_links l join public.transactions p on p.id = l.from_transaction_id
  where l.kind = 'refund' and l.to_transaction_id = p_refund_id;
  if not found then
    return;
  end if;

  select count(*) into v_lines from public.transaction_splits where transaction_id = v_purchase.id;
  if v_purchase.is_split and v_lines >= 2 and v_purchase.amount <> 0 then
    v_left := v_refund.amount;
    for v_line in
      select category_id, amount from public.transaction_splits where transaction_id = v_purchase.id order by abs(amount), category_id
    loop
      v_n := v_n + 1;
      v_share := case when v_n = v_lines then v_left else trunc(v_refund.amount * v_line.amount / v_purchase.amount, 2) end;
      if v_share > 0 then
        v_want := v_want || jsonb_build_object('category_id', v_line.category_id, 'amount', v_share);
        v_left := v_left - v_share;
      end if;
    end loop;
    -- A refund too small to share out is filed under the one line left.
    if jsonb_array_length(v_want) = 1 then
      v_category := (v_want -> 0 ->> 'category_id')::uuid;
      v_want := '[]'::jsonb;
    end if;
  else
    v_category := v_purchase.category_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('category_id', category_id, 'amount', amount) order by category_id), '[]'::jsonb)
    into v_have
  from public.transaction_splits where transaction_id = p_refund_id;
  if jsonb_array_length(v_want) >= 2 then
    select coalesce(jsonb_agg(x order by x ->> 'category_id'), '[]'::jsonb) into v_want from jsonb_array_elements(v_want) x;
    if v_refund.is_split and v_refund.category_id is null and v_have = v_want then
      return;
    end if;
  elsif not v_refund.is_split and v_refund.category_id is not distinct from v_category and v_have = '[]'::jsonb then
    return;
  end if;

  select coalesce(string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name),
                  (select name from public.categories where id = v_refund.category_id), 'Uncategorised')
    into v_before
  from public.transaction_splits s join public.categories c on c.id = s.category_id
  where s.transaction_id = p_refund_id;

  delete from public.transaction_splits where transaction_id = p_refund_id;
  if jsonb_array_length(v_want) >= 2 then
    insert into public.transaction_splits (household_id, transaction_id, category_id, amount)
    select v_refund.household_id, p_refund_id, (x ->> 'category_id')::uuid, (x ->> 'amount')::numeric
    from jsonb_array_elements(v_want) x;
    update public.transactions set is_split = true, category_id = null where id = p_refund_id;
    select 'Split: ' || string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name) into v_after
    from public.transaction_splits s join public.categories c on c.id = s.category_id
    where s.transaction_id = p_refund_id;
  else
    update public.transactions set is_split = false, category_id = v_category where id = p_refund_id;
    v_after := coalesce((select name from public.categories where id = v_category), 'Uncategorised');
  end if;

  insert into public.transaction_edits (transaction_id, field, old_value, new_value)
  values (p_refund_id, 'category', v_before, v_after || ' (follows the purchase it refunds)');
end;
$$;

revoke execute on function sync_refund_allocation(uuid) from public, anon, authenticated;

-- When a purchase's category or lines may have changed, its refunds follow;
-- when a linked refund's amount changes, its share of each line is worked out
-- again. A purchase's lines are in place by the time its row is updated
-- (split_transaction and unsplit_transaction write the lines first).
create or replace function sync_refunds_on_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund uuid;
begin
  if pg_trigger_depth() > 2 then
    return null;
  end if;
  if new.kind = 'expense' then
    for v_refund in
      select l.to_transaction_id from public.transaction_links l where l.kind = 'refund' and l.from_transaction_id = new.id
    loop
      perform public.sync_refund_allocation(v_refund);
    end loop;
  elsif new.kind = 'refund' and new.amount is distinct from old.amount then
    perform public.sync_refund_allocation(new.id);
  end if;
  return null;
end;
$$;

create or replace function sync_refund_on_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'refund' then
    perform public.sync_refund_allocation(new.to_transaction_id);
  end if;
  return null;
end;
$$;

revoke execute on function sync_refunds_on_transaction() from public, anon, authenticated;
revoke execute on function sync_refund_on_link() from public, anon, authenticated;

create trigger transactions_sync_refunds
  after update of category_id, is_split, amount on transactions
  for each row execute function sync_refunds_on_transaction();

create trigger transaction_links_sync_refund
  after insert on transaction_links
  for each row execute function sync_refund_on_link();

-- The refund rules for one transaction, either side of a link, checked at
-- commit. A refund's purchase is checked whenever the refund changes too.
create or replace function check_refund(p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx public.transactions;
  v_purchase_id uuid;
  v_purchase public.transactions;
  v_refunded numeric;
  v_wrong_date int;
  v_astray int;
begin
  select * into v_tx from public.transactions where id = p_transaction_id;
  if not found then
    return;
  end if;

  -- As the refund.
  select l.from_transaction_id into v_purchase_id
  from public.transaction_links l
  where l.kind = 'refund' and l.to_transaction_id = p_transaction_id;
  if v_purchase_id is not null and v_tx.kind <> 'refund' then
    raise exception 'transaction % is linked to the purchase it refunds, so it stays a refund until the two are unlinked', p_transaction_id
      using errcode = '23514';
  end if;
  if v_purchase_id is null
     and exists (select 1 from public.transaction_links l where l.kind = 'refund' and l.from_transaction_id = p_transaction_id) then
    v_purchase_id := p_transaction_id;
  end if;
  if v_purchase_id is null then
    return;
  end if;

  -- The purchase, locked so two refunds changed at once are counted together.
  select * into v_purchase from public.transactions where id = v_purchase_id for update;
  if v_purchase.kind <> 'expense' or v_purchase.amount >= 0 then
    raise exception 'transaction % has refunds linked to it, so it stays an expense until they are unlinked', v_purchase_id
      using errcode = '23514';
  end if;
  select coalesce(sum(r.amount), 0), count(*) filter (where r.occurred_at < v_purchase.occurred_at)
    into v_refunded, v_wrong_date
  from public.transaction_links l
  join public.transactions r on r.id = l.to_transaction_id
  where l.kind = 'refund' and l.from_transaction_id = v_purchase_id;
  if v_wrong_date > 0 then
    raise exception 'a refund is dated on or after the purchase it returns' using errcode = '23514';
  end if;
  if v_refunded > round(-v_purchase.amount * 1.05, 2) then
    raise exception 'the refunds linked to this purchase (%) come to more than it cost (%)', v_refunded, -v_purchase.amount
      using errcode = '23514';
  end if;

  -- Every refund is filed where the purchase's money was spent: the
  -- purchase's category, or among its lines' categories.
  select count(*) into v_astray
  from public.transaction_links l
  join public.transactions r on r.id = l.to_transaction_id
  where l.kind = 'refund' and l.from_transaction_id = v_purchase_id
    and (
      case
        when v_purchase.is_split then
          (not r.is_split and (r.category_id is null or r.category_id not in (select s.category_id from public.transaction_splits s where s.transaction_id = v_purchase_id)))
          or (r.is_split and exists (
                select 1 from public.transaction_splits rs
                where rs.transaction_id = r.id
                  and rs.category_id not in (select s.category_id from public.transaction_splits s where s.transaction_id = v_purchase_id)))
        else r.is_split or r.category_id is distinct from v_purchase.category_id
      end
    );
  if v_astray > 0 then
    raise exception 'a linked refund is filed under its purchase''s category; unlink it to file it elsewhere' using errcode = '23514';
  end if;
end;
$$;

revoke execute on function check_refund(uuid) from public, anon, authenticated;

-- A refund's lines are checked too, and a purchase's: a line moved by hand
-- must not leave a refund filed where no money was spent.
create or replace function check_refund_on_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.check_refund(case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end);
  return null;
end;
$$;

revoke execute on function check_refund_on_line() from public, anon, authenticated;

create constraint trigger transaction_splits_refund_rules
  after insert or update or delete on transaction_splits
  deferrable initially deferred
  for each row execute function check_refund_on_line();

-- link_refund now only links; the trigger on transaction_links gives the
-- refund its purchase's allocation, as every later change does.
create or replace function link_refund(p_purchase_id uuid, p_refund_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_purchase transactions;
  v_refund transactions;
  v_link uuid;
begin
  select * into v_purchase from transactions where id = p_purchase_id for update;
  select * into v_refund from transactions where id = p_refund_id for update;
  if v_purchase.id is null or v_refund.id is null then
    raise exception 'both transactions must exist' using errcode = 'P0002';
  end if;
  if v_purchase.household_id <> v_refund.household_id then
    raise exception 'both transactions must belong to the same household' using errcode = '42501';
  end if;
  if v_purchase.kind <> 'expense' then
    raise exception 'a refund is linked to a purchase, which is an expense' using errcode = '22023';
  end if;
  if v_refund.kind <> 'refund' then
    raise exception 'only a refund is linked to a purchase' using errcode = '22023';
  end if;

  insert into transaction_links (household_id, kind, from_transaction_id, to_transaction_id)
  values (v_purchase.household_id, 'refund', v_purchase.id, v_refund.id)
  returning id into v_link;

  insert into transaction_edits (transaction_id, field, old_value, new_value)
  values (v_refund.id, 'refund_for', null,
          coalesce(nullif(btrim(v_purchase.merchant), ''), 'Purchase') || ' ' || abs(v_purchase.amount)::text || ' on ' || to_char(v_purchase.occurred_at, 'FMDD Mon YYYY'));

  return jsonb_build_object('link_id', v_link);
end;
$$;
