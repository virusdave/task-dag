-- Migration 018: White-label Bulk-Flower Pricing Snapshots
-- Adds the whitelabel_pricing_snapshots table that backs the
-- Catalog→WhiteLabel→Pricing editor and the public bulk-flower menu
-- at freshlybaked.nyc/white-label/bulk-flower.

\echo 'Running migration 018: White-label Bulk-Flower Pricing Snapshots...'

\i ../schema/whitelabelPricing.sql

\echo 'Migration 018 complete.'
