-- Migration 021: Staff Photo Focal-Point Cache
--
-- Adds the staff_photo_focal_points table that caches per-image
-- focal points (computed by the private LLM in the helios worker)
-- used to crop the dynamically auto-imported "Meet The Team"
-- staff portraits on the FBNYC about-us page so faces stay in
-- frame regardless of how the POS photo was framed.
--
-- See helios/src/server/db/schema/staff.sql for column comments
-- and rationale. Idempotent: the underlying schema file uses
-- `create ... if not exists`.

\echo 'Running migration 021: Staff Photo Focal-Point Cache...'

\i ../schema/staff.sql

\echo 'Migration 021 complete.'
