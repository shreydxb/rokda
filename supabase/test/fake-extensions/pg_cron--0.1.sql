-- Minimal stand-in for the two pg_cron entry points this repo's migrations
-- call directly (cron.schedule, cron.unschedule); everything else pg_cron
-- provides (the background worker, cron.job_run_details, ...) is unused here.
create table cron.job (
  jobid bigint generated always as identity primary key,
  jobname text unique,
  schedule text not null,
  command text not null,
  -- Real pg_cron has this, and a job can be scheduled, correctly aimed and
  -- switched off. scripts/verify-cron-targets.sql checks for exactly that, so
  -- the stand-in needs the column or the check cannot run offline.
  active boolean not null default true
);

create function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $CRON$
declare
  new_id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into new_id;
  return new_id;
end;
$CRON$;

create function cron.unschedule(job_name text)
returns boolean
language plpgsql
as $CRON$
begin
  delete from cron.job where jobname = job_name;
  return found;
end;
$CRON$;
