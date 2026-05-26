#!/usr/bin/env -S npx tsx
/**
 * Nearby-competitors retailer-products backfill (issue #20 follow-on).
 *
 * The brand-first ingest (`litalerts-structured-ingest.mts`) hits
 * upstream 5xx storms for popular brands and ends up with partial
 * coverage (e.g. brand 4133 "Dank. by definition." only saved 3
 * rows out of dozens of Pre-Rolls because LitAlerts kept 504-ing
 * `/v1/brands/{id}/products?subcategoryFilter=…`).
 *
 * This script comes at the same surface from the other side: walk
 * every NY retailer that is **not** ignored from a pricing
 * perspective (i.e. within ≤50 miles of at least one of our stores,
 * which covers the very-near / near / mid / far distance bands but
 * skips the statewide band) and pull `/v1/retailers/{retailerId}/
 * products?state=NY` in parallel, persisting into `litalerts_
 * products` with the same schema as the brand ingest.
 *
 * Usage:
 *
 *   DATABASE_URL="postgres://…" \
 *   LITALERTS_PARTNER_API_TOKEN="…" \
 *   npx tsx scripts/litalerts-retailer-products-backfill.mts NY
 *
 * Defaults:
 *   - concurrency = 24 (retailers are ~10x fewer than brands so a
 *     lower fanout still gets through the work in minutes)
 *   - maxDistanceMiles = 50 (matches the statewide-band cutoff)
 *   - sub-exponential retry backoff on 5xx (same shape as the brand
 *     ingest), with adaptive global cooldown if the storm widens
 */

import { Pool } from 'pg'

import {
  listRetailerProducts,
  type LitAlertsProduct,
} from '../src/worker/litalerts/partnerClient.js'

const DEFAULT_CONCURRENCY = Number.parseInt(process.env.LITALERTS_RETAILER_BACKFILL_CONCURRENCY ?? '24', 10)
const DEFAULT_MAX_DISTANCE_MILES = Number.parseFloat(process.env.LITALERTS_MAX_DISTANCE_MILES ?? '50')
const MAX_ATTEMPTS = 6
const PER_RETAILER_DEADLINE_MS = 90_000

interface Retailer {
  retailerId: number
  name: string
  minDistanceMiles: number
  nearestStoreKey: string
}

