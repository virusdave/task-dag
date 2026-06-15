-- Down for 079: drop the geographic segment-assignment engine tables.
--
-- Removes `geo_segment_rule_applications` (the per-customer ledger) and
-- `geo_segment_rules` (the rule definitions, incl. the seeded Bronx
-- first-scan rule). Only run this after rolling the worker back to a
-- build that does NOT register `config.workers.geo_segment_rule_eval`
-- or enqueue it from the link / visitor-scan-address workers, otherwise
-- those enqueue/eval paths will error on the missing tables.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists geo_segment_rule_applications;
drop table if exists geo_segment_rules;

commit;

\echo 'Migration 079 down complete.'
