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

-- ---------------------------------------------------------------------------
-- 2. Importing a statement
-- ---------------------------------------------------------------------------

-- An AIS or Form 26AS for a member and tax year, as read in a working
-- session from the household's document. Only the service role imports.
-- Every line is checked before anything is written; a refusal names the
-- line (from 0). The member, year and source are then locked, so two imports
-- of one statement wait for each other: the same content again is a no-op,
-- content changed since the caller looked (its expected revision, 0 for
-- none) is stale, and an older statement does not replace a newer one
-- unless the caller says so.
create or replace function public.import_tax_statement(
  p_member_id uuid, p_financial_year integer, p_source text, p_as_of date, p_lines jsonb, p_expected_revision integer,
  p_replace_newer boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_today date := public.household_today();
  v_line jsonb;
  v_i integer;
  v_gross numeric;
  v_tds numeric;
  v_payer text;
  v_symbol text;
  v_keys text[] := '{}';
  v_lines jsonb := '[]'::jsonb;
  v_held public.tax_statements%rowtype;
  v_held_lines jsonb;
  v_id uuid;
begin
  if auth.uid() is not null or auth.role() is distinct from 'service_role' then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select m.household_id into v_household from public.household_members m where m.id = p_member_id;
  if v_household is null then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if p_source is null or p_source not in ('ais', '26as')
     or p_financial_year is null or p_financial_year < 2000 or p_financial_year > private.financial_year_of(v_today)
     or p_as_of is null or p_as_of < make_date(p_financial_year, 4, 1) or p_as_of > v_today
     or p_expected_revision is null or p_expected_revision < 0
     or jsonb_typeof(p_lines) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  for v_line, v_i in select l.value, l.ordinality - 1 from jsonb_array_elements(p_lines) with ordinality l loop
    if jsonb_typeof(v_line) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_line) k where k not in ('symbol', 'payer', 'gross', 'tds'))
       or jsonb_typeof(v_line -> 'gross') is distinct from 'number'
       or coalesce(jsonb_typeof(v_line -> 'tds'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(v_line -> 'symbol'), 'null') not in ('string', 'null')
       or jsonb_typeof(v_line -> 'payer') is distinct from 'string' then
      return jsonb_build_object('ok', false, 'error', 'bad_input', 'line', v_i);
    end if;
    v_gross := (v_line ->> 'gross')::numeric;
    v_tds := (v_line ->> 'tds')::numeric;
    if v_gross < 0 or v_gross <> round(v_gross, 2) or v_gross >= 1e14
       or (v_tds is not null and (v_tds < 0 or v_tds <> round(v_tds, 2) or v_tds > v_gross))
       or (p_source = '26as' and v_tds is null) then
      return jsonb_build_object('ok', false, 'error', 'bad_figures', 'line', v_i);
    end if;
    v_payer := btrim(v_line ->> 'payer');
    if length(v_payer) not between 1 and 200 then
      return jsonb_build_object('ok', false, 'error', 'bad_input', 'line', v_i);
    end if;
    if private.has_identifier(v_payer) then
      return jsonb_build_object('ok', false, 'error', 'identifier_in_text', 'line', v_i);
    end if;
    v_symbol := null;
    if v_line ->> 'symbol' is not null then
      -- The holding's own spelling, so the check pairs the line with its dividends.
      select h.price_symbol into v_symbol from public.holdings h
      where h.household_id = v_household and h.asset_class = 'india_equity' and upper(h.price_symbol) = upper(btrim(v_line ->> 'symbol'))
      order by h.price_symbol limit 1;
      if v_symbol is null then
        return jsonb_build_object('ok', false, 'error', 'unknown_share', 'line', v_i);
      end if;
    end if;
    if lower(v_payer) = any (v_keys) then
      return jsonb_build_object('ok', false, 'error', 'duplicate_payer', 'line', v_i);
    end if;
    v_keys := v_keys || lower(v_payer);
    v_lines := v_lines || jsonb_build_object('symbol', v_symbol, 'payer', v_payer,
      'gross', v_gross::numeric(16,2), 'tds', v_tds::numeric(16,2));
  end loop;

  perform pg_advisory_xact_lock(hashtextextended('tax_statement:' || p_member_id || ':' || p_financial_year || ':' || p_source, 0));
  select * into v_held from public.tax_statements s
  where s.member_id = p_member_id and s.financial_year = p_financial_year and s.source = p_source
  for update;
  -- Both sides as the table holds them, in one order, so equal content compares equal.
  select coalesce(jsonb_agg(x.value order by lower(x.value ->> 'payer')), '[]'::jsonb) into v_lines from jsonb_array_elements(v_lines) x;
  if v_held.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('symbol', l.symbol, 'payer', l.payer, 'gross', l.gross, 'tds', l.tds)
      order by lower(btrim(l.payer))), '[]'::jsonb) into v_held_lines
    from public.tax_statement_lines l where l.statement_id = v_held.id;
    if v_held.as_of = p_as_of and v_held_lines = v_lines then
      return jsonb_build_object('ok', true, 'statement_id', v_held.id, 'revision', v_held.revision,
        'lines', jsonb_array_length(v_lines), 'unchanged', true);
    end if;
  end if;
  if coalesce(v_held.revision, 0) <> p_expected_revision then
    return jsonb_build_object('ok', false, 'error', 'stale');
  end if;
  if v_held.id is not null and p_as_of < v_held.as_of and not coalesce(p_replace_newer, false) then
    return jsonb_build_object('ok', false, 'error', 'older_than_held');
  end if;

  if v_held.id is null then
    insert into public.tax_statements (household_id, member_id, financial_year, source, as_of)
    values (v_household, p_member_id, p_financial_year, p_source, p_as_of)
    returning id into v_id;
  else
    v_id := v_held.id;
    update public.tax_statements set as_of = p_as_of, imported_at = now(), revision = revision + 1 where id = v_id;
    delete from public.tax_statement_lines where statement_id = v_id;
  end if;
  insert into public.tax_statement_lines (household_id, statement_id, symbol, payer, gross, tds)
  select v_household, v_id, x.value ->> 'symbol', x.value ->> 'payer', (x.value ->> 'gross')::numeric, (x.value ->> 'tds')::numeric
  from jsonb_array_elements(v_lines) x;
  return jsonb_build_object('ok', true, 'statement_id', v_id, 'revision', coalesce(v_held.revision, 0) + 1,
    'lines', jsonb_array_length(v_lines), 'unchanged', false);
end;
$$;

revoke execute on function public.import_tax_statement(uuid, integer, text, date, jsonb, integer, boolean) from public, anon, authenticated;
grant execute on function public.import_tax_statement(uuid, integer, text, date, jsonb, integer, boolean) to service_role;