async function main(): Promise<void> {
  const stateCode = (process.argv[2] ?? 'NY').trim().toUpperCase()
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  const concurrency = Math.max(1, DEFAULT_CONCURRENCY)
  const maxDistance = Math.max(0, DEFAULT_MAX_DISTANCE_MILES)
  const pool = new Pool({ connectionString: databaseUrl, max: Math.min(concurrency + 4, 64) })

  console.log(
    `[retailer-backfill] state=${stateCode} concurrency=${concurrency} maxDistanceMiles=${maxDistance}`,
  )

  const retailers = await selectNearbyRetailers(pool, stateCode, maxDistance)
  console.log(`[retailer-backfill] ${retailers.length} retailers ≤${maxDistance}mi from any of our stores`)
  if (retailers.length === 0) {
    await pool.end()
    return
  }

  let processed = 0
  let productsSeen = 0
  let configsWritten = 0
  let fetchFailures = 0
  let retries = 0
  let cooldownExpiresAt = 0
  const start = Date.now()
  const queue = retailers.slice()

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const retailer = queue.shift()
      if (!retailer) return
      // Honor any adaptive global cooldown.
      const now = Date.now()
      if (cooldownExpiresAt > now) {
        await sleep(cooldownExpiresAt - now)
      }
      const startRetailer = Date.now()
      try {
        const products = await fetchRetailerProductsWithRetry(retailer, stateCode)
        productsSeen += products.length
        if (products.length > 0) {
          const written = await persistProducts(pool, stateCode, retailer.retailerId, products)
          configsWritten += written
        }
      } catch (err) {
        fetchFailures += 1
        console.warn(
          `[retailer-backfill] retailer ${retailer.retailerId} (${retailer.name}) — fetch failed after ${MAX_ATTEMPTS} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      processed += 1
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      const rate = processed / Math.max(1, (Date.now() - start) / 60_000)
      if (processed % 5 === 0 || processed === retailers.length) {
        console.log(
          `[retailer-backfill] (${processed}/${retailers.length}) products=${productsSeen} configs=${configsWritten} fetch-failures=${fetchFailures} retries=${retries} elapsed=${elapsed}s rate=${rate.toFixed(1)}/min`,
        )
      }
      // Per-retailer wall-clock budget: if a single retailer ate
      // > deadline, complain (but keep going).
      const took = Date.now() - startRetailer
      if (took > PER_RETAILER_DEADLINE_MS) {
        console.warn(
          `[retailer-backfill] retailer ${retailer.retailerId} took ${took}ms (worker=${workerId})`,
        )
      }
    }
  }

  async function fetchRetailerProductsWithRetry(
    retailer: Retailer,
    state: string,
  ): Promise<LitAlertsProduct[]> {
    let attempt = 0
    let backoffMs = 750
    while (true) {
      attempt += 1
      try {
        return await listRetailerProducts(retailer.retailerId, state)
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err
        const msg = err instanceof Error ? err.message : String(err)
        const is5xx = /HTTP 5\d\d/i.test(msg) || /timeout/i.test(msg) || /aborted/i.test(msg)
        if (!is5xx) throw err
        retries += 1
        // Sub-exponential power-law backoff (b^1.5 grows but slower
        // than doubling, mirroring the brand ingest).
        backoffMs = Math.min(15_000, Math.round(backoffMs * 1.5))
        const jitter = Math.round(backoffMs * (Math.random() * 0.4 + 0.8))
        // Widen the adaptive global cooldown on every 5xx so we
        // don't add fuel to the upstream fire.
        cooldownExpiresAt = Math.max(cooldownExpiresAt, Date.now() + Math.round(backoffMs / 2))
        await sleep(jitter)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)))

  const elapsedTotal = ((Date.now() - start) / 1000).toFixed(1)
  console.log(
    `[retailer-backfill] DONE retailers=${processed}/${retailers.length} products=${productsSeen} configs=${configsWritten} fetch-failures=${fetchFailures} retries=${retries} elapsed=${elapsedTotal}s`,
  )

  await pool.end()
}

async function selectNearbyRetailers(
  pool: Pool,
  stateCode: string,
  maxMiles: number,
): Promise<Retailer[]> {
  const result = await pool.query<{
    retailer_id: string
    name: string
    min_distance_miles: string
    nearest_store_key: string
  }>(
    `
      with retailer_distances as (
        select
          r.retailer_id,
          r.name,
          s.site_key,
          3958.7613 * 2 * asin(
            sqrt(
              sin(radians((s.latitude - r.latitude) / 2)) ^ 2
              + cos(radians(r.latitude)) * cos(radians(s.latitude))
                * sin(radians((s.longitude - r.longitude) / 2)) ^ 2
            )
          ) as miles
        from litalerts_retailer_locations r
        cross join helios_store_locations s
        where r.state_code = $1
          and r.latitude is not null and r.longitude is not null
          and s.latitude is not null and s.longitude is not null
      ),
      nearest as (
        select distinct on (retailer_id)
          retailer_id,
          name,
          site_key as nearest_store_key,
          miles
        from retailer_distances
        order by retailer_id, miles asc
      )
      select retailer_id::text, name, miles::text as min_distance_miles, nearest_store_key
        from nearest
       where miles <= $2
       order by miles asc
    `,
    [stateCode, maxMiles],
  )
  return result.rows.map((r) => ({
    retailerId: Number(r.retailer_id),
    name: r.name,
    minDistanceMiles: Number(r.min_distance_miles),
    nearestStoreKey: r.nearest_store_key,
  }))
}

async function persistProducts(
  pool: Pool,
  stateCode: string,
  retailerId: number,
  products: LitAlertsProduct[],
): Promise<number> {
  const client = await pool.connect()
  let configs = 0
  try {
    await client.query('begin')
    for (const product of products) {
      const productConfigs = Array.isArray(product.configs) ? product.configs : []
      for (let configIdx = 0; configIdx < productConfigs.length; configIdx += 1) {
        const cfg = productConfigs[configIdx]
        await client.query(
          `insert into litalerts_products (
             state_code, brand_id, brand_name, retailer_id, product_id, config_idx,
             product_name, category,
             amount, units, normal_price, sale_price, current_stock,
             recreational, medical,
             medical_url, recreational_url,
             raw_config_json, raw_product_json
           ) values (
             $1, $2, $3, $4, $5, $6,
             $7, $8,
             $9, $10, $11, $12, $13,
             $14, $15,
             $16, $17,
             $18::jsonb, $19::jsonb
           )`,
          [
            stateCode,
            product.brandId ?? null,
            product.brand ?? null,
            product.retailerId ?? retailerId,
            product.id,
            configIdx,
            product.name,
            product.category ?? null,
            stringOrNull(cfg.amount),
            cfg.units ?? null,
            numericOrNull(cfg.normalPrice),
            numericOrNull(cfg.salePrice),
            integerOrNull(cfg.currentStock),
            cfg.recreational ?? null,
            cfg.medical ?? null,
            product.medicalURL ?? null,
            product.recreationalURL ?? null,
            JSON.stringify(cfg),
            JSON.stringify({ ...product, configs: undefined }),
          ],
        )
        configs += 1
      }
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
  return configs
}

function stringOrNull(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length === 0 ? null : s
}

function numericOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function integerOrNull(v: unknown): number | null {
  const n = numericOrNull(v)
  if (n == null) return null
  return Math.trunc(n)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
