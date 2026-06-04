-- Restore the compression policy on litalerts_competitor_observations
-- to compress_after = 60 days (inverse of 058).
--
-- Symmetric with the up migration: remove the 45-day policy and
-- re-add the original 60-day policy. Does not decompress any chunks
-- that may have been compressed in the meantime; raising the
-- threshold back to 60 days simply stops compressing the 45–60 day
-- band going forward.

\set ON_ERROR_STOP on
\timing on

set lock_timeout      = '10s';
set statement_timeout = '2min';

begin;

select remove_compression_policy(
  'public.litalerts_competitor_observations'::regclass,
  if_exists => true
);

select add_compression_policy(
  'public.litalerts_competitor_observations'::regclass,
  compress_after => interval '60 days',
  if_not_exists  => true
);

commit;
