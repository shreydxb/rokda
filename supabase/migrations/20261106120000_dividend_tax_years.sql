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

-- ---------------------------------------------------------------------------
-- 3. Returns and what happened to them
-- ---------------------------------------------------------------------------

-- Whose return a call is about, and who is making it: a signed-in member of
-- that member's household, or the service role acting as the member named.
-- Any member of the household may keep any member's return.
create or replace function private.tax_caller(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_actor uuid;
begin
  select m.household_id into v_household from public.household_members m where m.id = p_member_id;
  if v_household is not null then
    v_actor := private.trade_caller(v_household, p_member_id);
  end if;
  if v_actor is null then
    return jsonb_build_object('error', 'not_member');
  end if;
  return jsonb_build_object('household', v_household, 'member', p_member_id, 'actor', v_actor);
end;
$$;

-- An amount as these tables keep it: rupees, not below zero, to the paisa.
create or replace function private.tax_amount_ok(p_amount numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_amount is null or (p_amount >= 0 and p_amount = round(p_amount, 2) and p_amount < 1e14);
$$;

-- A JSON value of the type a field takes: a number, a string, or null.
create or replace function private.tax_json_is(p_value jsonb, p_type text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is null or jsonb_typeof(p_value) in (p_type, 'null');
$$;

-- Saves a member's return for a year at the version it was changed against
-- (0 when it has none yet). Only the listed fields can change; a field given
-- as null clears it. Nothing is saved when any rule is broken, and the
-- refusal names the first.
create or replace function public.save_tax_return(p_member_id uuid, p_financial_year integer, p_change jsonb, p_expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.tax_caller(p_member_id);
  v_today date := public.household_today();
  r public.tax_returns%rowtype;
  v_found boolean;
  v_key text;
  v_figure numeric;
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if jsonb_typeof(p_change) is distinct from 'object' or p_expected_version is null
     or p_financial_year is null or p_financial_year < 2000 or p_financial_year > private.financial_year_of(v_today)
     or exists (select 1 from jsonb_object_keys(p_change) k where k not in (
       'claim_basis', 'claim_rate_pct', 'revision', 'filed_on', 'dividend_income', 'dividend_tax', 'dividend_tds_claimed', 'tds_claimed_total', 'note'))
     or not private.tax_json_is(p_change -> 'claim_basis', 'string') or not private.tax_json_is(p_change -> 'note', 'string')
     or not private.tax_json_is(p_change -> 'filed_on', 'string')
     or jsonb_typeof(p_change -> 'revision') = 'null' or not private.tax_json_is(p_change -> 'revision', 'number')
     or exists (select 1 from unnest(array['claim_rate_pct', 'dividend_income', 'dividend_tax', 'dividend_tds_claimed', 'tds_claimed_total']) k
       where not private.tax_json_is(p_change -> k, 'number')) then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  -- Checked as given: a row variable would round 10.005 to 10.01 unseen.
  if exists (select 1 from unnest(array['dividend_income', 'dividend_tax', 'dividend_tds_claimed', 'tds_claimed_total']) k
             where not private.tax_amount_ok((p_change ->> k)::numeric)) then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  if (p_change ->> 'claim_rate_pct')::numeric <> round((p_change ->> 'claim_rate_pct')::numeric, 2) then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  select * into r from public.tax_returns t where t.member_id = p_member_id and t.financial_year = p_financial_year for update;
  v_found := found;
  if coalesce(r.version, 0) <> p_expected_version then
    return jsonb_build_object('ok', false, 'error', 'stale');
  end if;
  if not v_found then
    r.revision := 0;
  end if;

  begin
    if p_change ? 'claim_basis' then r.claim_basis := p_change ->> 'claim_basis'; end if;
    if p_change ? 'claim_rate_pct' then r.claim_rate_pct := (p_change ->> 'claim_rate_pct')::numeric; end if;
    if p_change ? 'revision' then r.revision := (p_change ->> 'revision')::numeric; end if;
    if p_change ? 'filed_on' then r.filed_on := (p_change ->> 'filed_on')::date; end if;
    if p_change ? 'dividend_income' then r.dividend_income := (p_change ->> 'dividend_income')::numeric; end if;
    if p_change ? 'dividend_tax' then r.dividend_tax := (p_change ->> 'dividend_tax')::numeric; end if;
    if p_change ? 'dividend_tds_claimed' then r.dividend_tds_claimed := (p_change ->> 'dividend_tds_claimed')::numeric; end if;
    if p_change ? 'tds_claimed_total' then r.tds_claimed_total := (p_change ->> 'tds_claimed_total')::numeric; end if;
    if p_change ? 'note' then r.note := nullif(btrim(p_change ->> 'note'), ''); end if;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end;
  if p_change ? 'revision' and (p_change ->> 'revision')::numeric <> r.revision then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;

  if (r.claim_basis is null) <> (r.claim_rate_pct is null) then
    return jsonb_build_object('ok', false, 'error', 'basis_needs_rate');
  end if;
  if r.claim_basis not in ('domestic', 'treaty', 'manual') or r.claim_rate_pct not between 0 and 100
     or r.claim_rate_pct <> round(r.claim_rate_pct, 2) or r.revision < 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  if r.revision >= 1 and r.filed_on is null then
    return jsonb_build_object('ok', false, 'error', 'filed_on_needed');
  end if;
  if r.revision = 0 and (r.filed_on is not null or r.dividend_income is not null or r.dividend_tax is not null
     or r.dividend_tds_claimed is not null or r.tds_claimed_total is not null) then
    return jsonb_build_object('ok', false, 'error', 'not_filed');
  end if;
  if r.filed_on < make_date(p_financial_year + 1, 4, 1) then
    return jsonb_build_object('ok', false, 'error', 'filed_before_year_end');
  end if;
  if r.filed_on > v_today then
    return jsonb_build_object('ok', false, 'error', 'in_future');
  end if;
  foreach v_figure in array array[r.dividend_income, r.dividend_tax, r.dividend_tds_claimed, r.tds_claimed_total] loop
    if not private.tax_amount_ok(v_figure) then
      return jsonb_build_object('ok', false, 'error', 'bad_figures');
    end if;
  end loop;
  if r.dividend_tds_claimed > r.tds_claimed_total then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  if private.has_identifier(r.note) then
    return jsonb_build_object('ok', false, 'error', 'identifier_in_text');
  end if;
  if length(r.note) > 500 then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  if v_found and r.revision < (select coalesce(max(e.revision), 0) from public.tax_return_events e where e.return_id = r.id) then
    return jsonb_build_object('ok', false, 'error', 'events_on_later_revision');
  end if;

  if not v_found then
    begin
      insert into public.tax_returns (household_id, member_id, financial_year, claim_basis, claim_rate_pct, revision, filed_on,
        dividend_income, dividend_tax, dividend_tds_claimed, tds_claimed_total, note, updated_by)
      values ((v_caller ->> 'household')::uuid, p_member_id, p_financial_year, r.claim_basis, r.claim_rate_pct, r.revision, r.filed_on,
        r.dividend_income, r.dividend_tax, r.dividend_tds_claimed, r.tds_claimed_total, r.note, (v_caller ->> 'actor')::uuid)
      returning id into r.id;
    exception when unique_violation then
      -- Another first save of the same year committed while this one checked.
      return jsonb_build_object('ok', false, 'error', 'stale');
    end;
    return jsonb_build_object('ok', true, 'id', r.id, 'version', 1);
  end if;
  update public.tax_returns
  set claim_basis = r.claim_basis, claim_rate_pct = r.claim_rate_pct, revision = r.revision, filed_on = r.filed_on,
      dividend_income = r.dividend_income, dividend_tax = r.dividend_tax, dividend_tds_claimed = r.dividend_tds_claimed,
      tds_claimed_total = r.tds_claimed_total, note = r.note, version = version + 1, updated_by = (v_caller ->> 'actor')::uuid
  where id = r.id;
  return jsonb_build_object('ok', true, 'id', r.id, 'version', r.version + 1);
end;
$$;

-- Adds what happened to a filed return, or with an id replaces it: a
-- processing (the return's totals to date; a negative refund is a demand),
-- a refund credited, an amount set against a demand, or a failed refund.
-- It is tied to the return's current revision unless it names an earlier one.
create or replace function public.save_tax_return_event(p_member_id uuid, p_financial_year integer, p_event jsonb, p_event_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.tax_caller(p_member_id);
  v_today date := public.household_today();
  r public.tax_returns%rowtype;
  e public.tax_return_events%rowtype;
  v_kind text;
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if jsonb_typeof(p_event) is distinct from 'object' or p_financial_year is null
     or exists (select 1 from jsonb_object_keys(p_event) k where k not in (
       'kind', 'revision', 'happened_on', 'refund_determined', 'refund_interest', 'tds_allowed_total', 'amount', 'note'))
     or jsonb_typeof(p_event -> 'kind') is distinct from 'string' or jsonb_typeof(p_event -> 'happened_on') is distinct from 'string'
     or not private.tax_json_is(p_event -> 'revision', 'number') or not private.tax_json_is(p_event -> 'note', 'string')
     or exists (select 1 from unnest(array['refund_determined', 'refund_interest', 'tds_allowed_total', 'amount']) k
       where not private.tax_json_is(p_event -> k, 'number')) then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  select * into r from public.tax_returns t where t.member_id = p_member_id and t.financial_year = p_financial_year for update;
  if not found or r.revision = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_filed');
  end if;
  if p_event_id is not null and not exists (select 1 from public.tax_return_events x where x.id = p_event_id and x.return_id = r.id) then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;

  if exists (select 1 from unnest(array['refund_determined', 'refund_interest', 'tds_allowed_total', 'amount']) k
             where not private.tax_amount_ok(abs((p_event ->> k)::numeric))) then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  begin
    v_kind := p_event ->> 'kind';
    e.revision := coalesce((p_event ->> 'revision')::numeric, r.revision);
    e.happened_on := (p_event ->> 'happened_on')::date;
    e.refund_determined := (p_event ->> 'refund_determined')::numeric;
    e.refund_interest := (p_event ->> 'refund_interest')::numeric;
    e.tds_allowed_total := (p_event ->> 'tds_allowed_total')::numeric;
    e.amount := (p_event ->> 'amount')::numeric;
    e.note := nullif(btrim(p_event ->> 'note'), '');
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end;
  if v_kind not in ('processed', 'refund_credited', 'offset_against_demand', 'refund_failed')
     or (p_event ? 'revision' and (p_event ->> 'revision')::numeric <> e.revision) or e.revision not between 1 and r.revision
     or e.happened_on < make_date(p_financial_year + 1, 4, 1) or length(e.note) > 500 then
    return jsonb_build_object('ok', false, 'error', 'bad_input');
  end if;
  if e.happened_on > v_today then
    return jsonb_build_object('ok', false, 'error', 'in_future');
  end if;
  -- A demand is the one figure below zero.
  if not (private.tax_amount_ok(abs(e.refund_determined)) and private.tax_amount_ok(e.refund_interest)
          and private.tax_amount_ok(e.tds_allowed_total) and private.tax_amount_ok(e.amount))
     or not coalesce(case v_kind
       when 'processed' then e.refund_determined is not null and e.refund_interest is not null and e.amount is null
       when 'refund_failed' then e.refund_determined is null and e.refund_interest is null and e.tds_allowed_total is null
         and (e.amount is null or e.amount > 0)
       else e.refund_determined is null and e.refund_interest is null and e.tds_allowed_total is null and e.amount > 0
     end, false) then
    return jsonb_build_object('ok', false, 'error', 'bad_figures');
  end if;
  if private.has_identifier(e.note) then
    return jsonb_build_object('ok', false, 'error', 'identifier_in_text');
  end if;

  if p_event_id is null then
    insert into public.tax_return_events (household_id, return_id, revision, kind, happened_on, refund_determined, refund_interest,
      tds_allowed_total, amount, note, updated_by)
    values (r.household_id, r.id, e.revision, v_kind, e.happened_on, e.refund_determined, e.refund_interest,
      e.tds_allowed_total, e.amount, e.note, (v_caller ->> 'actor')::uuid)
    returning id into e.id;
  else
    e.id := p_event_id;
    update public.tax_return_events
    set revision = e.revision, kind = v_kind, happened_on = e.happened_on, refund_determined = e.refund_determined,
        refund_interest = e.refund_interest, tds_allowed_total = e.tds_allowed_total, amount = e.amount, note = e.note,
        updated_by = (v_caller ->> 'actor')::uuid
    where id = e.id;
  end if;
  return jsonb_build_object('ok', true, 'id', e.id);
end;
$$;

-- Removes something recorded against a member's return.
create or replace function public.remove_tax_return_event(p_member_id uuid, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller jsonb := private.tax_caller(p_member_id);
begin
  if v_caller ? 'error' then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  delete from public.tax_return_events e
  using public.tax_returns t
  where e.id = p_event_id and t.id = e.return_id and t.member_id = p_member_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'event_not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function private.tax_caller(uuid) from public, anon, authenticated;
revoke execute on function private.tax_amount_ok(numeric) from public, anon, authenticated;
revoke execute on function private.tax_json_is(jsonb, text) from public, anon, authenticated;
revoke execute on function public.save_tax_return(uuid, integer, jsonb, integer) from public, anon;
revoke execute on function public.save_tax_return_event(uuid, integer, jsonb, uuid) from public, anon;
revoke execute on function public.remove_tax_return_event(uuid, uuid) from public, anon;
grant execute on function public.save_tax_return(uuid, integer, jsonb, integer) to authenticated, service_role;
grant execute on function public.save_tax_return_event(uuid, integer, jsonb, uuid) to authenticated, service_role;
grant execute on function public.remove_tax_return_event(uuid, uuid) to authenticated, service_role;
