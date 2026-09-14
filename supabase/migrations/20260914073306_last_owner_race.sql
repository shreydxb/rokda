-- The last-owner invariant, under two sessions instead of one.
--
-- household_members_keep_an_owner() asks "does this household still have an
-- owner?" after each owner-removing row change. That is correct sequentially
-- and wrong concurrently. Under READ COMMITTED each transaction reads a
-- snapshot taken before the other committed, so with two owners and two
-- sessions each removing a DIFFERENT one:
--
--   session A deletes owner 1, asks, still sees owner 2 -> passes
--   session B deletes owner 2, asks, still sees owner 1 -> passes
--   both commit -> the household has no owner at all
--
-- Reproduced against this exact schema: 2 owners in, 0 owners out, both
-- transactions reporting COMMIT. Same hole for a demotion racing a delete,
-- since the trigger fires for UPDATE too.
--
-- The consequence got worse when roster INSERT became owner-gated
-- (20260913153028). Before that, a stranded member could self-insert as owner
-- and recover; now is_household_owner() is false for everyone in that
-- household, so nobody can add a member, change a role, or administer it ever
-- again. The rows are still there and no one can reach them.
--
-- The fix is to stop asking the question concurrently. Taking a row lock on
-- the household forces owner-removing changes to that household into a
-- queue: the second session blocks until the first commits, and its check
-- then runs against a snapshot that includes the first delete, so it sees
-- zero owners and refuses.
--
-- households is the right thing to lock rather than the roster rows: the
-- invariant is a property of the household, and the rows that would need
-- locking are precisely the ones that may not exist yet.
create or replace function household_members_keep_an_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only a row that WAS an owner can have reduced the owner count. Without
  -- this the trigger asks "does this household have an owner?" rather than
  -- "did this operation remove the last one?", and then refuses ordinary edits
  -- to a household that never had an owner to begin with -- which an INSERT
  -- can legitimately produce, since a household's first member is created
  -- before anyone can be promoted.
  if old.role <> 'owner' then
    return null;
  end if;

  -- Serialise owner removals per household, and double as the cascade check.
  -- A household being deleted takes its whole roster with it; that is the
  -- household going away, not a household left ownerless, so there is nothing
  -- to protect and the check must not block the delete. FOR UPDATE finds no
  -- row in that case because the same transaction already deleted it.
  perform 1 from households where id = old.household_id for update;
  if not found then
    return null;
  end if;

  if not exists (
    select 1 from household_members
    where household_id = old.household_id and role = 'owner'
  ) then
    raise exception 'a household must always have at least one owner'
      using errcode = '23514',
            hint = 'Promote another member to owner before removing or demoting the last one.';
  end if;

  return null;
end;
$$;
