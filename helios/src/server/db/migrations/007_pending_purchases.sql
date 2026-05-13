-- Migration 007: Pending Purchases Tables
-- Creates tables for pending purchase proposal workflow

\echo 'Running migration 007: Pending Purchases Tables...'

-- Import schema definition
\i ../schema/pendingPurchases.sql

\echo 'Migration 007 complete.'
