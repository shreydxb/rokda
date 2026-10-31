-- The bot records trades (SHR-370; docs/decisions.md, "The bot records
-- trades"). A trade read from a Telegram message is a bot proposal like a
-- balance or a transfer: the member sees the database's own figures and
-- nothing is saved until they say yes. Four things the step-1 tables did not
-- yet have:
--
-- 1. Proposals of two new kinds, a trade and the undo of one, and a proposal
--    still being asked about (status 'asking'), which no "yes" can apply.
-- 2. A stock bought for the first time becomes a holding of its own, from an
--    opening entry of no units, so the replay treats it like any other.
-- 3. Previews of a new holding's buy and of an undo that run the real save
--    and roll it back, so the confirmation shows exactly what yes would do.
-- 4. apply_bot_proposal saves a trade or an undo through record_trade and
--    delete_trade, which refuse a confirmation shown on an older version.

alter table bot_proposals drop constraint bot_proposals_kind_check;
alter table bot_proposals add constraint bot_proposals_kind_check
  check (kind in ('account_balances', 'goal_contribution', 'autopay_payment', 'transfer', 'trade', 'trade_undo'));

-- An 'asking' row is a trade the bot is still asking about (which holding,
-- how many, what price). It is undecided, like a proposed one, but has no
-- confirmation for a "yes" to apply.
alter table bot_proposals drop constraint bot_proposals_status_check;
alter table bot_proposals add constraint bot_proposals_status_check
  check (status in ('asking', 'proposed', 'applied', 'cancelled', 'expired'));
alter table bot_proposals drop constraint bot_proposals_decided;
alter table bot_proposals add constraint bot_proposals_decided
  check ((status in ('asking', 'proposed')) = (decided_at is null));

comment on table bot_proposals is
  'Changes the Telegram bot is waiting for a member to confirm: balances, goal contributions, transfers and share trades read from a message, the undo of a trade, and autopay bills it asked about on their due date. A trade still missing an answer waits as an asking row. Applied only by apply_bot_proposal(), once, on a "yes", a "paid" or a thumbs-up to the bot''s message.';

-- A holding bought new starts from an empty opening entry: no units, at no
-- price. Every other entry still moves at least some units.
alter table holding_trades drop constraint holding_trades_units_check;
alter table holding_trades add constraint holding_trades_units_check
  check (units > 0 or (kind = 'opening' and units = 0));

-- A split never recorded halves the units' value with the price. When a
-- traded holding's value moves by more than 40% between its last two value
-- points with no trade between them, the bot asks its owner whether it split,
-- once for that point: this is the day of the point it last asked about.
alter table holdings add column split_asked_for date;
comment on column holdings.split_asked_for is
  'The day of the value point the bot last asked this holding''s owner about (a large move with no trade, perhaps a split), so it asks once per point.';

-- Makes the holding a first buy of a stock goes into, with its empty opening
-- entry, ready for the buy to be replayed on it. It belongs to its owner (a
-- member's shares are theirs, not the household's), in the owner's household.
-- Its price starts at nothing; the caller sets it.
create or replace function private.create_trade_holding(p_new jsonb, p_trade_date date)
returns public.holdings
language plpgsql
set search_path = ''
as $$
declare
  v_owner public.household_members%rowtype;
  v_holding public.holdings%rowtype;
begin
  select * into v_owner from public.household_members where id = (p_new ->> 'owner_member_id')::uuid;
  if not found then
    raise exception 'a new holding''s owner must be a member' using errcode = 'check_violation';
  end if;
  if nullif(btrim(p_new ->> 'name'), '') is null then
    raise exception 'a new holding needs a name' using errcode = 'check_violation';
  end if;
  insert into public.holdings (
    household_id, owner_member_id, is_shared, name, asset_class, currency, price_symbol, price_provider, sector,
    funds_account_id, quantity, avg_price, value_aed)
  values (
    v_owner.household_id, v_owner.id, false, btrim(p_new ->> 'name'), p_new ->> 'asset_class', p_new ->> 'currency',
    nullif(btrim(p_new ->> 'price_symbol'), ''), nullif(p_new ->> 'price_provider', ''), nullif(p_new ->> 'sector', ''),
    (p_new ->> 'funds_account_id')::uuid, 0, null, 0)
  returning * into v_holding;
  insert into public.holding_trades (
    household_id, holding_id, member_id, kind, trade_date, units, price, source, units_after, avg_after, created_by, created_at)
  values (
    v_holding.household_id, v_holding.id, v_owner.id, 'opening', p_trade_date, 0, 0, 'opening', 0, 0, v_owner.id,
    clock_timestamp());
  perform set_config('rokda.trade_replay', 'on', true);
  update public.holdings set trades_version = 1 where id = v_holding.id returning * into v_holding;
  perform set_config('rokda.trade_replay', '', true);
  return v_holding;
end;
$$;

revoke execute on function private.create_trade_holding(jsonb, date) from public, anon, authenticated;

-- When a trade's price was quoted: its time, else the end of its day in
-- Dubai, and never later than now. A new holding's first price is its buy's.
create or replace function private.trade_priced_at(p_trade_date date, p_traded_at timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select least(now(), coalesce(p_traded_at, (p_trade_date + 1)::timestamp at time zone 'Asia/Dubai'));
$$;

revoke execute on function private.trade_priced_at(date, timestamptz) from public, anon, authenticated;

-- Who a new holding's caller is, and whether the holding can be made: the
-- owner a member, the caller in the owner's household, a name. Answered as
-- the trade functions answer, never raised.
create or replace function private.new_holding_check(p_new jsonb, p_member_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_household uuid;
begin
  select household_id into v_household from public.household_members where id = (p_new ->> 'owner_member_id')::uuid;
  if v_household is null or nullif(btrim(p_new ->> 'name'), '') is null then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  if private.trade_caller(v_household, p_member_id) is null then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function private.new_holding_check(jsonb, uuid) from public, anon, authenticated;

-- The figures a first buy of a stock would give, worked out on the holding it
-- would make. The holding is made and then rolled back, so nothing survives
-- the preview; the effect is kept in a variable, which a rollback leaves alone.
-- Its price starts at the buy's, dated at the trade, so its value is what was
-- paid until the price feed prices it, as record_new_holding_trade does.
create or replace function public.preview_new_holding_trade(
  p_new_holding jsonb, p_trade_date date, p_units numeric, p_price numeric, p_fees numeric default 0,
  p_traded_at timestamptz default null, p_funds_account_id uuid default null, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check jsonb := private.new_holding_check(p_new_holding, p_member_id);
  v_holding public.holdings%rowtype;
  v_effect jsonb;
begin
  if not (v_check ->> 'ok')::boolean then
    return v_check;
  end if;
  begin
    v_holding := private.create_trade_holding(p_new_holding, p_trade_date);
    update public.holdings set current_price = p_price, priced_at = private.trade_priced_at(p_trade_date, p_traded_at)
    where id = v_holding.id returning * into v_holding;
    v_effect := private.trade_effect(v_holding, 'buy', p_trade_date, p_units, p_price, p_fees, 0, p_traded_at,
      p_funds_account_id, null);
    raise exception 'preview only' using errcode = 'RK001';
  exception
    when sqlstate 'RK001' then null;
    when check_violation or foreign_key_violation or invalid_text_representation then
      return jsonb_build_object('ok', false, 'error', 'bad_input');
  end;
  return v_effect || jsonb_build_object('new_holding', true);
end;
$$;

-- Makes the holding and records its first buy together, or neither: a buy the
-- replay refuses (a fund in another currency, say) leaves no empty holding
-- behind. The buy is recorded at version 1, the holding's only version yet.
create or replace function public.record_new_holding_trade(
  p_new_holding jsonb, p_trade_date date, p_units numeric, p_price numeric, p_fees numeric default 0,
  p_traded_at timestamptz default null, p_funds_account_id uuid default null, p_source text default 'app',
  p_proposal_id uuid default null, p_member_id uuid default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check jsonb := private.new_holding_check(p_new_holding, p_member_id);
  v_holding public.holdings%rowtype;
  v_result jsonb;
begin
  if not (v_check ->> 'ok')::boolean then
    return v_check;
  end if;
  -- Plan A's rule, before anything is made: a member's own call is an app
  -- trade, and only the bot ties one to a proposal.
  if auth.uid() is not null and (p_source is distinct from 'app' or p_proposal_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;
  begin
    v_holding := private.create_trade_holding(p_new_holding, p_trade_date);
    -- Priced at the buy and dated at the trade: net worth leaves out a
    -- holding with no price date, and the fund has already paid for it.
    update public.holdings set current_price = p_price, priced_at = private.trade_priced_at(p_trade_date, p_traded_at)
    where id = v_holding.id;
    v_result := public.record_trade(v_holding.id, 'buy', p_trade_date, p_units, p_price, p_fees, 0, p_traded_at,
      p_funds_account_id, p_source, p_proposal_id, p_member_id, 1, false, p_note);
    if not coalesce((v_result ->> 'ok')::boolean, false) then
      raise exception 'trade refused' using errcode = 'RK002';
    end if;
  exception
    when sqlstate 'RK002' then return v_result;
    when check_violation or foreign_key_violation or invalid_text_representation then
      return jsonb_build_object('ok', false, 'error', 'bad_input');
  end;
  return v_result || jsonb_build_object('holding_id', v_holding.id, 'new_holding', true);
end;
$$;

-- What undoing a trade would do, from the real delete rolled back: the units
-- and average before and after, and the money it would give back or take.
create or replace function public.preview_delete_trade(p_trade_id uuid, p_member_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holding public.holdings%rowtype;
  v_result jsonb;
begin
  select h.* into v_holding from public.holdings h join public.holding_trades t on t.holding_id = h.id where t.id = p_trade_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'trade_not_found');
  end if;
  begin
    v_result := public.delete_trade(p_trade_id, null, p_member_id);
    raise exception 'preview only' using errcode = 'RK001';
  exception
    when sqlstate 'RK001' then null;
  end;
  if not coalesce((v_result ->> 'ok')::boolean, false) then
    return v_result;
  end if;
  return v_result || jsonb_build_object('units_before', v_holding.quantity, 'avg_before', v_holding.avg_price);
end;
$$;

revoke execute on function public.preview_new_holding_trade(jsonb, date, numeric, numeric, numeric, timestamptz, uuid, uuid) from public, anon;
revoke execute on function public.record_new_holding_trade(jsonb, date, numeric, numeric, numeric, timestamptz, uuid, text, uuid, uuid, text) from public, anon;
revoke execute on function public.preview_delete_trade(uuid, uuid) from public, anon;
grant execute on function public.preview_new_holding_trade(jsonb, date, numeric, numeric, numeric, timestamptz, uuid, uuid) to authenticated, service_role;
grant execute on function public.record_new_holding_trade(jsonb, date, numeric, numeric, numeric, timestamptz, uuid, text, uuid, uuid, text) to authenticated, service_role;
grant execute on function public.preview_delete_trade(uuid, uuid) to authenticated, service_role;

-- The same function as 20261016160000_bot_transfers, with trades and undos.
-- A trade or an undo is saved by record_trade, record_new_holding_trade or
-- delete_trade on the sender's behalf. If the holding moved on since the
-- member was shown it (stale), or the trade can no longer be made (refused),
-- the proposal expires and the bot says so, rather than saving figures the
-- member never saw.
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
  v_trade jsonb;
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

  if v_proposal.kind in ('trade', 'trade_undo') then
    if v_proposal.kind = 'trade_undo' then
      v_trade := public.delete_trade((v_proposal.payload ->> 'trade_id')::uuid,
        (v_proposal.payload ->> 'expected_version')::integer, v_proposal.member_id);
    elsif v_proposal.payload ? 'new_holding' and exists (
      select 1 from public.holdings h
      where h.household_id = v_proposal.household_id
        and h.owner_member_id = (v_proposal.payload -> 'new_holding' ->> 'owner_member_id')::uuid
        and lower(h.name) = lower(btrim(v_proposal.payload -> 'new_holding' ->> 'name'))
    ) then
      -- The member has a holding of that name now (another first buy of the
      -- stock was confirmed first): this one is stale, so the bot asks again
      -- on that holding rather than making a second one.
      v_trade := jsonb_build_object('ok', false, 'error', 'stale');
    elsif v_proposal.payload ? 'new_holding' then
      v_trade := public.record_new_holding_trade(v_proposal.payload -> 'new_holding',
        (v_proposal.payload ->> 'trade_date')::date, (v_proposal.payload ->> 'units')::numeric,
        (v_proposal.payload ->> 'price')::numeric, coalesce((v_proposal.payload ->> 'fees')::numeric, 0),
        (v_proposal.payload ->> 'traded_at')::timestamptz, (v_proposal.payload ->> 'funds_account_id')::uuid,
        'bot', v_proposal.id, v_proposal.member_id);
    else
      v_trade := public.record_trade((v_proposal.payload ->> 'holding_id')::uuid, v_proposal.payload ->> 'kind',
        (v_proposal.payload ->> 'trade_date')::date, (v_proposal.payload ->> 'units')::numeric,
        (v_proposal.payload ->> 'price')::numeric, coalesce((v_proposal.payload ->> 'fees')::numeric, 0),
        coalesce((v_proposal.payload ->> 'tax_withheld')::numeric, 0), (v_proposal.payload ->> 'traded_at')::timestamptz,
        (v_proposal.payload ->> 'funds_account_id')::uuid, 'bot', v_proposal.id, v_proposal.member_id,
        (v_proposal.payload ->> 'expected_version')::integer,
        coalesce((v_proposal.payload ->> 'tax_to_confirm')::boolean, false));
    end if;
    if coalesce((v_trade ->> 'ok')::boolean, false) then
      v_result := jsonb_build_object('kind', v_proposal.kind, 'effect', v_trade);
      update public.bot_proposals set status = 'applied', decided_at = v_now, result = v_result where id = v_proposal.id;
      return jsonb_build_object('outcome', 'applied') || v_result;
    end if;
    v_result := jsonb_build_object('kind', v_proposal.kind, 'error', v_trade ->> 'error');
    update public.bot_proposals set status = 'expired', decided_at = v_now, result = v_result where id = v_proposal.id;
    if v_trade ->> 'error' = 'stale' then
      return jsonb_build_object('outcome', 'stale', 'kind', v_proposal.kind);
    end if;
    return jsonb_build_object('outcome', 'refused', 'kind', v_proposal.kind, 'error', v_trade ->> 'error');
  end if;

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
  'Applies a bot_proposals row once, on the confirming member''s behalf: sets the proposed balances that are still the figure the member was shown, records the goal contribution, records the autopay bill unless it is already recorded, records the transfer (joining a side already in the ledger, and not again if it is recorded), or records or undoes a share trade, refused as stale if the holding changed since it was shown. A proposal still asking a question cannot be applied. Repeating it returns the first outcome and changes nothing.';
