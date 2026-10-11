-- The bot asks before it changes a balance or records a goal contribution,
-- and every balance change is kept.
--
-- 1. account_balance_events. A balance is entered by hand (the account
--    editor, the debt editor, or the bot) and overwritten in place, so the
--    figure it replaced survived only in a chat or in someone's memory. One
--    misread number from a message changed net worth with no way to see what
--    it had been. A trigger on accounts now records every change, old and new,
--    with where it came from and who made it, in the same transaction as the
--    change itself, so no writer can skip it.
-- 2. bot_proposals. The bot used to write a balance or a goal contribution the
--    moment the model read one from a message. Now it saves what it read as a
--    proposal, shows the change (old -> new), and only a "yes" or a thumbs-up
--    on that message applies it, through apply_bot_proposal(): one
--    transaction, applied at most once, and only while each balance is still
--    the one the member was shown. Expenses are unchanged: they already wait
--    in the Inbox, or are recorded only on a "yes".

-- ---------------------------------------------------------------------------
-- 1. Balance history
-- ---------------------------------------------------------------------------

create table account_balance_events (
  id bigint generated always as identity primary key,
  household_id uuid not null,
  account_id uuid not null,
  -- Null on the event that opened the account.
  old_balance numeric(14, 2),
  new_balance numeric(14, 2) not null,
  old_balance_as_of timestamptz,
  new_balance_as_of timestamptz,
  -- app: a signed-in member, through the account or debt editor.
  -- bot: a proposal confirmed in Telegram (apply_bot_proposal).
  -- system: anything else running without a signed-in user (a migration, the
  -- dashboard's SQL editor, a service-role script).
  source text not null check (source in ('app', 'bot', 'system')),
  -- Who made the change, when known: the signed-in member, or the member who
  -- confirmed the proposal.
  member_id uuid,
  recorded_at timestamptz not null default now(),
  constraint account_balance_events_account_fk foreign key (household_id, account_id)
    references accounts (household_id, id) on delete cascade,
  constraint account_balance_events_member_fk foreign key (household_id, member_id)
    references household_members (household_id, id) on delete set null (member_id)
);

create index account_balance_events_account_idx on account_balance_events (household_id, account_id, recorded_at desc);
create index account_balance_events_member_idx on account_balance_events (household_id, member_id);

alter table account_balance_events enable row level security;

-- Members read their household's history. Nobody writes it through the API:
-- the trigger below is the only writer, so a row cannot be forged or edited.
create policy "members can read balance history" on account_balance_events
  for select using (private.is_household_member(household_id));

comment on table account_balance_events is
  'Every change to an account''s balance, with the figure it replaced, where it came from (app, bot, system) and who made it. Written only by the accounts_record_balance_change trigger. Fixed deposits are left out: their balance is computed daily, never entered.';

-- Where a change came from is read from two transaction-local settings that
-- apply_bot_proposal() sets; without them, a signed-in user is the app and
-- anything else is the system. They are labels, not permissions: the API
-- cannot set them, and getting one wrong would mislabel a row, not let
-- anyone change a balance.
create or replace function private.record_account_balance_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text := nullif(current_setting('rokda.balance_source', true), '');
  v_member uuid := nullif(current_setting('rokda.balance_member', true), '')::uuid;
  v_user uuid := auth.uid();
begin
  -- A fixed deposit's balance is recomputed from its terms every day
  -- (fd-accrual); recording it would bury the entered changes in accrual.
  if new.type = 'fd' then return null; end if;
  if tg_op = 'UPDATE' and old.balance is not distinct from new.balance then return null; end if;

  if v_source is null then
    v_source := case when v_user is not null then 'app' else 'system' end;
  end if;
  if v_member is null and v_user is not null then
    select m.id into v_member
    from public.household_members m
    where m.household_id = new.household_id and m.user_id = v_user;
  end if;

  insert into public.account_balance_events
    (household_id, account_id, old_balance, new_balance, old_balance_as_of, new_balance_as_of, source, member_id)
  values (
    new.household_id,
    new.id,
    case when tg_op = 'UPDATE' then old.balance end,
    new.balance,
    case when tg_op = 'UPDATE' then old.balance_as_of end,
    new.balance_as_of,
    v_source,
    v_member
  );
  return null;
end;
$$;

revoke execute on function private.record_account_balance_change() from public, anon, authenticated;

create trigger accounts_record_balance_change
  after insert or update on accounts
  for each row execute function private.record_account_balance_change();

-- ---------------------------------------------------------------------------
-- 2. Changes the bot proposes and a member confirms
-- ---------------------------------------------------------------------------

create table bot_proposals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  -- The member who sent the message. Only they can confirm it.
  member_id uuid not null,
  kind text not null check (kind in ('account_balances', 'goal_contribution')),
  -- account_balances: {"items": [{"account_id", "old_balance", "new_balance", ...}]}
  -- goal_contribution: {"goal_id", "amount", "occurred_at", ...}
  -- Extra keys (names, for the prompt) are carried and ignored.
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  chat_id bigint not null,
  -- The bot's message showing the change, once sent. A reply or a reaction
  -- to it names this proposal exactly.
  prompt_message_id bigint,
  -- The Telegram update that produced it, so a redelivered message cannot
  -- propose the same change twice.
  source_ref text,
  status text not null default 'proposed' check (status in ('proposed', 'applied', 'cancelled', 'expired')),
  -- What apply_bot_proposal() did, kept so a second "yes" can say so again.
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 day',
  decided_at timestamptz,
  constraint bot_proposals_member_fk foreign key (household_id, member_id)
    references household_members (household_id, id) on delete cascade,
  constraint bot_proposals_decided check ((status = 'proposed') = (decided_at is null))
);

