-- Migration 026: persisted FuzzySku + catalog/market verdict tables.
--
-- Lays the schema substrate for the Catalog → Market Data reviewer
-- workflow (issue #18). See
-- helios/src/server/db/schema/catalogMarketMatches.sql for column
-- comments and the role of each verdict / source-kind enum value,
-- and docs/helios/catalog-market-data/EPIC_PLAN.md for the full
-- design. Forward-only, additive, idempotent — both tables start
-- empty.

\echo 'Running migration 026: catalog_market_matches + fuzzy_skus...'

\i ../schema/catalogMarketMatches.sql

\echo 'Migration 026 complete.'
