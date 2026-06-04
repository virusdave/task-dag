-- Disable Timescale compression on litalerts_competitor_observations.
--
-- Inverse of 057. Same caveats as the 056 down script: if many
-- chunks have already been compressed this will run for a while
-- and produce significant WAL. Inspect:
--
--   select chunk_name, before_compression_total_bytes,
--          after_compression_total_bytes
--     from timescaledb_information.chunks
--    where hypertable_name = 'litalerts_competitor_observations'
--      and is_compressed;
--
-- before running.

\set ON_ERROR_STOP on
\timing on

set statement_timeout = '60min';

begin;

select remove_compression_policy(
  'public.litalerts_competitor_observations'::regclass,
  if_exists => true
);

do $$
declare
  c record;
begin
  for c in
    select format('%I.%I', chunk_schema, chunk_name) as fq
      from timescaledb_information.chunks
     where hypertable_schema = 'public'
       and hypertable_name   = 'litalerts_competitor_observations'
       and is_compressed
  loop
    perform decompress_chunk(c.fq::regclass);
  end loop;
end
$$;

alter table public.litalerts_competitor_observations
  set (timescaledb.compress = false);

commit;
