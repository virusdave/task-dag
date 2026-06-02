-- Migration 045: per-user metric subpage grants.
--
-- Adds a text[] column to users so non-admin operators can be
-- granted access to individual Metrics → subpages (Explore,
-- Brands, Distributors, Staff, Reordering) without making them
-- full admins. The admin role implicitly carries every grant
-- regardless of this column's value (enforced in
-- shared/domain/metricGrants.ts and the server gate helpers).
--
-- Default is the empty set so existing non-admin users see no
-- metric pages by default — matches the prior admin-only stance.

alter table users
  add column if not exists metric_grants text[] not null default '{}'::text[];

-- Trivial index makes "give me every user with the X grant" queries
-- cheap if we ever surface that as an admin filter. Negligible
-- write cost; the users table is tiny.
create index if not exists users_metric_grants_gin_idx
  on users using gin (metric_grants);
