-- The nightly jobs authenticate with a scheduler secret of their own.
--
-- weekday-price-refresh and daily-fd-accrual sent the vault's
-- service_role_key, a legacy JWT, so that the platform's verify_jwt would let
-- them through. Supabase has stopped issuing legacy keys to new and restored
-- projects and plans to delete them in late 2026; after that both jobs fail
-- every night, here and in any restored project, and nothing says so but
-- fixed deposits and prices that stop moving.
--
-- Now each job sends the vault's scheduler_secret in X-Rokda-Scheduler-Secret.
-- Both functions are deployed with verify_jwt = false (supabase/config.toml)
-- and compare the header with the same vault value, in constant time,
-- refusing every scheduled call when the secret is missing or too short
-- (supabase/functions/_shared/requestAuth.ts). The webhook's own secret works
-- the same way.
--
-- The value is created by the owner in the SQL Editor, inside the database,
-- so it never appears in this repository, a chat or a log
-- (docs/decisions.md, "The nightly jobs carry their own secret"). Applying
-- this before it exists breaks nothing that is not already broken: the jobs
-- send an empty header and are refused until it is set.

-- One reader for both sides. The jobs call it from their cron bodies, which
-- run as the database owner; the functions call it over the API with the
-- service-role client they already use. Nobody signed in can: the secret
-- would let them run either job. An empty search_path, so nothing on the
-- caller's path can stand in for the vault.
create or replace function get_scheduler_secret()
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'scheduler_secret';
$$;

revoke execute on function get_scheduler_secret() from public, anon, authenticated;
grant execute on function get_scheduler_secret() to service_role;

comment on function get_scheduler_secret is
  'Returns the vault''s scheduler_secret: what the nightly jobs send as X-Rokda-Scheduler-Secret, and what price-refresh and fd-accrual compare it with. Service role and the database owner only.';

-- The same function as 20260920120000_schedule_all_jobs, with the two jobs'
-- Authorization header replaced by the scheduler secret. The recurring check
-- is unchanged. Still the one call recovery makes to retarget every job.
create or replace function schedule_all_jobs(p_base_url text)
returns table (jobname text, schedule text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := rtrim(coalesce(p_base_url, ''), '/');
begin
  -- A bare ref, an http:// URL or a /functions/v1 suffix each produce jobs
  -- that dispatch successfully and are answered by nothing -- cheap to refuse
  -- here, expensive to notice later. A trailing slash is the one mistake
  -- worth absorbing rather than rejecting: it is what copying the URL out of
  -- the dashboard gives you, and the rtrim above has already removed it.
  if v_base !~ '^https://[a-z0-9-]+\.supabase\.co$' then
    raise exception 'base url must look like https://<project-ref>.supabase.co, got %', p_base_url
      using errcode = '22023',
            hint = 'Pass the replacement project''s URL, with no trailing slash and no /functions/v1 suffix.';
  end if;

  -- cron.schedule replaces a job of the same name, so this is idempotent and
  -- safe to re-run. The unschedule is kept for the jobs that already exist
  -- under these names, matching what the earlier migrations did.
  if exists (select 1 from cron.job j where j.jobname = 'weekday-price-refresh') then
    perform cron.unschedule('weekday-price-refresh');
  end if;
  if exists (select 1 from cron.job j where j.jobname = 'daily-recurring-nudge-check') then
    perform cron.unschedule('daily-recurring-nudge-check');
  end if;
  if exists (select 1 from cron.job j where j.jobname = 'daily-fd-accrual') then
    perform cron.unschedule('daily-fd-accrual');
  end if;

  -- The secret is read when the job runs, not written into the job, so
  -- rotating it in the vault needs no reschedule. An unset secret sends an
  -- empty header, which the function refuses and logs as a 403, rather than
  -- a job that errors before any request is made. 120s: a real refresh paces
  -- Twelve Data batches a minute apart, and a shorter timeout reports a
  -- client-side failure while the function is still running fine.
  perform cron.schedule(
    'weekday-price-refresh',
    '0 23 * * 0,1,2,3,4',
    format($job$select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'X-Rokda-Scheduler-Secret', coalesce(public.get_scheduler_secret(), ''),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )$job$, v_base || '/functions/v1/price-refresh')
  );

  -- The webhook rejects any request without this shared secret, before it
  -- parses anything -- including this one.
  perform cron.schedule(
    'daily-recurring-nudge-check',
    '0 5 * * *',
    format($job$select net.http_get(
    url := %L,
    headers := jsonb_build_object('X-Telegram-Bot-Api-Secret-Token', get_telegram_webhook_secret()),
    timeout_milliseconds := 60000
  )$job$, v_base || '/functions/v1/telegram-webhook?run_recurring_check=1')
  );

  perform cron.schedule(
    'daily-fd-accrual',
    '0 23 * * *',
    format($job$select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'X-Rokda-Scheduler-Secret', coalesce(public.get_scheduler_secret(), ''),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )$job$, v_base || '/functions/v1/fd-accrual')
  );

  return query select j.jobname::text, j.schedule::text from cron.job j order by j.jobname;
end;
$$;

revoke execute on function schedule_all_jobs(text) from public, anon, authenticated;

comment on function schedule_all_jobs is
  'Creates or replaces all three scheduled jobs against a given project base URL (https://<ref>.supabase.co). The one call recovery makes to retarget everything after restoring into a replacement project -- see docs/backup-restore.md §5 and scripts/verify-cron-targets.sql.';

-- This project. The jobs keep their names and schedules; only the header
-- they send changes.
select schedule_all_jobs('https://erggbzbbutsvhleqcddq.supabase.co');
