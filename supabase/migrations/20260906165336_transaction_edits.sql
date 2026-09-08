-- Plain audit trail for shared-household edits (SHR-235). One row per
-- changed field, written only when an *existing* transaction is edited —
-- creates have nothing to diff against, so they write nothing here.
create table transaction_edits (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  edited_by uuid references household_members(id) on delete set null,
  edited_at timestamptz not null default now(),
  field text not null,
  old_value text,
  new_value text
);

create index transaction_edits_transaction_id_idx on transaction_edits (transaction_id);

alter table transaction_edits enable row level security;

-- Follows its transaction's household membership, same pattern as
-- holding_value_history following holdings.
create policy "members can read transaction edits" on transaction_edits
  for select using (exists (select 1 from transactions t where t.id = transaction_id and is_household_member(t.household_id)));
create policy "members can write transaction edits" on transaction_edits
  for insert with check (exists (select 1 from transactions t where t.id = transaction_id and is_household_member(t.household_id)));
