-- What the database defines, one row per object: kind, name, and an md5 of
-- its definition as Postgres reads it back. Run against production and
-- against a database built fresh from supabase/migrations, the two lists
-- must match (scripts/compare-catalog.mjs; outside review, F-02). Matching
-- migration history proves the right scripts ran; this proves the result is
-- still what they made: nothing changed by hand in the dashboard since.
--
-- The schemas the repository owns (public, private), minus anything an
-- extension created, which follows the extension's version rather than this
-- repository. Owners and grants are left out: the platform sets them
-- differently from a plain Postgres, and the RLS suite tests what they allow.
--
-- Line endings are read as \n. A function body is kept exactly as it was
-- sent, and 53 of production's arrived from an editor that saved \r\n; the
-- code is the same, and counting that as a change would make every release
-- check fail on it.
with fns as (
  select p.oid, n.nspname, p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
rels as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
)
select kind, name, md5(replace(def, E'\r\n', E'\n')) as hash from (
  select 'function' as kind, f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')' as name,
         pg_get_functiondef(f.oid) as def
  from fns f
  union all
  select 'column', r.nspname || '.' || r.relname || '.' || a.attname,
         format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
           || coalesce(' default ' || pg_get_expr(ad.adbin, ad.adrelid), '')
           || case when a.attgenerated <> '' then ' generated' else '' end
  from rels r
  join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef ad on ad.adrelid = r.oid and ad.adnum = a.attnum
  where r.relkind in ('r', 'p', 'v', 'm')
  union all
  select 'constraint', r.nspname || '.' || r.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
  from rels r join pg_constraint con on con.conrelid = r.oid
  union all
  select 'index', r.nspname || '.' || r.relname, pg_get_indexdef(r.oid)
  from rels r where r.relkind = 'i'
  union all
  select 'policy', r.nspname || '.' || r.relname || '.' || pol.polname,
         pol.polcmd::text || ' ' || pol.polpermissive::text || ' '
           || coalesce((select string_agg(rolname, ',' order by rolname) from pg_roles where oid = any(pol.polroles)), 'public')
           || ' using ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
           || ' check ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
  from rels r join pg_policy pol on pol.polrelid = r.oid
  union all
  select 'trigger', r.nspname || '.' || r.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
  from rels r join pg_trigger t on t.tgrelid = r.oid and not t.tgisinternal
  union all
  select 'view', r.nspname || '.' || r.relname, pg_get_viewdef(r.oid)
  from rels r where r.relkind in ('v', 'm')
  union all
  select 'row security', r.nspname || '.' || r.relname, r.relrowsecurity::text || ' ' || r.relforcerowsecurity::text
  from rels r where r.relkind in ('r', 'p')
) objects
order by kind, name;
