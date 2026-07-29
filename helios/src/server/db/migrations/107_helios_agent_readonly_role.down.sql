-- Inverse of migration 107. Stop read-only callers, drain their sessions, and
-- revert credential provisioning before running this file.

\set ON_ERROR_STOP on
\timing on

do $$
begin
  if current_database() <> 'tsdb' or current_user <> 'tsdbadmin' then
    raise exception 'migration 107 down must run as tsdbadmin against tsdb';
  end if;
end
$$;

-- Commit the login disable before revoking anything. NOLOGIN only prevents
-- new sessions; the operator must drain existing sessions first.
select 'alter role helios_agent_readonly nologin'
where exists (select 1 from pg_roles where rolname = 'helios_agent_readonly')
\gexec

begin;
set local lock_timeout = '5s';

select
  'alter default privileges for role tsdbadmin in schema public revoke select on tables from helios_agent_readonly'
where exists (select 1 from pg_roles where rolname = 'helios_agent_readonly')
\gexec

select format(
  'revoke select on table %I.%I from helios_agent_readonly',
  n.nspname,
  c.relname
)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and c.relowner = (select oid from pg_roles where rolname = 'tsdbadmin')
  and exists (select 1 from pg_roles where rolname = 'helios_agent_readonly')
order by c.relname
\gexec

select 'revoke connect on database tsdb from helios_agent_readonly'
where exists (select 1 from pg_roles where rolname = 'helios_agent_readonly')
\gexec

select 'revoke usage on schema public from helios_agent_readonly'
where exists (select 1 from pg_roles where rolname = 'helios_agent_readonly')
\gexec

drop role if exists helios_agent_readonly;

commit;

\echo 'Migration 107 down complete.'
