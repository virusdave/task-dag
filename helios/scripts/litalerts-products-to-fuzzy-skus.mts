#!/usr/bin/env -S npx tsx
/**
 * Backfill `fuzzy_skus` from the structured `litalerts_products`
 * snapshots (#20 cutover for the Catalog → Market Data review
 * surface, issue #18).
 *
 * For every "latest per (retailer_id, product_id, config_idx)" row
 * in litalerts_products, produce a fuzzy_skus row with
 * source_kind='litalerts_partner_product'. The structured fields
 * map directly:
 *   - brand_norm        ← LAProduct.brand (lowercased trim)
 *   - category_norm     ← LAProduct.category (lowercased trim)
 *   - size_g_norm       ← LAProductConfig.amount when units in {g, gram}
 *   - size_mg_norm      ← LAProductConfig.amount when units = mg
 *   - parsed_jsonb      ← the full structured config + LAProduct envelope
 *   - raw_input_jsonb   ← same, plus retailer/product URLs as a listing
 *
 * Idempotent: the fuzzy_skus uniqueness key includes
 * (source_kind, source_listing_id, parser_id, parser_version,
 * raw_input_hash) so re-running with the same structured snapshot
 * is a no-op. When LitAlerts ships an updated row (price change,
 * stock change) the new observation has a different raw_input_hash
 * and lands as a new fuzzy_sku — preserving history exactly like
 * the observation-based backfill does.
 */

import { createHash } from 'node:crypto'

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
  const pool = new Pool({ connectionString: databaseUrl, max: 16 })

  console.log(`scanning latest-per-key litalerts_products rows for state=${stateCode}…`)
  // Latest snapshot per (retailer_id, product_id, config_idx).
  const result = await pool.query<{
    observation_id: string
    observed_at: string
    retailer_id: string
    product_id: string
    config_idx: number
    brand_name: string | null
    product_name: string
    category: string | null
    amount: string | null
    units: string | null
    normal_price: string | null
    sale_price: string | null
    current_stock: number | null
    medical_url: string | null
    recreational_url: string | null
    raw_config_json: unknown
    raw_product_json: unknown
  }>(
    `
      with latest as (
        select distinct on (retailer_id, product_id, config_idx)
               observation_id, observed_at, retailer_id, product_id, config_idx,
               brand_id, brand_name, product_name, category,
               amount, units, normal_price, sale_price, current_stock,
               medical_url, recreational_url,
               raw_config_json, raw_product_json
        from litalerts_products
        where state_code = $1
        order by retailer_id, product_id, config_idx, observed_at desc
      )
      select observation_id::text, observed_at::text,
             retailer_id::text, product_id::text, config_idx,
             brand_name, product_name, category,
             amount, units,
             normal_price::text, sale_price::text, current_stock,
             medical_url, recreational_url,
             raw_config_json, raw_product_json
      from latest
    `,
    [stateCode],
  )
  const total = result.rows.length
  console.log(`  saw ${total} latest-per-key rows`)

  let inserted = 0
  let skipped = 0
  const client = await pool.connect()
  try {
    let i = 0
    for (const row of result.rows) {
      i += 1
      const sourceListingId = `${row.retailer_id}:${row.product_id}:${row.config_idx}`
      const rawListing = {
        listingName: row.product_name,
        brand: row.brand_name,
        category: row.category,
        url: row.recreational_url ?? row.medical_url ?? null,
        retailerId: Number(row.retailer_id),
        productId: Number(row.product_id),
        configIdx: row.config_idx,
        amount: row.amount,
        units: row.units,
        normalPrice: numericOrNull(row.normal_price),
        salePrice: numericOrNull(row.sale_price),
        currentStock: row.current_stock,
        raw_config_json: row.raw_config_json,
        raw_product_json: row.raw_product_json,
      }
      const rawInputJson = JSON.stringify(rawListing)
      const rawInputHash = sha256(rawInputJson)
      const sizeG = unitsToGrams(row.amount, row.units)
      const sizeMg = unitsToMilligrams(row.amount, row.units)
      const parsedJson = JSON.stringify({
        brandNorm: normTextOrNull(row.brand_name),
        categoryNorm: normTextOrNull(row.category),
        subcategoryNorm: null,
        sizeGNorm: sizeG,
        sizeMgNorm: sizeMg,
        packCountNorm: null,
        strainNorm: null,
      })
      const insertResult = await client.query<{ id: number }>(
        `
          insert into fuzzy_skus (
            source_kind, source_listing_id, source_captured_at,
            raw_input_jsonb, raw_input_hash,
            parser_id, parser_version, parsed_jsonb,
            brand_norm, category_norm, subcategory_norm,
            size_g_norm, size_mg_norm, pack_count_norm, strain_norm
          ) values (
            'litalerts_partner_product', $1, $2,
            $3::jsonb, $4,
            $5, $6, $7::jsonb,
            $8, $9, null,
            $10, $11, null, null
          )
          on conflict on constraint fuzzy_skus_source_kind_source_listing_id_parser_id_parser_v_key do nothing
          returning id
        `,
        [
          sourceListingId,
          row.observed_at,
          rawInputJson,
          rawInputHash,
          PARSER_ID,
          PARSER_VERSION,
          parsedJson,
          normTextOrNull(row.brand_name),
          normTextOrNull(row.category),
          sizeG,
          sizeMg,
        ],
      )
      if (insertResult.rows.length > 0) inserted += 1
      else skipped += 1
      if (i % 1000 === 0) {
        console.log(`  (${i}/${total}) inserted=${inserted} skipped=${skipped}`)
      }
    }
    console.log(`done: scanned=${total} inserted=${inserted} skipped(dup)=${skipped}`)
  } finally {
    client.release()
    await pool.end()
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function numericOrNull(v: string | null): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normTextOrNull(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = s.trim().toLowerCase()
  return t.length === 0 ? null : t
}

// Cap at numeric(10,4) — anything bigger is junk upstream data
// (e.g. amount=1000000 g). Skip rather than clamp so the scorer
// doesn't see nonsense values.
function clamp(n: number, max: number): number | null {
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null
}

function unitsToGrams(amount: string | null, units: string | null): number | null {
  if (amount == null || units == null) return null
  const n = Number(amount)
  if (!Number.isFinite(n)) return null
  const u = units.trim().toLowerCase()
  if (u === 'g' || u === 'gram' || u === 'grams') return clamp(n, 999_999)
  if (u === 'oz' || u === 'ounce' || u === 'ounces') return clamp(n * 28.3495, 999_999)
  if (u === 'lb' || u === 'pound' || u === 'pounds') return clamp(n * 453.592, 999_999)
  return null
}

function unitsToMilligrams(amount: string | null, units: string | null): number | null {
  if (amount == null || units == null) return null
  const n = Number(amount)
  if (!Number.isFinite(n)) return null
  const u = units.trim().toLowerCase()
  if (u === 'mg' || u === 'milligram' || u === 'milligrams') return clamp(n, 99_999_999)
  return null
}

void main()
