-- Dividend tax years (SHR-366; docs/superpowers/specs/2026-11-04-dividend-tax-years-design.md).
--
-- A member who lives outside India has tax withheld from every Indian
-- dividend, files a return each year, and is refunded months later. This
-- stores, per member and tax year, the return's dividend figures and what
-- happened to its refund, the department's statements (the AIS for income,
-- Form 26AS for tax credit), and a dividend's own tax year where it differs
-- from its credit date's. The app works out the rest (src/lib/dividendTax.js).
--
-- Nobody writes these tables directly: the functions below do, and every
-- figure in them was read from a document the household shared and then
-- deleted. No PAN, acknowledgement or account number is ever stored.

-- ---------------------------------------------------------------------------
-- 1. The tables, the tax-year column and who reads them
-- ---------------------------------------------------------------------------

-- A tax year is named by the year it starts in: 2025 is FY 2025-26, from
-- 1 April 2025 to 31 March 2026.
create or replace function private.financial_year_of(p_day date)
returns integer
language sql
immutable
set search_path = ''
as $$
  select extract(year from p_day)::integer - case when extract(month from p_day) < 4 then 1 else 0 end;
$$;

-- Text that looks like a PAN (five letters, four digits, a letter) or holds
-- nine or more digits in a row (an account or acknowledgement number). Notes
-- and payers with either are refused, so neither is ever kept.
create or replace function private.has_identifier(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_text ~* '[a-z]{5}[0-9]{4}[a-z]' or p_text ~ '[0-9]{9,}', false);
$$;

revoke execute on function private.financial_year_of(date) from public, anon, authenticated;
revoke execute on function private.has_identifier(text) from public, anon, authenticated;

-- A member's return for a tax year, created on its first save. Revision 0 is
-- not filed; 1 the original return; 2 and up each revised return. The
-- figures are the latest revision's, and exist only once it is filed. The
-- claim basis is set for each year on its own: a year without one shows
-- facts, never an estimate. A member with returns cannot be removed (no
-- cascade on the member), but deleting the household deletes them.
create table tax_returns (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  member_id uuid not null,
  financial_year integer not null check (financial_year between 2000 and 2100),
  claim_basis text check (claim_basis in ('domestic', 'treaty', 'manual')),
  claim_rate_pct numeric(5,2) check (claim_rate_pct between 0 and 100),
  revision integer not null default 0 check (revision >= 0),
  filed_on date,
  dividend_income numeric(16,2) check (dividend_income >= 0),
  dividend_tax numeric(16,2) check (dividend_tax >= 0),
  dividend_tds_claimed numeric(16,2) check (dividend_tds_claimed >= 0),
  tds_claimed_total numeric(16,2) check (tds_claimed_total >= 0),
  note text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (member_id, financial_year),
  unique (household_id, id),
  foreign key (household_id, member_id) references household_members (household_id, id),
  constraint tax_returns_basis_with_rate check ((claim_basis is null) = (claim_rate_pct is null)),
  constraint tax_returns_filed check ((revision = 0) = (filed_on is null)),
  constraint tax_returns_figures_when_filed check (
    revision > 0 or (dividend_income is null and dividend_tax is null and dividend_tds_claimed is null and tds_claimed_total is null)),
  constraint tax_returns_dividend_tds_within_total check (
    dividend_tds_claimed is null or tds_claimed_total is null or dividend_tds_claimed <= tds_claimed_total),
  constraint tax_returns_note_has_no_identifier check (not private.has_identifier(note) and coalesce(length(note), 0) <= 500)
);

-- What happened to a return, each tied to the revision it concerns. A
-- processing records the return's totals to date (a negative refund is a
-- demand); credits and offsets are money that moved; a failed refund issue
-- moved nothing.
create table tax_return_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  return_id uuid not null,
  revision integer not null check (revision >= 1),
  kind text not null check (kind in ('processed', 'refund_credited', 'offset_against_demand', 'refund_failed')),
  happened_on date not null,
  refund_determined numeric(16,2),
  refund_interest numeric(16,2),
  tds_allowed_total numeric(16,2),
  amount numeric(16,2),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  foreign key (household_id, return_id) references tax_returns (household_id, id) on delete cascade,
  -- Wrapped in coalesce: a check passes on null, and a missing figure must not.
  constraint tax_return_events_figures_by_kind check (coalesce(case kind
    when 'processed' then refund_determined is not null and refund_interest >= 0
      and (tds_allowed_total is null or tds_allowed_total >= 0) and amount is null
    when 'refund_failed' then refund_determined is null and refund_interest is null and tds_allowed_total is null
      and (amount is null or amount > 0)
    else refund_determined is null and refund_interest is null and tds_allowed_total is null and amount > 0
  end, false)),
  constraint tax_return_events_note_has_no_identifier check (not private.has_identifier(note) and coalesce(length(note), 0) <= 500)
);

