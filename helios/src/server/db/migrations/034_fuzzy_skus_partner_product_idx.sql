-- 034_fuzzy_skus_partner_product_idx.sql
--
-- Partial covering index on fuzzy_skus to make the per-brand and
-- per-(brand, category) aggregations used by GET /api/catalog/
-- market-matches an index-only scan. Without this index, the
-- listGroupsForReview query was doing a seq scan over ~360k
-- fuzzy_skus rows (63k buffer hits) every time the page was loaded,
-- adding ~200ms to the 50ms baseline.
--
-- Why partial + (brand_norm, category_norm):
--   * The market-matches review surface only ever consults rows
--     where source_kind = 'litalerts_partner_product' (the
--     structured ingest path). The legacy
--     'litalerts_competitor_observation' rows are queried only by
--     the per-group review bundle, which is already pin-pointed.
--   * Both `group by brand_norm` (for the per-brand total fuzzy
--     count) and `group by brand_norm, category_norm` (for the
--     category-gated "high quality" count) are satisfied by an
--     index-only scan over this partial index, with no heap touch.
--
-- Idempotent: `create index if not exists`. CONCURRENTLY because
-- fuzzy_skus has active writers (the structured-ingest worker) and
-- we don't want to block them; the build takes a few seconds on
-- ~360k rows.

create index concurrently if not exists fuzzy_skus_partner_brand_category_idx
  on fuzzy_skus (brand_norm, category_norm)
  where source_kind = 'litalerts_partner_product'
    and brand_norm is not null;
