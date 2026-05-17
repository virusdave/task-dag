-- Catalog Maintenance Cached Inputs
--
-- The /catalog/maintenance page now serves from cached Helios DB data
-- instead of crawling Sweed live on every page render. To do that we
-- need two additional cached signals that the existing tables did not
-- previously carry:
--
--   1. The set of METRC tags currently observed per (site, product)
--      in-stock row. UI shows the tail of each tag so an operator can
--      walk to the shelf and pull the package. We piggy-back on the
--      existing stock_variant_state row that the stock refresh worker
--      already maintains.
--
--   2. An explicit "needs reanalysis at" timestamp on catalog_groups.
--      The server sets this when an operator uploads a fix; the worker
--      that reanalyzes the group clears it. The page renders any group
--      with a non-null needs_reanalysis_at as "syncing…" so the user
--      sees their pending edit even before the worker catches up.

alter table stock_variant_state
  add column if not exists metrc_tags_json jsonb not null default '[]'::jsonb;

alter table catalog_groups
  add column if not exists needs_reanalysis_at timestamptz,
  add column if not exists needs_reanalysis_reason text;

create index if not exists catalog_groups_needs_reanalysis_idx
  on catalog_groups (needs_reanalysis_at)
  where needs_reanalysis_at is not null;
