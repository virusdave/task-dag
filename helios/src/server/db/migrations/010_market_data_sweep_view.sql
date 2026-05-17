-- Migration 010: Market Data Sweep View
-- Creates the vw_pricing_evidence_freshness view used by the scheduler
-- and the SPA to reason about per-product market-data freshness.

\echo 'Running migration 010: Market Data Sweep View...'

\i ../schema/pricingEvidenceFreshness.sql

\echo 'Migration 010 complete.'
