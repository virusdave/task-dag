-- Migration 107: dedicated role for agent/headless production reads.
--
-- The role is created NOLOGIN with no credential. Credential generation,
-- LOGIN enablement, and agenix encryption are a separate operator-approved
-- provisioning step, so no reusable secret can enter this artifact or psql's
-- migration logs.
--
-- Only public-schema relations owned by tsdbadmin are Helios application data.
-- This intentionally excludes extension-owned diagnostic views such as
-- pg_stat_statements and pg_buffercache.

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 107: Helios agent read-only role...'

begin;
set local lock_timeout = '5s';

do $$
declare
  readonly_role_oid oid;
begin
  if current_database() <> 'tsdb' or current_user <> 'tsdbadmin' then
    raise exception 'migration 107 must run as tsdbadmin against tsdb (got %@%)',
      current_user, current_database();
  end if;

  select oid into readonly_role_oid
    from pg_roles
   where rolname = 'helios_agent_readonly';

  if readonly_role_oid is null then
    return;
  end if;

  if coalesce(shobj_description(readonly_role_oid, 'pg_authid'), '') <>
      'Managed by Helios migration 107; agent/headless production reads only.' then
    raise exception 'refusing to adopt unmanaged existing role helios_agent_readonly';
  end if;

  if exists (
    select 1 from pg_roles
     where oid = readonly_role_oid
       and (rolsuper or rolcreatedb or rolcreaterole or rolinherit or
            rolreplication or rolbypassrls or rolconnlimit <> 20)
  ) then
    raise exception 'helios_agent_readonly has unexpected role attributes';
  end if;

  if exists (
    select 1 from pg_auth_members
     where member = readonly_role_oid
  ) then
    raise exception 'helios_agent_readonly must not be a member of another role';
  end if;

  if exists (select 1 from pg_class where relowner = readonly_role_oid)
     or exists (select 1 from pg_namespace where nspowner = readonly_role_oid)
     or exists (select 1 from pg_proc where proowner = readonly_role_oid) then
    raise exception 'helios_agent_readonly must not own database objects';
  end if;

  if has_database_privilege(readonly_role_oid, current_database(), 'create') then
    raise exception 'helios_agent_readonly has unexpected database CREATE';
  end if;

  if exists (
       select 1
         from pg_namespace n
        where n.nspname <> 'information_schema'
          and n.nspname not like 'pg_%'
          and has_schema_privilege(readonly_role_oid, n.oid, 'create')
     ) then
    raise exception 'helios_agent_readonly has unexpected persistent-schema CREATE';
  end if;

  if exists (
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname <> 'information_schema'
          and n.nspname not like 'pg_%'
          and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and (
            has_table_privilege(readonly_role_oid, c.oid, 'insert')
            or has_table_privilege(readonly_role_oid, c.oid, 'update')
            or has_table_privilege(readonly_role_oid, c.oid, 'delete')
            or has_table_privilege(readonly_role_oid, c.oid, 'truncate')
            or has_table_privilege(readonly_role_oid, c.oid, 'references')
            or has_table_privilege(readonly_role_oid, c.oid, 'trigger')
            or has_table_privilege(readonly_role_oid, c.oid, 'maintain')
          )
     ) then
    raise exception 'helios_agent_readonly has unexpected table mutation privileges';
  end if;

  if exists (
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname <> 'information_schema'
          and n.nspname not like 'pg_%'
          and c.relkind = 'S'
          and (
            has_sequence_privilege(readonly_role_oid, c.oid, 'select')
            or has_sequence_privilege(readonly_role_oid, c.oid, 'usage')
            or has_sequence_privilege(readonly_role_oid, c.oid, 'update')
          )
     ) then
    raise exception 'helios_agent_readonly has unexpected sequence privileges';
  end if;
end
$$;

select format(
  'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 20 password null',
  'helios_agent_readonly'
)
where not exists (
  select 1 from pg_roles where rolname = 'helios_agent_readonly'
)
\gexec

comment on role helios_agent_readonly is
  'Managed by Helios migration 107; agent/headless production reads only.';

-- Defense in depth. Object privileges below remain the security boundary;
-- these defaults also make accidental writes fail before PostgreSQL plans
-- them and keep abandoned agent queries bounded.
alter role helios_agent_readonly set default_transaction_read_only = on;
alter role helios_agent_readonly set statement_timeout = '2min';
alter role helios_agent_readonly set idle_in_transaction_session_timeout = '1min';

grant connect on database tsdb to helios_agent_readonly;
grant usage on schema public to helios_agent_readonly;

select format(
  'grant select on table %I.%I to helios_agent_readonly',
  n.nspname,
  c.relname
)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and c.relowner = (select oid from pg_roles where rolname = 'tsdbadmin')
order by c.relname
\gexec

-- Future Helios relations are owned by tsdbadmin. Keep the read-only grant
-- current without granting sequence mutation or function privileges.
alter default privileges for role tsdbadmin in schema public
  grant select on tables to helios_agent_readonly;

commit;

\echo 'Migration 107 complete. The role remains NOLOGIN; provision it separately.'
