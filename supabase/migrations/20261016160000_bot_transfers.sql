-- Transfers from the Telegram bot (docs/decisions.md, "The bot records
-- transfers"; SHR-234).
--
-- "Paid the card 3,000 from the current account" sent to the bot was captured
-- as an expense, so it counted as spending until someone changed it in the
-- app. The bot now proposes it as a transfer, in exact figures, and records it
-- only on a "yes" or a thumbs-up, like a goal contribution or a balance. That
-- needs a fourth proposal kind, which means replacing the kind check; nothing
-- else here drops anything.
--
-- Applying a transfer proposal writes both sides and their link, as
-- record_transfer does, with two differences:
--   * a transfer already recorded between the two accounts, for the amount,
--     within four days, is not recorded again;
--   * a side already in the ledger as an ordinary record (the card payment
--     pasted from the bank's SMS as an expense, or the money arriving as
--     income) becomes that side of the transfer, with the change in its
--     history, instead of a second copy of the same money. This is also how a
--     single record becomes a transfer whose other side was never recorded.
-- The transfer rules (transfers migration) are checked at commit as for any
-- other write.

alter table bot_proposals drop constraint bot_proposals_kind_check;
alter table bot_proposals add constraint bot_proposals_kind_check
  check (kind in ('account_balances', 'goal_contribution', 'autopay_payment', 'transfer'));

comment on table bot_proposals is
  'Changes the Telegram bot is waiting for a member to confirm: balances, goal contributions and transfers read from a message, and autopay bills it asked about on their due date. Applied only by apply_bot_proposal(), once, on a "yes", a "paid" or a thumbs-up to the bot''s message.';

-- The same function as 20261012160000_autopay_confirmations, with one more
-- kind.
create or replace function apply_bot_proposal(p_proposal_id uuid, p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.bot_proposals%rowtype;
  v_item jsonb;
  v_account public.accounts%rowtype;
  v_new numeric;
  v_goal public.goals%rowtype;
  v_inserted int;
  v_applied jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_result jsonb;
  v_now timestamptz := now();
  v_recurring public.recurring%rowtype;
  v_amount numeric;
  v_due date;
  v_tx uuid;
  v_from public.accounts%rowtype;
  v_to public.accounts%rowtype;
  v_day date;
  v_link uuid;
  v_out uuid;
  v_in uuid;
  v_joined_out boolean;
  v_joined_in boolean;
  v_note text;
begin
  select * into v_proposal from public.bot_proposals where id = p_proposal_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_proposal.member_id is distinct from p_member_id then
    return jsonb_build_object('outcome', 'not_yours');
  end if;
  if v_proposal.status <> 'proposed' then
    return jsonb_build_object('outcome', v_proposal.status, 'result', v_proposal.result);
  end if;
  if v_proposal.expires_at <= v_now then
    update public.bot_proposals set status = 'expired', decided_at = v_now where id = v_proposal.id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  -- Read by the balance-history trigger, for this transaction only.
  perform set_config('rokda.balance_source', 'bot', true);
  perform set_config('rokda.balance_member', v_proposal.member_id::text, true);

  if v_proposal.kind = 'account_balances' then
    for v_item in select value from jsonb_array_elements(coalesce(v_proposal.payload -> 'items', '[]'::jsonb)) loop
      v_new := (v_item ->> 'new_balance')::numeric;
      select * into v_account
      from public.accounts a
      where a.id = (v_item ->> 'account_id')::uuid
        and a.household_id = v_proposal.household_id
        and a.archived_at is null
      for update;
      if not found or v_account.type = 'fd' or v_new is null then
        v_skipped := v_skipped || jsonb_build_object('account_id', v_item -> 'account_id', 'name', v_item -> 'name', 'reason', 'unavailable');
        continue;
      end if;
      if v_account.balance is distinct from (v_item ->> 'old_balance')::numeric then
        v_skipped := v_skipped || jsonb_build_object(
          'account_id', v_account.id, 'name', v_account.name, 'type', v_account.type, 'currency', v_account.currency,
          'reason', 'changed', 'balance', v_account.balance);
        continue;
      end if;
      update public.accounts
      set balance = v_new, balance_as_of = v_now, updated_at = v_now
      where id = v_account.id;
      v_applied := v_applied || jsonb_build_object(
        'account_id', v_account.id, 'name', v_account.name, 'type', v_account.type, 'currency', v_account.currency,
        'old_balance', v_account.balance, 'new_balance', v_new);
    end loop;

  elsif v_proposal.kind = 'goal_contribution' then
    select * into v_goal
    from public.goals g
    where g.id = (v_proposal.payload ->> 'goal_id')::uuid
      and g.household_id = v_proposal.household_id;
    if not found or coalesce((v_proposal.payload ->> 'amount')::numeric, 0) <= 0 then
      v_skipped := v_skipped || jsonb_build_object('goal_id', v_proposal.payload -> 'goal_id', 'reason', 'unavailable');
    else
      -- Keyed like the bot's direct writes used to be, so a contribution the
      -- bot recorded before this migration for the same message is not
      -- recorded a second time.
      insert into public.goal_contributions (goal_id, amount, occurred_at, source, source_ref)
      values (
        v_goal.id,
        (v_proposal.payload ->> 'amount')::numeric,
        coalesce((v_proposal.payload ->> 'occurred_at')::date, public.household_today(v_now)),
        'telegram',
        coalesce(v_proposal.source_ref, v_proposal.id::text)
      )
      on conflict (goal_id, source, source_ref) where source_ref is not null do nothing;
      get diagnostics v_inserted = row_count;
      v_applied := v_applied || jsonb_build_object(
        'goal_id', v_goal.id, 'name', v_goal.name,
        'amount', (v_proposal.payload ->> 'amount')::numeric,
        'occurred_at', coalesce((v_proposal.payload ->> 'occurred_at')::date, public.household_today(v_now)),
        'already_recorded', v_inserted = 0);
    end if;

  elsif v_proposal.kind = 'autopay_payment' then
    v_amount := (v_proposal.payload ->> 'amount')::numeric;
    v_due := (v_proposal.payload ->> 'due_date')::date;
    -- Locked, so two members confirming the same bill at the same moment
    -- record it once: the second waits here, then finds the first's.
    select * into v_recurring
    from public.recurring r
    where r.id = (v_proposal.payload ->> 'recurring_id')::uuid
      and r.household_id = v_proposal.household_id
    for update;
    if not found or v_recurring.account_id is null or v_amount is null or v_amount <= 0 or v_due is null then
      v_skipped := v_skipped || jsonb_build_object('recurring_id', v_proposal.payload -> 'recurring_id', 'name', v_proposal.payload -> 'name', 'reason', 'unavailable');
    else
      -- Recorded already: confirmed by someone else, or logged another way
      -- (a pasted bank SMS, the app). Same match as the bot's own check: the
      -- bill's account and category, an amount within 20%, a few days either
      -- side of the due date.
      select t.id into v_tx
      from public.transactions t
      where t.household_id = v_recurring.household_id
        and t.account_id = v_recurring.account_id
        and (v_recurring.category_id is null or t.category_id = v_recurring.category_id)
        and t.occurred_at between v_due - 5 and v_due + 5
        and abs(abs(t.amount) - v_amount) <= v_amount * 0.2
      order by abs(t.occurred_at - v_due), t.created_at
      limit 1;
      if v_tx is null then
        insert into public.transactions
          (household_id, account_id, category_id, owner_member_id, is_shared, amount, currency, kind, merchant, note, occurred_at, needs_review)
        values (
          v_recurring.household_id, v_recurring.account_id, v_recurring.category_id, v_recurring.owner_member_id, v_recurring.is_shared,
          -v_amount, 'AED', 'expense', v_recurring.name, 'Autopay, confirmed on Telegram', v_due, false
        )
        returning id into v_tx;
        v_inserted := 1;
      else
        v_inserted := 0;
      end if;
      v_applied := v_applied || jsonb_build_object(
        'recurring_id', v_recurring.id, 'name', v_recurring.name, 'transaction_id', v_tx,
        'amount', v_amount, 'occurred_at', v_due, 'next_due', v_proposal.payload -> 'next_due',
        'already_recorded', v_inserted = 0);
      -- The same question asked of another member is answered now.
      update public.bot_proposals p
      set status = 'expired', decided_at = v_now
      where p.household_id = v_proposal.household_id
        and p.kind = 'autopay_payment'
        and p.status = 'proposed'
        and p.id <> v_proposal.id
        and p.payload ->> 'recurring_id' = v_recurring.id::text
        and p.payload ->> 'due_date' = v_due::text;
    end if;

  elsif v_proposal.kind = 'transfer' then
    v_amount := round((v_proposal.payload ->> 'amount')::numeric, 2);
    v_day := (v_proposal.payload ->> 'occurred_at')::date;
    v_note := nullif(btrim(v_proposal.payload ->> 'note'), '');
    select * into v_from from public.accounts a
    where a.id = (v_proposal.payload ->> 'from_account_id')::uuid and a.household_id = v_proposal.household_id and a.archived_at is null;
    select * into v_to from public.accounts a
    where a.id = (v_proposal.payload ->> 'to_account_id')::uuid and a.household_id = v_proposal.household_id and a.archived_at is null;
    if v_from.id is null or v_to.id is null or v_from.id = v_to.id or v_amount is null or v_amount <= 0 or v_day is null then
      v_skipped := v_skipped || jsonb_build_object('name', v_proposal.payload -> 'from_name', 'reason', 'unavailable');
    else
      -- Recorded already: a transfer between these two accounts, for this
      -- amount, within the four days the app's own matching allows.
      select l.id into v_link
      from public.transaction_links l
      join public.transactions o on o.id = l.from_transaction_id
      join public.transactions i on i.id = l.to_transaction_id
      where l.kind = 'transfer' and l.household_id = v_proposal.household_id
        and o.account_id = v_from.id and i.account_id = v_to.id and i.amount = v_amount
        and o.occurred_at between v_day - 4 and v_day + 4
      limit 1;
      if v_link is not null then
        v_applied := v_applied || jsonb_build_object(
          'from_name', v_from.name, 'to_name', v_to.name, 'amount', v_amount, 'occurred_at', v_day, 'already_recorded', true);
      else
        -- A side already in the ledger as an ordinary record (the card
        -- payment pasted from the bank's SMS as an expense, the money
        -- arriving as income) becomes that side, rather than a second copy of
        -- it. Only a record nothing else is linked to, and never a split one.
        select t.id into v_out from public.transactions t
        where t.household_id = v_proposal.household_id and t.account_id = v_from.id and t.kind = 'expense'
          and t.amount = -v_amount and not t.is_split and t.occurred_at between v_day - 4 and v_day + 4
          and not exists (select 1 from public.transaction_links l where l.from_transaction_id = t.id or l.to_transaction_id = t.id)
        order by abs(t.occurred_at - v_day), t.created_at
        limit 1;
        select t.id into v_in from public.transactions t
        where t.household_id = v_proposal.household_id and t.account_id = v_to.id and t.kind = 'income'
          and t.amount = v_amount and not t.is_split and t.occurred_at between v_day - 4 and v_day + 4
          and not exists (select 1 from public.transaction_links l where l.from_transaction_id = t.id or l.to_transaction_id = t.id)
        order by abs(t.occurred_at - v_day), t.created_at
        limit 1;
        v_joined_out := v_out is not null;
        v_joined_in := v_in is not null;

        if v_joined_out then
          update public.transactions set kind = 'transfer', category_id = null where id = v_out;
          insert into public.transaction_edits (transaction_id, field, old_value, new_value) values (v_out, 'kind', 'Expense', 'Transfer');
        else
          insert into public.transactions (household_id, account_id, amount, currency, kind, note, occurred_at, is_shared, owner_member_id, needs_review)
          values (v_proposal.household_id, v_from.id, -v_amount, 'AED', 'transfer', coalesce(v_note, 'Transfer, confirmed on Telegram'), v_day, true, null, false)
          returning id into v_out;
        end if;
        if v_joined_in then
          update public.transactions set kind = 'transfer', category_id = null where id = v_in;
          insert into public.transaction_edits (transaction_id, field, old_value, new_value) values (v_in, 'kind', 'Income', 'Transfer');
        else
          insert into public.transactions (household_id, account_id, amount, currency, kind, note, occurred_at, is_shared, owner_member_id, needs_review)
          values (v_proposal.household_id, v_to.id, v_amount, 'AED', 'transfer', coalesce(v_note, 'Transfer, confirmed on Telegram'), v_day, true, null, false)
          returning id into v_in;
        end if;
        insert into public.transaction_links (household_id, kind, from_transaction_id, to_transaction_id)
        values (v_proposal.household_id, 'transfer', v_out, v_in);

        v_applied := v_applied || jsonb_build_object(
          'from_name', v_from.name, 'to_name', v_to.name, 'amount', v_amount, 'occurred_at', v_day,
          'joined_out', v_joined_out, 'joined_in', v_joined_in, 'already_recorded', false);
      end if;
    end if;
  end if;

  v_result := jsonb_build_object('kind', v_proposal.kind, 'applied', v_applied, 'skipped', v_skipped);
  update public.bot_proposals
  set status = 'applied', decided_at = v_now, result = v_result
  where id = v_proposal.id;
  return jsonb_build_object('outcome', 'applied') || v_result;
end;
$$;

revoke execute on function apply_bot_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function apply_bot_proposal(uuid, uuid) to service_role;

comment on function apply_bot_proposal(uuid, uuid) is
  'Applies a bot_proposals row once, on the confirming member''s behalf: sets the proposed balances that are still the figure the member was shown, records the goal contribution, records the autopay bill unless it is already recorded, or records the transfer (joining a side already in the ledger, and not again if it is recorded). Repeating it returns the first outcome and changes nothing.';