create unique index bot_proposals_source_ref_key on bot_proposals (household_id, source_ref) where source_ref is not null;
create unique index bot_proposals_prompt_key on bot_proposals (chat_id, prompt_message_id) where prompt_message_id is not null;
create index bot_proposals_member_idx on bot_proposals (household_id, member_id, created_at desc);

alter table bot_proposals enable row level security;

-- Members can see what the bot has asked about in their household. Only the
-- bot (service_role, which bypasses RLS) creates, decides or applies one.
create policy "members can read bot proposals" on bot_proposals
  for select using (private.is_household_member(household_id));

comment on table bot_proposals is
  'Balances and goal contributions the Telegram bot read from a message and is waiting for the sender to confirm. Applied only by apply_bot_proposal(), once, on a "yes" or a thumbs-up to the bot''s message.';

-- Applies a proposal, once. Returns what happened as JSON:
--   {"outcome": "applied", "kind": ..., "applied": [...], "skipped": [...]}
--   {"outcome": "applied" | "cancelled" | "expired", "result": ...} when it was
--     already decided: a second "yes" repeats the first answer, changes nothing
--   {"outcome": "not_found"} / {"outcome": "not_yours"}
--
-- A balance is changed only if it is still the figure the member was shown
-- (old_balance). If the app changed it in between, that item is skipped and
-- reported, rather than overwriting a newer figure with an older reading.
-- The row lock on the proposal makes a concurrent second "yes" wait, then see
-- it applied.
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
  end if;

  v_result := jsonb_build_object('kind', v_proposal.kind, 'applied', v_applied, 'skipped', v_skipped);
  update public.bot_proposals
  set status = 'applied', decided_at = v_now, result = v_result
  where id = v_proposal.id;
  return jsonb_build_object('outcome', 'applied') || v_result;
end;
$$;

-- Only the bot, which runs as service_role, confirms a proposal: a member
-- who wants to change a balance does it in the app.
revoke execute on function apply_bot_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function apply_bot_proposal(uuid, uuid) to service_role;

comment on function apply_bot_proposal(uuid, uuid) is
  'Applies a bot_proposals row once, on the confirming member''s behalf: sets the proposed balances that are still the figure the member was shown, or records the goal contribution. Repeating it returns the first outcome and changes nothing.';
