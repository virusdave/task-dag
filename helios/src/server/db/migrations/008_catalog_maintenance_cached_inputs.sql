-- Migration 008: Catalog Maintenance Cached Inputs
-- Adds METRC tag cache on stock_variant_state and a reanalysis flag on
-- catalog_groups so the /catalog/maintenance page can be served from
-- cached DB data instead of crawling Sweed live.

\echo 'Running migration 008: Catalog Maintenance Cached Inputs...'

\i ../schema/catalogMaintenance.sql

\echo 'Migration 008 complete.'
