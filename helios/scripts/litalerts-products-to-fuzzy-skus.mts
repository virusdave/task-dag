#!/usr/bin/env -S npx tsx
/**
 * Backfill `fuzzy_skus` from the structured `litalerts_products`
 * snapshots (#20 cutover for the Catalog → Market Data review
 * surface, issue #18).
 *
 * Set-based implementation: a single INSERT ... SELECT pulls every
 * latest-per-(retailer_id, product_id, config_idx) row from
 * `litalerts_products` and lands it as a `fuzzy_skus` row with
 * source_kind='litalerts_partner_product'. Idempotent via the
 * existing unique constraint on (source_kind, source_listing_id,
 * parser_id, parser_version, raw_input_hash).
 *
 * The previous row-by-row version took 30+ minutes against Tiger
 * Cloud because each insert paid a full round-trip; the set-based
 * version completes in a few seconds even for 100k+ rows.
 *
 * Field mapping:
 *   - brand_norm        ← LAProduct.brand          (lowercased trim)
 *   - category_norm     ← LAProduct.category       (lowercased trim)
 *   - size_g_norm       ← LAProductConfig.amount when units in {g,gram,oz,lb}
 *   - size_mg_norm      ← LAProductConfig.amount when units in {mg,milligram}
 *   - parsed_jsonb      ← canonical {brand,cat,size,...} envelope
 *   - raw_input_jsonb   ← original LAProduct + LAProductConfig blob
 *
 * Junk sizes are guarded server-side: clamped to <= numeric(10,4)
 * via numeric arithmetic and a CASE; values that would overflow are
 * inserted as NULL so the scorer doesn't see nonsense.
 */

import { Pool } from 'pg'

const PARSER_ID = 'litalerts.partner-structured'
const PARSER_VERSION = 'v1'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  const stateCode = (process.argv[2] ?? 'NY').trim().toUpperCase()
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })

  console.log(`backfilling fuzzy_skus from litalerts_products where state_code=${stateCode}…`)
  const start = Date.now()

  // One round-trip. Tiger Cloud chews through the join + insert in
  // seconds even at 150k rows. Note: numeric overflow guard uses
  // `case when abs(x) < 1e6 then x else null end` so we never try
  // to fit a 1_000_000-gram nonsense row into numeric(10,4).
  const result = await pool.query<{ inserted: string }>(
    `
      with latest as (
        select distinct on (retailer_id, product_id, config_idx)
               observed_at,
               retailer_id, product_id, config_idx,
               brand_name, product_name, category,
               amount, units,
               normal_price, sale_price, current_stock,
               medical_url, recreational_url,
               raw_config_json, raw_product_json
          from litalerts_products
         where state_code = $1
         order by retailer_id, product_id, config_idx, observed_at desc
      ),
      shaped as (
        select
          retailer_id::text || ':' || product_id::text || ':' || config_idx::text as source_listing_id,
          observed_at,
          jsonb_build_object(
            'listingName', product_name,
            'brand', brand_name,
            'category', category,
            'url', coalesce(recreational_url, medical_url),
            'retailerId', retailer_id,
            'productId', product_id,
            'configIdx', config_idx,
            'amount', amount,
            'units', units,
            'normalPrice', normal_price,
            'salePrice', sale_price,
            'currentStock', current_stock,
            -- Per-product image URL from the LitAlerts partner API
            -- (LAProduct.imageURL, added May 2026). We surface it
            -- here (lowercase 'imageUrl' to match the rest of our
            -- snake/camel envelope) so the catalog -> market data
            -- reviewer can render product thumbnails straight off
            -- the fuzzy row, without paying for the legacy LEFT JOIN
            -- against the legacy litalerts_product_images table
            -- (the scraped-dashboard table that the new API field
            -- replaces).
            'imageUrl', raw_product_json->>'imageURL',
            'raw_config_json', raw_config_json,
            'raw_product_json', raw_product_json
          ) as raw_input_jsonb,
          nullif(lower(trim(brand_name)), '') as brand_norm,
          nullif(lower(trim(category)), '') as category_norm,
          -- Safe numeric cast: amount is text and may contain
          -- non-numeric junk; only convert when it matches a numeric
          -- pattern, otherwise NULL.
          case
            when amount ~ '^-?\\d+(\\.\\d+)?$' then
              case lower(coalesce(units, ''))
                when 'g'      then amount::numeric
                when 'gram'   then amount::numeric
                when 'grams'  then amount::numeric
                when 'oz'     then amount::numeric * 28.3495
                when 'ounce'  then amount::numeric * 28.3495
                when 'ounces' then amount::numeric * 28.3495
                when 'lb'     then amount::numeric * 453.592
                when 'pound'  then amount::numeric * 453.592
                when 'pounds' then amount::numeric * 453.592
                else null
              end
            else null
          end as size_g_raw,
          case
            when amount ~ '^-?\\d+(\\.\\d+)?$' then
              case lower(coalesce(units, ''))
                when 'mg'         then amount::numeric
                when 'milligram'  then amount::numeric
                when 'milligrams' then amount::numeric
                else null
              end
            else null
          end as size_mg_raw
        from latest
      ),
      clamped as (
        select source_listing_id, observed_at, raw_input_jsonb, brand_norm, category_norm,
               case when size_g_raw is not null and abs(size_g_raw) < 1e6
                    then size_g_raw else null end as size_g_norm,
               case when size_mg_raw is not null and abs(size_mg_raw) < 1e8
                    then size_mg_raw else null end as size_mg_norm
          from shaped
      ),
      hashed as (
        select source_listing_id, observed_at, raw_input_jsonb, brand_norm, category_norm,
               size_g_norm, size_mg_norm,
               encode(digest(raw_input_jsonb::text, 'sha256'), 'hex') as raw_input_hash,
               jsonb_build_object(
                 'brandNorm', brand_norm,
                 'categoryNorm', category_norm,
                 'subcategoryNorm', null,
                 'sizeGNorm', size_g_norm,
                 'sizeMgNorm', size_mg_norm,
                 'packCountNorm', null,
                 'strainNorm', null
               ) as parsed_jsonb
          from clamped
      ),
      ins as (
        insert into fuzzy_skus (
          source_kind, source_listing_id, source_captured_at,
          raw_input_jsonb, raw_input_hash,
          parser_id, parser_version, parsed_jsonb,
          brand_norm, category_norm, subcategory_norm,
          size_g_norm, size_mg_norm, pack_count_norm, strain_norm
        )
        select 'litalerts_partner_product', source_listing_id, observed_at,
               raw_input_jsonb, raw_input_hash,
               $2, $3, parsed_jsonb,
               brand_norm, category_norm, null,
               size_g_norm, size_mg_norm, null, null
          from hashed
        on conflict on constraint fuzzy_skus_source_kind_source_listing_id_parser_id_parser_v_key
        do nothing
        returning 1
      )
      select count(*)::text as inserted from ins
    `,
    [stateCode, PARSER_ID, PARSER_VERSION],
  )

  // Total candidate rows in the source so we can report "skipped (dup)".
  const totalQ = await pool.query<{ n: string }>(
    `select count(*)::text as n from (
       select 1 from litalerts_products where state_code = $1
       group by retailer_id, product_id, config_idx
     ) t`,
    [stateCode],
  )
  const total = Number(totalQ.rows[0]?.n ?? '0')
  const inserted = Number(result.rows[0]?.inserted ?? '0')
  const skipped = total - inserted
  const elapsedMs = Date.now() - start
  console.log(
    `done in ${elapsedMs}ms: scanned=${total} inserted=${inserted} skipped(dup)=${skipped}`,
  )

  await pool.end()
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
