-- Migration 009: Market Data Sweep Columns
-- Adds priority + scheduling columns to pending_litalerts_refresh_queue
-- and expiry/refresh-hint/extra-evidence columns to
-- litalerts_competitor_observations. ALTER-only; safe online.

\echo 'Running migration 009: Market Data Sweep Columns...'

\i ../schema/marketDataSweep.sql

\echo 'Migration 009 complete.'
