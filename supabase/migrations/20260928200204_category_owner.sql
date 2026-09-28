-- Who a category's costs belong to. Null is the household's shared costs,
-- split between the members; a member means that person's own costs (his car
-- loan, her family remittance). The budget groups its lines by this and the
-- household share works out who owes whom from it.
alter table categories
  add column owner_member_id uuid,
  add constraint categories_owner_member_id_fkey
    foreign key (household_id, owner_member_id) references household_members (household_id, id) on delete set null (owner_member_id);

create index categories_owner_member_id_idx on categories (owner_member_id) where owner_member_id is not null;

comment on column categories.owner_member_id is
  'Whose costs these are: null = shared by the household, split by income; a member = that person''s own. Subcategories without one follow their parent.';