-- One imported AIS or Form 26AS for a member and tax year. It exists even
-- with no lines, so "imported, nothing reported" differs from "not
-- imported". Its revision grows only when its content changes.
create table tax_statements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  member_id uuid not null,
  financial_year integer not null check (financial_year between 2000 and 2100),
  source text not null check (source in ('ais', '26as')),
  as_of date not null,
  imported_at timestamptz not null default now(),
  revision integer not null default 1 check (revision >= 1),
  unique (member_id, financial_year, source),
  unique (household_id, id),
  foreign key (household_id, member_id) references household_members (household_id, id)
);

-- A payer's figures for the year in one statement. For the AIS, gross is
-- the annual dividend reporting stream only, never added to the gross in its
-- tax entries, which would count the same dividend twice; tds is from its
-- tax entries. For 26AS, the gross paid and the tax deducted, summed over
-- the year. The symbol is the share, or null for a payer Rokda doesn't hold.
create table tax_statement_lines (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  statement_id uuid not null,
  symbol text,
  payer text not null check (length(btrim(payer)) between 1 and 200 and not private.has_identifier(payer)),
  gross numeric(16,2) not null check (gross >= 0),
  tds numeric(16,2) check (tds >= 0 and tds <= gross),
  foreign key (household_id, statement_id) references tax_statements (household_id, id) on delete cascade
);
create unique index tax_statement_lines_one_per_payer on tax_statement_lines (statement_id, lower(btrim(payer)));

-- A dividend's tax year where it differs from its credit date's (a final
-- dividend declared in March and paid in April), with why.
alter table holding_dividends add column tax_financial_year integer check (tax_financial_year between 2000 and 2100);
alter table holding_dividends add column tax_year_basis text check (tax_year_basis in ('declared', 'paid', 'statement', 'household'));
alter table holding_dividends add constraint holding_dividends_tax_year_with_basis
  check ((tax_financial_year is null) = (tax_year_basis is null));

-- Every foreign key has an index led by its own columns.
create index tax_returns_member on tax_returns (household_id, member_id);
create index tax_return_events_return on tax_return_events (household_id, return_id);
create index tax_statements_member on tax_statements (household_id, member_id);
create index tax_statement_lines_statement on tax_statement_lines (household_id, statement_id);

create trigger tax_returns_touch_updated_at before update on tax_returns for each row execute function touch_updated_at();
create trigger tax_return_events_touch_updated_at before update on tax_return_events for each row execute function touch_updated_at();

comment on table tax_returns is 'A member''s Indian return for a tax year: its claim basis, revision and dividend figures. Written only by save_tax_return.';
comment on table tax_return_events is 'What happened to a return: processed, refund credited, offset against a demand, refund failed. Written only by the tax functions.';
comment on table tax_statements is 'An imported AIS or Form 26AS for a member and tax year. Written only by import_tax_statement.';
comment on table tax_statement_lines is 'A payer''s dividend figures for the year in one statement. Written only by import_tax_statement.';

-- A household's tax records are read by its members; nobody writes them
-- through the API.
alter table tax_returns enable row level security;
alter table tax_return_events enable row level security;
alter table tax_statements enable row level security;
alter table tax_statement_lines enable row level security;

create policy "members can read their tax returns" on tax_returns
  for select using (private.is_household_member(household_id));
create policy "members can read what happened to their returns" on tax_return_events
  for select using (private.is_household_member(household_id));
create policy "members can read their tax statements" on tax_statements
  for select using (private.is_household_member(household_id));
create policy "members can read their tax statement lines" on tax_statement_lines
  for select using (private.is_household_member(household_id));

revoke insert, update, delete on tax_returns, tax_return_events, tax_statements, tax_statement_lines from anon, authenticated;
