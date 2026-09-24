-- SHR-303: make Telegram update handling fail closed, and give the one
-- unkeyed side effect a delivery key.
--
-- telegram_update_log could only say "received". The row was written before
-- processing, so a crash between the log insert and the intake insert left a
-- redelivery to be dropped as already handled -- the expense vanished with no
-- capture and no reply. That loss mode was unique to this table: intake has
-- its own delivery key (intake_source_ref_key on household_id, source,
-- source_ref), so the table's duplicate protection was redundant with a
-- guarantee that already existed, while its failure mode was its own.
--
-- It now records whether an update finished. A claim is taken before
-- processing and settled after it: 'completed' on success, 'failed' when the
-- handler caught an error, so the redelivery Telegram sends next is
-- processed rather than suppressed. A claim left 'processing' by a crash that
-- ran no handler at all becomes reclaimable once its lease expires.
--
-- This is a bounded lease over one writer, NOT exactly-once delivery. The
-- database keys underneath (intake_source_ref_key, and the goal_contributions
-- key below) are what make a second run harmless; the claim only decides
-- whether a second run happens.

alter table telegram_update_log
  -- Every row written before this migration was fully handled, or else it was
  -- lost and cannot be recovered now either; 'completed' is the honest value.
  add column status text not null default 'completed'
    check (status in ('processing', 'completed', 'failed')),
  add column claimed_at timestamptz not null default now(),
  add column attempts int not null default 1;

comment on table telegram_update_log is
  'Telegram update_ids the webhook has claimed, and whether each finished. processing = claimed and not settled; completed = handled; failed = the handler caught an error and the next redelivery may reclaim it. A processing claim older than the lease is reclaimable too, which is how a crash that ran no handler at all recovers. Pruned to the last 7 days by the daily run_recurring_check pass.';

-- Returns one of:
--   'claimed'    this caller now owns the update and must process it
--   'completed'  already handled; answer Telegram 200 and do nothing
--   'busy'       claimed by a run still inside its lease; answer non-200 so
--                Telegram retries LATER, by which time it is either completed
--                or reclaimable
--
-- 'completed' and 'busy' must not be merged into one "duplicate". If a handler
-- fails and marking the claim failed ALSO fails -- the database is down -- the
-- row is left 'processing'. Telegram retries within seconds. Answering that
-- retry 200 as a "duplicate" tells Telegram the update was delivered, and it
-- stops retrying: the message is lost after all. Answering non-200 keeps it
-- retrying until the lease lapses and the update is reclaimed.
--
-- An error raised here propagates to the caller, which must treat it as
-- unknown and NOT process -- deciding control flow by ignoring a database
-- error is the defect this replaces.
--
-- Concurrency: ON CONFLICT DO UPDATE locks the conflicting row, so a second
-- concurrent claim for the same update_id waits for the first, then evaluates
-- the WHERE against the row the first one wrote -- fresh and 'processing' --
-- and updates nothing. Exactly one caller sees 'claimed'; the other sees
-- 'busy'.
create or replace function claim_telegram_update(
  p_update_id bigint,
  p_lease interval default interval '3 minutes'
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  insert into telegram_update_log (update_id, status, claimed_at, attempts)
  values (p_update_id, 'processing', now(), 1)
  on conflict (update_id) do update
    set status = 'processing',
        claimed_at = now(),
        attempts = telegram_update_log.attempts + 1
    where telegram_update_log.status = 'failed'
       or (telegram_update_log.status = 'processing'
           and telegram_update_log.claimed_at < now() - p_lease);

  -- FOUND is true when a row was inserted or the conditional update matched;
  -- false when the conflict's WHERE rejected it.
  if found then
    return 'claimed';
  end if;

  select status into v_status from telegram_update_log where update_id = p_update_id;
  if v_status = 'completed' then
    return 'completed';
  end if;
  return 'busy';
end;
$$;

comment on function claim_telegram_update(bigint, interval) is
  'Claim a Telegram update for processing. The lease must exceed the longest a live handler can run (Edge Functions are cut off well inside 3 minutes), or a slow run could be claimed twice.';

-- Only the webhook, which runs as service_role, claims updates. Same pattern
-- as schedule_all_jobs.
revoke execute on function claim_telegram_update(bigint, interval) from public, anon, authenticated;
grant execute on function claim_telegram_update(bigint, interval) to service_role;

-- goal_contributions had no delivery key: a redelivered "put 500 toward the
-- house goal" inserted a second contribution. Mirrors intake's source /
-- source_ref, and is nullable so rows the web app writes are unaffected.
alter table goal_contributions
  add column source text,
  add column source_ref text;

-- Keyed per goal, so a single message that genuinely funds two goals is not
-- mistaken for a redelivery of itself.
create unique index goal_contributions_source_ref_key
  on goal_contributions (goal_id, source, source_ref)
  where source_ref is not null;

comment on column goal_contributions.source_ref is
  'Source-system delivery id (Telegram update_id) so a redelivered webhook cannot record the same contribution twice. Null for contributions entered in the app.';
