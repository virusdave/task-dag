-- GIN containment index on catalog_groups.live_state_json -> 'products'.
--
-- Why now (Helios DB-cost epic — virusdave/top-level#11, phase A5):
-- The lit-alerts refresh job (every queue row drained becomes a
-- per-variant `config.workers.litalerts_refresh.variant` job) does
-- the following predicate to resolve "which catalog group currently
-- mirrors this Sweed productId":
--
--   select … from catalog_groups
--    where (live_state_json -> 'products') @> $1::jsonb
--    limit 1;
--
-- The matching array is small (`[{"productId":N}]`), but without
-- an index this is a sequential scan of every catalog_groups row —
-- one full table read PER variant refresh job, several thousand
-- such jobs per day. That seq-scan was a top contributor to
-- TigerData TigerData read I/O cost on the per-job hot path.
--
-- `jsonb_path_ops` is the right opclass for pure `@>` containment
-- queries (smaller index, faster lookups; gives up the more
-- general key-existence operators we don't use here).
--
-- The index is built CONCURRENTLY so applying this migration on a
-- live database doesn't block writes to catalog_groups. The
-- pendingMigrations sentinel keys off the index name so a
-- partially-applied state is still detectable.
--
-- Idempotent: `if not exists`.

create index concurrently if not exists catalog_groups_products_gin_idx
  on catalog_groups
  using gin ((live_state_json -> 'products') jsonb_path_ops);

analyze catalog_groups;
