-- Supabase's default privileges grant EXECUTE on new public-schema
-- functions directly to anon/authenticated/service_role, not just PUBLIC —
-- the previous revoke from public alone didn't touch those. Revoke from the
-- actual roles the linter flagged.
revoke execute on function set_transaction_edit_author() from anon, authenticated;
