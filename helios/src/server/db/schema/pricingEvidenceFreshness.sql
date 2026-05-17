-- View: vw_pricing_evidence_freshness
--
-- One row per (catalog_group, product) derived from
-- catalog_groups.live_state_json->'products'. Joins the most recent
-- *succeeded* litalerts_competitor_observations entry per product and
-- exposes a coarse `freshness` bucket the scheduler / UI can sort by.
--
-- Also classifies whether the product is currently the subject of an
-- alarm-class event (in stock, on a pending purchase, or shares a
-- brand with a pending purchase).
--
-- NOTE on pending-purchase linkage:
--   pending_purchase_rows has no FK to a product_id today; it carries
--   `target_brand` and `target_group_name` as free text. We therefore
--   match on (cg.brand_name, cg.group_name) — close enough for the
--   MVP alarm bucket, and revisited if/when the proposals pipeline
--   resolves a real product link.
--
-- Per-brand freshness window (added by migration 013):
--   * default expiry_days = 4
--   * brand_expiry_overrides may bump it to any value in [1, 30]
--   * buckets become:
--       <= 24h                      fresh
--       > 24h, <= expiry_days       stale
--       > expiry_days, <= +3d grace very_stale
--       > expiry_days + 3d          expired
--       no observation              absent
--   The 3-day grace window protects against an off-by-one feeling
--   when an operator just configured a 7-day window — they shouldn't
--   see the brand flip straight from "stale" to "expired".

create or replace view vw_pricing_evidence_freshness as
with group_products as (
  select
    cg.id                          as catalog_group_id,
    cg.brand_name                  as brand_name,
    cg.group_name                  as group_name,
    (p ->> 'productId')::bigint    as product_id,
    coalesce(p ->> 'name', p ->> 'shortName') as product_name,
    p ->> 'tab'                    as product_tab,
    nullif(p ->> 'price', '')::numeric as live_price
  from catalog_groups cg
  cross join lateral jsonb_array_elements(
    coalesce(cg.live_state_json -> 'products', '[]'::jsonb)
  ) as p
  where cg.deleted_at is null
    and (p ->> 'productId') is not null
),
latest_obs as (
  select distinct on (product_id)
    id            as latest_observation_id,
    product_id,
    captured_at,
    expires_at,
    listing_count,
    pricing_eligible_listing_count
  from litalerts_competitor_observations
  where status = 'succeeded'
  order by product_id, captured_at desc, id desc
),
in_stock_products as (
  select distinct product_id
  from stock_variant_state
  where is_on_stock = true
),
active_pending_purchase_rows as (
  select target_brand, target_group_name
  from pending_purchase_rows
  where approval_status <> 'rejected'
    and last_apply_status <> 'applied'
),
pp_group_match as (
  select distinct cg.id as catalog_group_id
  from catalog_groups cg
  join active_pending_purchase_rows ppr
    on ppr.target_brand = cg.brand_name
   and ppr.target_group_name = cg.group_name
),
pp_brand_match as (
  select distinct cg.id as catalog_group_id
  from catalog_groups cg
  join active_pending_purchase_rows ppr
    on ppr.target_brand = cg.brand_name
),
brand_expiry as (
  -- Per-brand override; null when no row exists for this brand.
  -- LEFT JOIN below applies the 4-day default via coalesce().
  select
    lower(brand_name) as brand_name_lower,
    expiry_days
  from brand_expiry_overrides
)
select
  gp.catalog_group_id,
  gp.product_id,
  gp.brand_name,
  gp.product_name,
  gp.product_tab,
  gp.live_price,
  lo.latest_observation_id,
  lo.captured_at,
  lo.expires_at,
  case
    when lo.captured_at is null then null
    else extract(epoch from (now() - lo.captured_at)) / 86400.0
  end                                                 as age_days,
  case
    when lo.captured_at is null then 'absent'
    when now() - lo.captured_at <= interval '24 hours' then 'fresh'
    when now() - lo.captured_at
       <= make_interval(days => coalesce(be.expiry_days, 4))
      then 'stale'
    when now() - lo.captured_at
       <= make_interval(days => coalesce(be.expiry_days, 4) + 3)
      then 'very_stale'
    else 'expired'
  end                                                 as freshness,
  coalesce(lo.listing_count, 0)                       as listing_count,
  coalesce(lo.pricing_eligible_listing_count, 0)      as pricing_eligible_listing_count,
  (isp.product_id is not null)                        as is_in_stock,
  (ppgm.catalog_group_id is not null)                 as is_in_pending_purchase,
  (ppbm.catalog_group_id is not null)                 as is_brand_of_pending_purchase,
  case
    when ppgm.catalog_group_id is not null then 'pending_purchase'
    when isp.product_id is not null        then 'in_stock'
    when ppbm.catalog_group_id is not null then 'brand_match'
    else null
  end                                                 as alarm_class
from group_products gp
left join latest_obs lo
  on lo.product_id = gp.product_id
left join in_stock_products isp
  on isp.product_id = gp.product_id
left join pp_group_match ppgm
  on ppgm.catalog_group_id = gp.catalog_group_id
left join pp_brand_match ppbm
  on ppbm.catalog_group_id = gp.catalog_group_id
left join brand_expiry be
  on be.brand_name_lower = lower(gp.brand_name);
