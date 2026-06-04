-- Disable Timescale compression on sweed_auth_events.
--
-- Inverse of 056. Removes the compression policy first, then
-- decompresses every compressed chunk, then drops the compression
-- settings. Safe to run only against a database where every
-- compressed chunk fits comfortably in WAL/disk headroom after
-- decompression — at apply time of 056 there were zero compressed
-- chunks, so an immediate rollback is essentially a no-op.
--
-- If compression has been active for a while and many chunks are
-- compressed, this script may run for many minutes and produce
-- significant WAL. Inspect compressed-chunk size first:
--
--   select chunk_name, before_compression_total_bytes,
--          after_compression_total_bytes
--     from timescaledb_information.chunks
--    where hypertable_name = 'sweed_auth_events'
--      and is_compressed;
--
-- and consider doing the decompression chunk-by-chunk in batches
-- rather than via this single script.

\set ON_ERROR_STOP on
\timing on

set statement_timeout = '60min';

begin;

-- Drop the policy first so the bgw doesn't race us recompressing.
select remove_compression_policy(
  'public.sweed_auth_events'::regclass,
  if_exists => true
);

-- Decompress every compressed chunk on this hypertable.
do $$
declare
  c record;
begin
  for c in
    select format('%I.%I', chunk_schema, chunk_name) as fq
      from timescaledb_information.chunks
     where hypertable_schema = 'public'
       and hypertable_name   = 'sweed_auth_events'
       and is_compressed
  loop
    perform decompress_chunk(c.fq::regclass);
  end loop;
end
$$;

-- Now safe to drop compression settings.
alter table public.sweed_auth_events
  set (timescaledb.compress = false);

commit;
