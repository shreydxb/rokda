-- Autopay bills are confirmed, not entered (docs/decisions.md).
--
-- A bill on autopay, such as a loan EMI taken from a bank account each month,
-- goes out on its own, so nobody types it in and Rokda waited for an entry
-- that never came. Now the bot asks on the bill's due date whether it went
-- out, and every morning after until someone answers: "yes", "paid" or a 👍
-- records it, "not yet" means ask again tomorrow. The question is a bot
-- proposal like a balance change, and confirming it records the bill through
-- apply_bot_proposal().
--
-- This needs a new proposal kind. Widening the kind check means replacing the
-- constraint; nothing else here drops anything.

alter table bot_proposals drop constraint bot_proposals_kind_check;
alter table bot_proposals add constraint bot_proposals_kind_check
  check (kind in ('account_balances', 'goal_contribution', 'autopay_payment'));

comment on table bot_proposals is
  'Changes the Telegram bot is waiting for a member to confirm: balances and goal contributions read from a message, and autopay bills it asked about on their due date. Applied only by apply_bot_proposal(), once, on a "yes", a "paid" or a thumbs-up to the bot''s message.';

-- An autopay question is found by any of the messages that asked it (the
-- first question and each morning's reminder), listed in its payload.
create index if not exists bot_proposals_autopay_cycle_idx
  on bot_proposals (household_id, (payload ->> 'recurring_id'), (payload ->> 'due_date'))
  where kind = 'autopay_payment';

-- The same function as 20261011190050_bot_proposals_and_balance_history,
-- with one more kind. autopay_payment records the bill as an expense on its
-- account and category, dated its due date, unless it is recorded already:
-- one transaction per bill per due date, however many members were asked,
-- how many times anyone says yes, or whether it was also logged by hand.
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
  'Applies a bot_proposals row once, on the confirming member''s behalf: sets the proposed balances that are still the figure the member was shown, records the goal contribution, or records the autopay bill unless it is already recorded. Repeating it returns the first outcome and changes nothing.';
