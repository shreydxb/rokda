-- edited_by must never be client-trusted: the insert RLS policy only
-- checks the caller belongs to the transaction's household, not that a
-- client-supplied edited_by is a real member of it (or even of that
-- household), which would let an edit be forged with an arbitrary author.
-- Derive it from auth.uid() instead, same trust boundary is_household_member
-- already uses, overriding whatever (if anything) the client sent.
create or replace function set_transaction_edit_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hh_id uuid;
begin
  select household_id into hh_id from transactions where id = new.transaction_id;
  select id into new.edited_by
  from household_members
  where household_id = hh_id and user_id = auth.uid()
  limit 1;
  return new;
end;
$$;

create trigger transaction_edits_set_author
  before insert on transaction_edits
  for each row execute function set_transaction_edit_author();
