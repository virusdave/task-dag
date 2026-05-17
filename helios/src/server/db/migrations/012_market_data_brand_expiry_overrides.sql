-- Migration 012: Brand Expiry Overrides
--
-- Creates the brand_expiry_overrides table consumed by:
--   * vw_pricing_evidence_freshness (migration 013) — bucketing
--   * configWorkersLitalertsRefreshJob.ts — expires_at on capture
--   * /api/config/brand-expiry-overrides — operator admin surface
--
-- NOTE: The spec called this migration 011, but 011 was already
-- claimed by a sibling agent (011_sweed_auth_events.sql). Bumped to
-- 012 to avoid the collision. The companion view migration (called
-- 012 in the spec) is correspondingly 013.

\echo 'Running migration 012: Brand Expiry Overrides...'

\i ../schema/brandExpiryOverrides.sql

\echo 'Migration 012 complete.'
