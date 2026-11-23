-- The bot's Undo (the revamp, phase 8b; docs/decisions.md, "A tap on Record
-- records, with Undo for ten minutes"). A tap on Record now records an
-- expense through approve_intake, without a typed "yes". The message then
-- offers Undo for ten minutes, which puts the expense back where it was: the
-- recorded transaction is removed and the entry waits again, with its
-- buttons, to be changed and recorded again or discarded.
--
-- Only what the bot itself recorded can be undone: its Undo button names the
-- transaction the bot's own approval made, and an entry approved in the app
-- (by the partner, at another amount, say) is never that one, so it stays.
-- Only the member who sent the entry, who alone can tap its buttons, can undo
-- it, only within ten minutes of its being recorded, and only while nobody has
-- changed the transaction since:
-- an edit (updated_at moved on, or a line in the shared edit history), a split
-- or a link to another record leaves it recorded, to be changed in the app.
-- The bot calls this with its service role, naming the member a Telegram
-- account is linked to, as it does apply_bot_proposal.
create or replace function public.undo_intake_approval(p_intake_id uuid, p_member_id uuid, p_transaction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake public.intake%rowtype;
  v_tx public.transactions%rowtype;
begin
  select * into v_intake from public.intake where id = p_intake_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_intake.member_id is distinct from p_member_id then
    return jsonb_build_object('outcome', 'not_yours');
  end if;
  if v_intake.status <> 'approved' or v_intake.transaction_id is null then
    return jsonb_build_object('outcome', 'not_recorded');
  end if;
  if v_intake.transaction_id is distinct from p_transaction_id then
    return jsonb_build_object('outcome', 'changed');
  end if;

  select * into v_tx from public.transactions where id = v_intake.transaction_id and household_id = v_intake.household_id for update;
  if not found then
    return jsonb_build_object('outcome', 'changed');
  end if;
  if v_tx.created_at < now() - interval '10 minutes' then
    return jsonb_build_object('outcome', 'too_late');
  end if;
  if v_tx.updated_at <> v_tx.created_at
     or v_tx.is_split
     or exists (select 1 from public.transaction_edits e where e.transaction_id = v_tx.id)
     or exists (select 1 from public.transaction_splits s where s.household_id = v_tx.household_id and s.transaction_id = v_tx.id)
     or exists (select 1 from public.transaction_links l where l.household_id = v_tx.household_id and (l.from_transaction_id = v_tx.id or l.to_transaction_id = v_tx.id)) then
    return jsonb_build_object('outcome', 'changed');
  end if;

  update public.intake set status = 'pending', transaction_id = null where id = v_intake.id;
  delete from public.transactions where id = v_tx.id;
  return jsonb_build_object('outcome', 'undone');
end;
$$;

comment on function public.undo_intake_approval(uuid, uuid, uuid) is
  'The bot''s Undo: removes the transaction the bot recorded an entry as (p_transaction_id) and puts the entry back to pending. Only that transaction, for the member who sent the entry, within ten minutes of recording, and only while it is unchanged (no edit, split or link). Returns {outcome}: undone, not_found, not_yours, not_recorded, too_late or changed. For the bot (service_role) only.';

revoke execute on function public.undo_intake_approval(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.undo_intake_approval(uuid, uuid, uuid) to service_role;
