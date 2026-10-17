-- A linked refund's lines match its purchase's to the cent, not only its
-- categories (docs/decisions.md, "A refund is linked to its purchase"; QA
-- re-check, 17 October).
--
-- The re-check reproduced as an ordinary member: a refund of 20 linked to a
-- purchase of 100 split 75/25 gets lines of 15/5. Calling split_transaction on
-- the refund with 5/15 kept the same total and the same two categories, so
-- check_refund let it through, and the categories' net spending read 70/10
-- instead of 60/20 while the total stayed right.
--
-- Now one function works out the allocation a refund takes from its purchase,
-- sync_refund_allocation writes it, and check_refund requires it at commit:
-- any other category, split or share of the lines is refused, whichever way
-- it was written. Changing the purchase, or the refund's amount, still moves
-- the refund with it, since those run the sync first.

-- The allocation a refund takes from its purchase: the purchase's category,
-- or for a split purchase a line in each of its categories in proportion, cut
-- to the cent, the largest line taking what is left. A refund too small to
-- share out is filed under the one line left. Returns
-- {"category_id": …, "lines": [{"category_id", "amount"}, …]} with the lines
-- in category order, or null when the transaction is not a linked refund.
-- Internal: used by the sync and the check below.
create or replace function refund_allocation(p_refund_id uuid)
returns jsonb
language plpgsql
stable
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
  v_category uuid;
begin
  select * into v_refund from public.transactions where id = p_refund_id;
  if not found or v_refund.kind <> 'refund' then
    return null;
  end if;
  select p.* into v_purchase
  from public.transaction_links l join public.transactions p on p.id = l.from_transaction_id
  where l.kind = 'refund' and l.to_transaction_id = p_refund_id;
  if not found then
    return null;
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
    if jsonb_array_length(v_want) = 1 then
      v_category := (v_want -> 0 ->> 'category_id')::uuid;
      v_want := '[]'::jsonb;
    end if;
  else
    v_category := v_purchase.category_id;
  end if;

  if jsonb_array_length(v_want) >= 2 then
    select jsonb_agg(x order by x ->> 'category_id') into v_want from jsonb_array_elements(v_want) x;
  end if;
  return jsonb_build_object('category_id', v_category, 'lines', v_want);
end;
$$;

revoke execute on function refund_allocation(uuid) from public, anon, authenticated;

-- Whether a refund is filed as its allocation says: split into exactly those
-- lines, or one category and no lines. Internal.
create or replace function refund_matches_allocation(p_refund_id uuid, p_want jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when jsonb_array_length(p_want -> 'lines') >= 2 then
      t.is_split and t.category_id is null
      and (select coalesce(jsonb_agg(jsonb_build_object('category_id', s.category_id, 'amount', s.amount) order by s.category_id), '[]'::jsonb)
           from public.transaction_splits s where s.transaction_id = p_refund_id) = p_want -> 'lines'
    else
      not t.is_split
      and t.category_id is not distinct from (p_want ->> 'category_id')::uuid
      and not exists (select 1 from public.transaction_splits s where s.transaction_id = p_refund_id)
  end
  from public.transactions t where t.id = p_refund_id;
$$;

revoke execute on function refund_matches_allocation(uuid, jsonb) from public, anon, authenticated;

-- The same sync as before, now reading the allocation from refund_allocation
-- so the check below can never disagree with it.
create or replace function sync_refund_allocation(p_refund_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.transactions;
  v_want jsonb;
  v_before text;
  v_after text;
begin
  v_want := public.refund_allocation(p_refund_id);
  if v_want is null or public.refund_matches_allocation(p_refund_id, v_want) then
    return;
  end if;
  select * into v_refund from public.transactions where id = p_refund_id;

  select coalesce(string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name),
                  (select name from public.categories where id = v_refund.category_id), 'Uncategorised')
    into v_before
  from public.transaction_splits s join public.categories c on c.id = s.category_id
  where s.transaction_id = p_refund_id;

  delete from public.transaction_splits where transaction_id = p_refund_id;
  if jsonb_array_length(v_want -> 'lines') >= 2 then
    insert into public.transaction_splits (household_id, transaction_id, category_id, amount)
    select v_refund.household_id, p_refund_id, (x ->> 'category_id')::uuid, (x ->> 'amount')::numeric
    from jsonb_array_elements(v_want -> 'lines') x;
    update public.transactions set is_split = true, category_id = null where id = p_refund_id;
    select 'Split: ' || string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name) into v_after
    from public.transaction_splits s join public.categories c on c.id = s.category_id
    where s.transaction_id = p_refund_id;
  else
    update public.transactions set is_split = false, category_id = (v_want ->> 'category_id')::uuid where id = p_refund_id;
    v_after := coalesce((select name from public.categories where id = (v_want ->> 'category_id')::uuid), 'Uncategorised');
  end if;

  insert into public.transaction_edits (transaction_id, field, old_value, new_value)
  values (p_refund_id, 'category', v_before, v_after || ' (follows the purchase it refunds)');
end;
$$;

revoke execute on function sync_refund_allocation(uuid) from public, anon, authenticated;

-- As before, except that the last rule compares each linked refund with its
-- whole allocation rather than only with the purchase's categories.
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

  -- Every refund is filed exactly as its purchase's money was spent: the
  -- purchase's category, or its share of each of the purchase's lines.
  select count(*) into v_astray
  from public.transaction_links l
  where l.kind = 'refund' and l.from_transaction_id = v_purchase_id
    and not public.refund_matches_allocation(l.to_transaction_id, public.refund_allocation(l.to_transaction_id));
  if v_astray > 0 then
    raise exception 'a linked refund is filed under its purchase''s category; unlink it to file it elsewhere' using errcode = '23514';
  end if;
end;
$$;

revoke execute on function check_refund(uuid) from public, anon, authenticated;
