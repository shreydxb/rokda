-- Every scheduled job, in one place, retargetable in one call (QA #1).
--
-- Two findings from the recovery review, both about the same thing: what a
-- replay of this repository actually produces.
--
--   1. Replaying every migration created TWO jobs. Production runs three.
--      daily-fd-accrual was scheduled by hand and exists in no migration, so a
--      rebuilt project silently never accrues fixed-deposit interest. Nothing
--      would have said so: the app keeps working, the numbers just stop
--      moving.
--   2. The two jobs that ARE in migrations hardcode this project's URL. After
--      a restore into a replacement project they point at the old one, with
--      the new project's credentials, and every nightly call fails
--      authentication against a database that is no longer yours. §5 of
--      docs/backup-restore.md never said to retarget them, because there was
--      no single place to do it.
--
-- One function now owns all three. The migration calls it with this project's
-- URL, so applying this changes nothing here; recovery calls it once with the
-- new project's URL, which is the step that used to be three hand-edits of
-- cron bodies nobody had written down.
--
-- The URL still cannot be derived. Postgres has no setting carrying the
-- project ref (checked: nothing under app.*, nothing matching the ref in
-- pg_settings), so a replay into a new project WILL seed the old URL below.
-- What changes is that fixing it is one call and checking it is one script --
-- scripts/verify-cron-targets.sql, which §5 now runs and which fails on
-- exactly this.
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

  -- price-refresh is deployed with verify_jwt = true, so it needs a bearer
  -- token, and that token comes from the vault rather than being written into
  -- a migration. 120s: a real refresh paces Twelve Data batches a minute
  -- apart, and a shorter timeout reports a client-side failure while the
  -- function is still running fine.
  perform cron.schedule(
    'weekday-price-refresh',
    '0 23 * * 0,1,2,3,4',
    format($job$select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
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

  -- The one that existed only in production. Same shape as price-refresh:
  -- verify_jwt = true, so a service-role bearer token from the vault.
  perform cron.schedule(
    'daily-fd-accrual',
    '0 23 * * *',
    format($job$select net.http_post(
    url := %L,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )$job$, v_base || '/functions/v1/fd-accrual')
  );

  return query select j.jobname::text, j.schedule::text from cron.job j order by j.jobname;
end;
$$;

-- Powerful enough to point the household's scheduled work at any host: not
-- something a signed-in user may call. Recovery runs it as the database owner.
revoke execute on function schedule_all_jobs(text) from public, anon, authenticated;

comment on function schedule_all_jobs is
  'Creates or replaces all three scheduled jobs against a given project base URL (https://<ref>.supabase.co). The one call recovery makes to retarget everything after restoring into a replacement project -- see docs/backup-restore.md §5 and scripts/verify-cron-targets.sql.';

-- This project. Idempotent where it is already true; the point is that a
-- replay now produces all three jobs instead of two.
select schedule_all_jobs('https://erggbzbbutsvhleqcddq.supabase.co');
