-- Migration 019: Staff Directory Cache + Staff Inclusion
--
-- Adds two tables that back the Helios Utilities → Staff page:
--
--   * staff_directory_cache: cached snapshot of Sweed
--     `user.compliance.list` on the state-level dealer.
--   * staff_inclusion: human approve/reject/unapproved decision
--     per staff_id, used to gate the public "Meet The Team"
--     surface on the FBNYC about-us page.
--
-- See helios/src/server/db/schema/staff.sql for column comments.

\echo 'Running migration 019: Staff Directory Cache + Staff Inclusion...'

\i ../schema/staff.sql

\echo 'Migration 019 complete.'
