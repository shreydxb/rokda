-- Do the scheduled jobs point at THIS project? (QA #1)
--
-- pg_cron will happily dispatch a nightly call to a host that has nothing to
-- do with this database. That is not hypothetical: two of the three jobs were
-- created by migrations with a hardcoded project URL, so replaying this
-- repository into a replacement project produces jobs aimed at the OLD one,
-- carrying the NEW project's credentials. Every call then fails
-- authentication against a database that is no longer yours, nightly, in
-- silence -- cron reports a successful dispatch either way.
--
-- Postgres cannot tell you its own project ref (nothing in pg_settings carries
-- it), so the expected URL is an input. That is the whole point: recovery
-- states where it thinks it is, and this fails if the jobs disagree.
--
--   psql -v base_url=https://<project-ref>.supabase.co \
--        -f scripts/verify-cron-targets.sql "$PROJECT_URL"
--
-- Run it after schedule_all_jobs(), and again after the first night has
-- passed. A pass here means the jobs are aimed correctly and are active; it
-- does not mean the far end answered -- for that, read the function logs.
\set ON_ERROR_STOP on
\pset pager off

-- Through a setting rather than straight into the block below: psql does not
-- substitute :variables inside a dollar-quoted body, so interpolating there
-- fails with a syntax error rather than checking anything.
select set_config('rokda.expected_base_url', :'base_url', false);

do $$
declare
  v_base text := rtrim(current_setting('rokda.expected_base_url'), '/');
  expected text[] := array['daily-fd-accrual', 'daily-recurring-nudge-check', 'weekday-price-refresh'];
  name text;
  cmd text;
  is_active boolean;
  problems int := 0;
begin
  foreach name in array expected loop
    select j.command, j.active into cmd, is_active from cron.job j where j.jobname = name;

    if cmd is null then
      raise warning 'MISSING: % is not scheduled at all', name;
      problems := problems + 1;
      continue;
    end if;

    -- Aimed somewhere else. The failure this script exists for.
    if position(v_base || '/functions/v1/' in cmd) = 0 then
      raise warning 'WRONG TARGET: % does not call %/functions/v1/... — it still points at whatever built it', name, v_base;
      problems := problems + 1;
    end if;

    -- A job can be scheduled, correctly aimed, and switched off.
    if not coalesce(is_active, false) then
      raise warning 'INACTIVE: % is scheduled but not active', name;
      problems := problems + 1;
    end if;

    -- Both endpoints reject an unauthenticated call. Losing the header is a
    -- silent nightly failure, not an error anyone sees.
    if name = 'daily-recurring-nudge-check' then
      if position('X-Telegram-Bot-Api-Secret-Token' in cmd) = 0 then
        raise warning 'NO AUTH: % sends no shared secret; the webhook will reject every call', name;
        problems := problems + 1;
      end if;
    elsif position('vault.decrypted_secrets' in cmd) = 0 then
      raise warning 'NO AUTH: % reads no service-role key from the vault; the gateway will reject every call', name;
      problems := problems + 1;
    end if;
  end loop;

  -- A job nobody expected, pointed anywhere, is worth seeing too.
  for name in select j.jobname from cron.job j where not (j.jobname = any(expected)) loop
    raise warning 'UNEXPECTED: % is scheduled and is in no migration', name;
    problems := problems + 1;
  end loop;

  if problems > 0 then
    raise exception 'verify-cron-targets: % problem(s) above', problems
      using hint = 'Retarget with: select schedule_all_jobs(''<https://project-ref.supabase.co>'');';
  end if;

  raise notice 'verify-cron-targets: ok — all three jobs are active, authenticated, and aimed at %', v_base;
end $$;
