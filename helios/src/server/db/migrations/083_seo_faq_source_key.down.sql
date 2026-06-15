-- Down for 083: drop the FBUS source-key column + its check constraint.

\set ON_ERROR_STOP on

\echo 'Migration 083 down: dropping seo_faq_sets.source_key...'

alter table seo_faq_sets
  drop constraint if exists seo_faq_sets_source_key_check;

alter table seo_faq_sets
  drop column if exists source_key;

\echo 'Migration 083 down complete.'
