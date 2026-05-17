-- Migration 013: vw_pricing_evidence_freshness — per-brand expiry windows
--
-- Re-declares vw_pricing_evidence_freshness so the freshness bucket
-- honors per-brand expiry overrides from migration 012's
-- brand_expiry_overrides table (defaulting to 4 days when no row
-- exists), with a 3-day grace window between the per-brand expiry
-- and the "expired" bucket so a freshly-bumped expiry doesn't flip
-- entries straight from stale to expired.
--
-- NOTE: This migration is called "012" in the original spec; bumped
-- to 013 because 011 was already taken by 011_sweed_auth_events.sql
-- (sibling agent's concurrent work), shifting both follow-on
-- migrations by +1.

\echo 'Running migration 013: vw_pricing_evidence_freshness per-brand expiry...'

\i ../schema/pricingEvidenceFreshness.sql

\echo 'Migration 013 complete.'
