-- Card statements are reconciled, and Rokda knows which ones were
-- (docs/decisions.md, "A statement is reconciled, and Rokda records it").
--
-- Each credit card closes a statement on its statement day. Someone then
-- checks the statement against what Rokda recorded for the card: missing
-- spending gets added, double entries removed, the balance corrected. Nothing
-- recorded whether that had happened, so a month could go unchecked without
-- anyone noticing. Now every statement gets a row here: waiting until it is
-- checked, then confirmed (a member says it is done), reconciled (checked
-- line by line and the figures agree) or mismatch (checked, and they do not).
--
-- The Telegram bot asks about a waiting statement every morning from the day
-- after it closes until it is no longer waiting, and the app lists them under
-- Wealth -> Statements. Nothing here drops anything.

create table statement_reconciliations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  account_id uuid not null,
  -- The day the statement closed, and the period it covers as the card's
  -- statement day sets it.
  statement_date date not null,
  period_start date not null,
  due_date date,
  status text not null default 'waiting'
    check (status in ('waiting', 'confirmed', 'reconciled', 'mismatch')),
  -- Read from the statement, when someone records them: what it said the
  -- card owed at close, and what was spent in the period.
  statement_balance numeric(14, 2),
  statement_spend numeric(14, 2),
  -- What Rokda had recorded for the same period when it was checked.
  rokda_spend numeric(14, 2),
  note text,
  closed_by_member_id uuid,
  closed_at timestamptz,
  -- The bot's questions about this statement, so a reply or a reaction to any
  -- of them is understood, and the day it last asked.
  asked_message_ids bigint[] not null default '{}',
  last_asked_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, statement_date),
  constraint statement_reconciliations_period check (period_start <= statement_date),
  constraint statement_reconciliations_closed check ((status = 'waiting') = (closed_at is null)),
  foreign key (household_id, account_id)
    references accounts (household_id, id) on delete cascade,
  foreign key (household_id, closed_by_member_id)
    references household_members (household_id, id) on delete set null (closed_by_member_id)
);

create index statement_reconciliations_waiting_idx
  on statement_reconciliations (household_id, statement_date)
  where status = 'waiting';

comment on table statement_reconciliations is
  'One row per credit card statement: waiting until someone checks it against Rokda, then confirmed, reconciled or mismatch. The bot asks about waiting ones each morning; Wealth -> Statements lists them.';

alter table statement_reconciliations enable row level security;

-- Members read their household's statements and can mark one done from the
-- app. The bot (service_role, which bypasses RLS) creates them and records
-- the answers it is given.
create policy "members can read statement reconciliations" on statement_reconciliations
  for select using (private.is_household_member(household_id));
create policy "members can add statement reconciliations" on statement_reconciliations
  for insert with check (private.is_household_member(household_id));
create policy "members can update statement reconciliations" on statement_reconciliations
  for update using (private.is_household_member(household_id))
  with check (private.is_household_member(household_id));

-- On by default, like every other nudge; switched off in Settings -> Telegram.
alter table telegram_notification_prefs
  add column statement_enabled boolean not null default true;

comment on column telegram_notification_prefs.statement_enabled is
  'Whether the bot asks each morning about card statements that have closed and not been reconciled.';

-- The bot picks an expense's category from how the household categorised the
-- same merchant before. It read the latest 200 transactions for that, which
-- missed most of the history once card statements were imported. This counts
-- every merchant and category pair instead, so the bot reads a few hundred
-- grouped rows rather than every transaction. Only the bot calls it.
create or replace function merchant_category_counts(p_household_id uuid)
returns table (merchant text, category_id uuid, uses bigint, last_used date)
language sql
stable
security definer
set search_path = ''
as $$
  select t.merchant, t.category_id, count(*) as uses, max(t.occurred_at) as last_used
  from public.transactions t
  where t.household_id = p_household_id
    and t.merchant is not null
    and t.category_id is not null
    and t.kind = 'expense'
  group by t.merchant, t.category_id
  order by max(t.occurred_at) desc;
$$;

revoke execute on function merchant_category_counts(uuid) from public, anon, authenticated;
grant execute on function merchant_category_counts(uuid) to service_role;

comment on function merchant_category_counts(uuid) is
  'Each merchant and category pair in a household''s expenses, with how often and how recently it was used. The Telegram bot reads it to categorise a new expense the way the household did before.';
