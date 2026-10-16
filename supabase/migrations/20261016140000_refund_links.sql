-- A refund linked to the purchase it returns (docs/decisions.md, "A refund
-- is linked to its purchase"; SHR-234).
--
-- A refund was an island: positive, kind 'refund', netting against spend in
-- whatever category someone gave it. Nothing said which purchase it
-- returned, so a refund filed under the wrong category (or none) made one
-- category read too low and left the purchase looking unreturned. A link
-- says which purchase, and linking gives the refund the purchase's category
-- (each line's share, for a split purchase), so it nets where the money was
-- spent.
--
-- A refund still counts in the month it arrives, as the card statement and
-- the bank show it; the link doesn't move it to the purchase's month.
--
-- The rules, checked at commit like the transfer and split rules:
--   * a refund link joins an expense (the purchase) to a refund;
--   * a refund returns one purchase; a purchase can have several refunds;
--   * the refund is dated on or after the purchase;
--   * a purchase's refunds add up to no more than it cost, with 5% allowed
--     over for a refund converted at a different exchange rate;
--   * while linked, neither changes kind (unlink first).
-- transaction_links already keeps both ends in the link's household.

-- One purchase per refund.
create unique index transaction_links_one_purchase_per_refund_idx
  on transaction_links (to_transaction_id) where kind = 'refund';

create or replace function check_refund(p_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx public.transactions;
  v_purchase public.transactions;
  v_refunded numeric;
  v_wrong_date int;
begin
  select * into v_tx from public.transactions where id = p_transaction_id;
  if not found then
    return;
  end if;

  -- As the refund.
  select p.* into v_purchase
  from public.transaction_links l
  join public.transactions p on p.id = l.from_transaction_id
  where l.kind = 'refund' and l.to_transaction_id = p_transaction_id;
  if found then
    if v_tx.kind <> 'refund' then
      raise exception 'transaction % is linked to the purchase it refunds, so it stays a refund until the two are unlinked', p_transaction_id
        using errcode = '23514';
    end if;
    if v_tx.occurred_at < v_purchase.occurred_at then
      raise exception 'a refund is dated on or after the purchase it returns' using errcode = '23514';
    end if;
  end if;

  -- As the purchase.
  if exists (select 1 from public.transaction_links l where l.kind = 'refund' and l.from_transaction_id = p_transaction_id) then
    if v_tx.kind <> 'expense' or v_tx.amount >= 0 then
      raise exception 'transaction % has refunds linked to it, so it stays an expense until they are unlinked', p_transaction_id
        using errcode = '23514';
    end if;
    select coalesce(sum(r.amount), 0), count(*) filter (where r.occurred_at < v_tx.occurred_at)
      into v_refunded, v_wrong_date
    from public.transaction_links l
    join public.transactions r on r.id = l.to_transaction_id
    where l.kind = 'refund' and l.from_transaction_id = p_transaction_id;
    if v_wrong_date > 0 then
      raise exception 'a refund is dated on or after the purchase it returns' using errcode = '23514';
    end if;
    if v_refunded > round(-v_tx.amount * 1.05, 2) then
      raise exception 'the refunds linked to this purchase (%) come to more than it cost (%)', v_refunded, -v_tx.amount
        using errcode = '23514';
    end if;
  end if;
end;
$$;

revoke execute on function check_refund(uuid) from public, anon, authenticated;

create or replace function check_refund_on_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.check_refund(new.id);
  return null;
end;
$$;

create or replace function check_refund_on_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.transaction_links;
  v_from public.transactions;
  v_to public.transactions;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  if v_row.kind <> 'refund' then
    return null;
  end if;
  if tg_op <> 'DELETE' then
    select * into v_from from public.transactions where id = v_row.from_transaction_id;
    select * into v_to from public.transactions where id = v_row.to_transaction_id;
    if v_from.kind <> 'expense' or v_to.kind <> 'refund' then
      raise exception 'a refund link joins a purchase (an expense) to a refund' using errcode = '23514';
    end if;
  end if;
  perform public.check_refund(v_row.from_transaction_id);
  perform public.check_refund(v_row.to_transaction_id);
  return null;
end;
$$;

revoke execute on function check_refund_on_transaction() from public, anon, authenticated;
revoke execute on function check_refund_on_link() from public, anon, authenticated;

create constraint trigger transactions_refund_rules
  after insert or update on transactions
  deferrable initially deferred
  for each row execute function check_refund_on_transaction();

create constraint trigger transaction_links_refund_rules
  after insert or update or delete on transaction_links
  deferrable initially deferred
  for each row execute function check_refund_on_link();

comment on table transaction_links is
  'Pairs of transactions that belong together: the two sides of a transfer between the household''s accounts, or a refund and the purchase it returns. Each kind''s rules are checked at commit.';

-- Links a refund to the purchase it returns, and gives the refund the
-- purchase's category: the same category, or for a split purchase a line in
-- each of its categories, in proportion. Runs as the caller (SECURITY
-- INVOKER), so row-level security decides what it may touch.
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
  v_before text;
  v_after text;
  v_lines int;
  v_left numeric;
  v_share numeric;
  v_line record;
  v_n int := 0;
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

  select coalesce(string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name),
                  (select name from categories where id = v_refund.category_id), 'Uncategorised')
    into v_before
  from transaction_splits s join categories c on c.id = s.category_id
  where s.transaction_id = v_refund.id;

  delete from transaction_splits where transaction_id = v_refund.id;

  select count(*) into v_lines from transaction_splits where transaction_id = v_purchase.id;
  if v_purchase.is_split and v_lines >= 2 then
    -- Each line's share, cut down to the cent; the largest line takes what
    -- is left, so the lines add up to the refund exactly.
    v_left := v_refund.amount;
    for v_line in
      select category_id, amount from transaction_splits where transaction_id = v_purchase.id order by abs(amount), category_id
    loop
      v_n := v_n + 1;
      v_share := case when v_n = v_lines then v_left else trunc(v_refund.amount * v_line.amount / v_purchase.amount, 2) end;
      if v_share > 0 then
        insert into transaction_splits (household_id, transaction_id, category_id, amount)
        values (v_refund.household_id, v_refund.id, v_line.category_id, v_share);
        v_left := v_left - v_share;
      end if;
    end loop;
    select count(*) into v_lines from transaction_splits where transaction_id = v_refund.id;
    if v_lines >= 2 then
      update transactions set is_split = true, category_id = null where id = v_refund.id;
    else
      -- A refund too small to share out is filed under the one line left.
      update transactions
         set is_split = false,
             category_id = (select category_id from transaction_splits where transaction_id = v_refund.id)
       where id = v_refund.id;
      delete from transaction_splits where transaction_id = v_refund.id;
    end if;
  else
    update transactions set is_split = false, category_id = v_purchase.category_id where id = v_refund.id;
  end if;

  select coalesce(string_agg(c.name || ' ' || abs(s.amount)::text, ', ' order by c.name),
                  (select name from categories c2 join transactions t on t.category_id = c2.id where t.id = v_refund.id), 'Uncategorised')
    into v_after
  from transaction_splits s join categories c on c.id = s.category_id
  where s.transaction_id = v_refund.id;

  insert into transaction_edits (transaction_id, field, old_value, new_value)
  values (v_refund.id, 'refund_for', null,
          coalesce(nullif(btrim(v_purchase.merchant), ''), 'Purchase') || ' ' || abs(v_purchase.amount)::text || ' on ' || to_char(v_purchase.occurred_at, 'FMDD Mon YYYY'));
  if v_before is distinct from v_after then
    insert into transaction_edits (transaction_id, field, old_value, new_value)
    values (v_refund.id, 'category', v_before, case when (select is_split from transactions where id = v_refund.id) then 'Split: ' || v_after else v_after end);
  end if;

  return jsonb_build_object('link_id', v_link);
end;
$$;

-- The reverse. The refund keeps the category linking gave it; it can be
-- changed like any other.
create or replace function unlink_refund(p_link_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_link transaction_links;
  v_purchase transactions;
begin
  -- The link has no update policy, so it is read plainly; its two
  -- transactions are locked instead.
  select * into v_link from transaction_links where id = p_link_id and kind = 'refund';
  if not found then
    raise exception 'refund link % not found', p_link_id using errcode = 'P0002';
  end if;
  perform 1 from transactions where id in (v_link.from_transaction_id, v_link.to_transaction_id) for update;
  select * into v_purchase from transactions where id = v_link.from_transaction_id;
  delete from transaction_links where id = p_link_id;
  insert into transaction_edits (transaction_id, field, old_value, new_value)
  values (v_link.to_transaction_id, 'refund_for',
          coalesce(nullif(btrim(v_purchase.merchant), ''), 'Purchase') || ' ' || abs(v_purchase.amount)::text || ' on ' || to_char(v_purchase.occurred_at, 'FMDD Mon YYYY'),
          null);
end;
$$;

revoke execute on function link_refund(uuid, uuid) from public, anon;
revoke execute on function unlink_refund(uuid) from public, anon;
grant execute on function link_refund(uuid, uuid) to authenticated;
grant execute on function unlink_refund(uuid) to authenticated;
