-- Migration 025: per-ad attempt history for the Google Ads
-- automation feedback loop.
--
-- Adds gads_ad_attempts. See
-- helios/src/server/db/schema/gadsAdAttempts.sql for column
-- comments + the role of each outcome value. Idempotent.

\echo 'Running migration 025: gads_ad_attempts...'

\i ../schema/gadsAdAttempts.sql

\echo 'Migration 025 complete.'
