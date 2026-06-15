-- Reword the seeded Bronx geo-rule note on already-migrated databases.
--
-- The migration-079 seed left an operator-facing note ending
-- "Seeded with migration 079." — pure provenance drivel that the
-- segment/geo-rules UI displays to operators forever. Migration 079's
-- seed text is fixed for fresh DBs; this forward migration fixes rows
-- that were already inserted by the old 079. Guarded + idempotent:
-- only rewrites the exact boilerplate note, so an operator who later
-- edits the note by hand is never clobbered.

\echo 'Running migration 082: reword seeded geo-rule note...'

update geo_segment_rules
   set note = 'Bronx hyperlocal automation: adds qualifying first-scan customers whose geocoded ID home address is within 3,750 ft of the Bronx store to Sweed segment 10282. Starts 2026-05-21; ignores customers scanned within the prior 365 days.',
       updated_at = now()
 where site_slug = 'bx'
   and trigger = 'first_scan'
   and segment_id = 10282
   and note like '%Seeded with migration 079.%';

\echo 'Migration 082 complete.'
