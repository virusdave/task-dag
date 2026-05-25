-- Persisted market-data substrate for the Catalog → Market Data
-- review workflow (issue #18).
--
-- Two append-mostly tables:
--
--   fuzzy_skus  — one immutable row per (source listing × parser
--                 version × raw input). The raw upstream payload is
--                 kept verbatim so that re-parsing with a bumped
--                 parser version produces a new row instead of
--                 mutating history. Normalised brand / category /
--                 size columns are denormalised out of `parsed_jsonb`
--                 so the scorer can join on them without cracking
--                 JSON on every comparison.
--
--   catalog_market_matches — one row per *event* of a reviewer (or
--                 the system scorer) asserting a verdict between a
--                 catalog_group and a fuzzy_sku. Verdict edits are
--                 inserts; the prior row gets `superseded_by_id` /
--                 `superseded_at` set, so we keep a full audit
--                 trail. A partial-unique index enforces "at most
--                 one live verdict per (group, fuzzy) pair".
--
-- Forward-only and additive. Both tables start empty; phase-3
-- backfill (see docs/helios/catalog-market-data/EPIC_PLAN.md) lands
-- the historical litalerts_competitor_observations rows.
--
-- Idempotent (create … if not exists; create index if not exists).

create table if not exists fuzzy_skus (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),

  -- provenance: where did the raw input come from?
  source_kind       text not null
                      check (source_kind in (
                        'litalerts_partner_product',
                        'litalerts_partner_retailer',
                        'litalerts_competitor_observation',
                        'manual'
                      )),
  source_listing_id text not null,
  source_captured_at timestamptz,

  -- raw + parsed
  raw_input_jsonb   jsonb not null,
  raw_input_hash    text not null,
  parser_id         text not null,
  parser_rule_id    text,
  parser_version    text not null,
  parsed_jsonb      jsonb not null,

  -- normalised fields (extracted out of parsed_jsonb for indexing/joining)
  brand_norm        text,
  category_norm     text,
  subcategory_norm  text,
  size_g_norm       numeric(10,4),
  size_mg_norm      numeric(10,2),
  pack_count_norm   smallint,
  strain_norm       text,
  cannabinoid_jsonb jsonb,

  unique (source_kind, source_listing_id, parser_id, parser_version, raw_input_hash)
);

create index if not exists fuzzy_skus_brand_idx
  on fuzzy_skus (brand_norm);

create index if not exists fuzzy_skus_source_idx
  on fuzzy_skus (source_kind, source_listing_id);

create index if not exists fuzzy_skus_brand_size_idx
  on fuzzy_skus (brand_norm, category_norm, size_g_norm)
  where brand_norm is not null and category_norm is not null;


create table if not exists catalog_market_matches (
  id                       bigint generated always as identity primary key,
  catalog_group_id         bigint not null references catalog_groups(id),
  catalog_product_id       bigint,
  fuzzy_sku_id             bigint not null references fuzzy_skus(id),

  verdict                  text not null
                            check (verdict in ('exact', 'brand_family', 'no_match')),
  verdict_set_at           timestamptz not null default now(),
  verdict_set_by_user_id   text not null,
  verdict_set_via          text not null
                            check (verdict_set_via in ('manual', 'bulk', 'imported', 'system_inferred')),

  confidence_at_verdict    numeric(4,3),

  notes                    text,
  superseded_by_id         bigint references catalog_market_matches(id),
  superseded_at            timestamptz
);

-- At-most-one-live-verdict per (group, fuzzy) pair. Partial unique
-- index because edits insert a new row + set the old row's
-- superseded_by_id; we want history rows to coexist with the live
-- row.
create unique index if not exists catalog_market_matches_live_pair_uniq
  on catalog_market_matches (catalog_group_id, fuzzy_sku_id)
  where superseded_by_id is null;

create index if not exists catalog_market_matches_group_idx
  on catalog_market_matches (catalog_group_id)
  where superseded_by_id is null;

create index if not exists catalog_market_matches_fuzzy_idx
  on catalog_market_matches (fuzzy_sku_id)
  where superseded_by_id is null;

create index if not exists catalog_market_matches_verdict_idx
  on catalog_market_matches (catalog_group_id, verdict)
  where superseded_by_id is null;
