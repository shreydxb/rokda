-- What the database defines, one row per object: kind, name, and an md5 of
-- its definition as Postgres reads it back. Run against production and
-- against a database built fresh from supabase/migrations, the two lists
-- must match (scripts/compare-catalog.mjs; outside review, F-02). Matching
-- migration history proves the right scripts ran; this proves the result is
-- still what they made: nothing changed by hand in the dashboard since.
--
-- The schemas the repository owns (public, private), minus anything an
-- extension created, which follows the extension's version rather than this
-- repository; and from storage, the receipt photos' policy and bucket, which
-- a migration makes. Owners and raw grants are left out, since the platform
-- sets them differently from a plain Postgres. What signed-out (anon) and
-- signed-in (authenticated) callers may actually do is compared instead, as
-- 'access' rows: execute on each function, select, insert, update and delete
-- on each table, usage on each schema.
--
-- Three rules keep it from differing for nothing:
--
--   * Line endings are read as \n. A function body is kept exactly as it was
--     sent, and 53 of production's arrived from an editor that saved \r\n.
--   * The search_path is fixed for the query, because pg_get_expr and
--     pg_get_functiondef qualify names by what the caller's path can see.
--     It is set inside a transaction, so a pooled connection keeps it.
--   * NOT NULL appears once, on the column. Postgres 18 also lists it as a
--     constraint (contype 'n'), which a 17 server does not.
\set QUIET on
begin;
set local search_path = public, extensions;

with fns as (
  select p.oid, n.nspname, p.proname, p.prokind
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
rels as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
),
callers(role) as (values ('anon'), ('authenticated'))
select kind, name, md5(replace(def, E'\r\n', E'\n')) as hash from (
  -- pg_get_functiondef refuses an aggregate; one is named, not described.
  select 'function' as kind, f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')' as name,
         case when f.prokind = 'a' then 'aggregate' else pg_get_functiondef(f.oid) end as def
  from fns f
  union all
  select 'column', r.nspname || '.' || r.relname || '.' || a.attname,
         format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
           || coalesce(' default ' || pg_get_expr(ad.adbin, ad.adrelid), '')
           || case when a.attgenerated <> '' then ' generated' else '' end
           || case when a.attidentity <> '' then ' identity ' || a.attidentity::text else '' end
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef ad on ad.adrelid = r.oid and ad.adnum = a.attnum
  where r.relkind in ('r', 'p', 'v', 'm')
  union all
  select 'constraint', r.nspname || '.' || r.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
  from rels r join pg_constraint con on con.conrelid = r.oid
  where con.contype::text <> 'n'
  union all
  select 'index', r.nspname || '.' || r.relname, pg_get_indexdef(r.oid)
  from rels r where r.relkind = 'i'
  union all
  select 'policy', n.nspname || '.' || c.relname || '.' || pol.polname,
         pol.polcmd::text || ' ' || pol.polpermissive::text || ' '
           || coalesce((select string_agg(rolname, ',' order by rolname) from pg_roles where oid = any(pol.polroles)), 'public')
           || ' using ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
           || ' check ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where pol.polrelid in (select oid from rels) or pol.polrelid = to_regclass('storage.objects')
  union all
  -- The trigger's definition does not say whether it is switched on.
  select 'trigger', r.nspname || '.' || r.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled ' || t.tgenabled::text
  from rels r join pg_trigger t on t.tgrelid = r.oid and not t.tgisinternal
  union all
  select 'view', r.nspname || '.' || r.relname, pg_get_viewdef(r.oid)
  from rels r where r.relkind in ('v', 'm')
  union all
  select 'row security', r.nspname || '.' || r.relname, r.relrowsecurity::text || ' ' || r.relforcerowsecurity::text
  from rels r where r.relkind in ('r', 'p')
  union all
  select 'bucket', b.id, 'public ' || b.public::text from storage.buckets b
  union all
  select 'access', f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')',
         (select string_agg(c.role || ' ' || has_function_privilege(c.role, f.oid, 'execute')::text, ', ' order by c.role) from callers c)
  from fns f
  union all
  select 'access', r.nspname || '.' || r.relname,
         (select string_agg(c.role || ' ' || concat_ws(',',
                    case when has_table_privilege(c.role, r.oid, 'select') then 'select' end,
                    case when has_table_privilege(c.role, r.oid, 'insert') then 'insert' end,
                    case when has_table_privilege(c.role, r.oid, 'update') then 'update' end,
                    case when has_table_privilege(c.role, r.oid, 'delete') then 'delete' end), ', ' order by c.role)
          from callers c)
  from rels r where r.relkind in ('r', 'p', 'v', 'm')
  union all
  select 'access', 'schema ' || s.nspname,
         (select string_agg(c.role || ' ' || has_schema_privilege(c.role, s.nspname, 'usage')::text, ', ' order by c.role) from callers c)
  from (values ('public'), ('private')) s(nspname)
) objects
order by kind, name;

commit;
