-- One household per Rokda: create_household() founds it, once (sign-up review).
--
-- create_household() is SECURITY DEFINER and granted to every signed-in user.
-- 20260913153028 made it refuse someone who already belongs to a household,
-- which closed the cross-tenant hole it was written for. It still gave any
-- OTHER login a household of its own: a tenancy in this database that the
-- login owns and can write into. With sign-ups open that was anyone, since the
-- publishable key ships in every build and the sign-up endpoint needs nothing
-- else. Nothing in the app calls this function; it exists so that the very
-- first sign-in on an empty database has a way to found the household.
--
-- Rokda is one household's ledger (docs/decisions.md, "One household per
-- Rokda, and no sign-ups"), so that is now all it does. Once any household
-- exists it refuses everyone. People join the existing household the way they
-- always have: an owner adds them in Settings -> Household, and their login is
-- linked to that member row.
--
-- The checks, in the order a caller meets them:
--   1. no auth.uid()                    -> 42501, as before
--   2. already in a household           -> 23505, as before
--   3. a household already exists       -> 42501, new
--   4. blank household or display name  -> 23514, as before
-- Authorisation now comes before input validation, so a refused caller learns
-- nothing from which field they left blank.
--
-- Also search_path = '' with every name qualified, the shape the membership
-- helpers take in the next migration.

create or replace function public.create_household(p_name text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in before creating a household' using errcode = '42501';
  end if;

  -- Two first sign-ins on an empty database would each find no household
  -- below and found one apiece. The lock makes "is there one?" and the insert
  -- a single step. It is released at the end of the transaction and blocks
  -- nothing except another call to this function.
  perform pg_advisory_xact_lock(hashtext('public.create_household'));

  -- useHousehold() resolves the caller's household with .eq('user_id', ...)
  -- .limit(1): a second membership would not give the app a second household,
  -- it would give it an arbitrary one.
  if exists (select 1 from public.household_members where user_id = auth.uid()) then
    raise exception 'you already belong to a household' using errcode = '23505';
  end if;

  if exists (select 1 from public.households) then
    raise exception 'this Rokda already has its household'
      using errcode = '42501',
            hint = 'An owner of that household adds new members in Settings.';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'a household needs a name' using errcode = '23514';
  end if;

  if coalesce(btrim(p_display_name), '') = '' then
    raise exception 'your own member row needs a display name' using errcode = '23514';
  end if;

  insert into public.households (name) values (btrim(p_name)) returning id into new_id;

  insert into public.household_members (household_id, user_id, display_name, role)
  values (new_id, auth.uid(), btrim(p_display_name), 'owner');

  return new_id;
end;
$$;

-- Unchanged. CREATE OR REPLACE keeps a function's grants; this says what they are.
revoke execute on function public.create_household(text, text) from public, anon;
grant execute on function public.create_household(text, text) to authenticated;

comment on function public.create_household(text, text) is
  'Founds the household on an empty database: creates it and its first owner atomically. Refuses once any household exists (one household per Rokda) and refuses a caller who already belongs to one. Generates the household id itself, so it cannot be aimed at an existing household.';
