/**
 * Nearby-retailer product backfill (issue #20 follow-on).
 *
 * Shared logic between the manual one-shot script
 * (scripts/litalerts-retailer-products-backfill.mts) and the
 * scheduled worker job
 * (configWorkersLitalertsRetailerBackfillJob.ts).
 *
 * For every NY retailer ≤maxDistanceMiles from any of our stores,
 * paginate `/v1/retailers/{id}/products?state=NY` and upsert into
 * `litalerts_products`. Resume-aware: retailers with a row newer
 * than `skipIfIngestedWithinHours` ago are skipped, which means
 * the scheduled job naturally re-attempts only the retailers that
 * weren't refreshed in the last day (i.e. the ones that 5xx'd
 * during the prior run).
 *
 * Sub-exponential power-law backoff (n^1.5) on 5xx / timeout,
 * adaptive global cooldown widened on every 5xx so a worker storm
 * doesn't pile on, and a deferred-retry pass that progressively
 * lowers fanout for retailers that still failed after the first
 * pass.
 */

import type { Pool } from 'pg'

import {
  listRetailerProducts,
  type LitAlertsProduct,
} from './partnerClient.js'

const MAX_ATTEMPTS = 6
const PER_RETAILER_DEADLINE_MS = 90_000

const DEFERRED_RETRY_PASSES: Array<{ concurrency: number; perRetailerCooldownMs: number; label: string }> = [
  { concurrency: 8, perRetailerCooldownMs: 8_000, label: 'pass2-slow' },
  { concurrency: 4, perRetailerCooldownMs: 30_000, label: 'pass3-very-slow' },
  { concurrency: 2, perRetailerCooldownMs: 90_000, label: 'pass4-final' },
]

export interface Retailer {
  retailerId: number
  name: string
  minDistanceMiles: number
  nearestStoreKey: string
}

export interface BackfillOptions {
  stateCode: string
  concurrency: number
  maxDistanceMiles: number
  /** Skip retailers ingested within the last N hours. 0 = always re-fetch. */
  skipIfIngestedWithinHours: number
  log?: (line: string) => void
}

export interface BackfillTotals {
  retailersConsidered: number
  retailersAttempted: number
  productsSeen: number
  configsWritten: number
  retries: number
  terminalFailures: Retailer[]
  elapsedMs: number
}

export async function runRetailerProductsBackfill(pool: Pool, options: BackfillOptions): Promise<BackfillTotals> {
  const log = options.log ?? ((line) => console.log(line))
  const start = Date.now()
  log(
    `[retailer-backfill] state=${options.stateCode} concurrency=${options.concurrency} maxDistanceMiles=${options.maxDistanceMiles} skipIfIngestedWithinHours=${options.skipIfIngestedWithinHours}`,
  )
  const all = await selectNearbyRetailers(pool, options.stateCode, options.maxDistanceMiles)
  let retailers = all
  if (options.skipIfIngestedWithinHours > 0) {
    const ingestedRecently = await loadRecentlyIngestedRetailerIds(
      pool,
      options.stateCode,
      options.skipIfIngestedWithinHours,
    )
    retailers = all.filter((r) => !ingestedRecently.has(r.retailerId))
    log(
      `[retailer-backfill] resume-aware: ${all.length} candidates → ${retailers.length} to fetch (${all.length - retailers.length} skipped as already fresh ≤${options.skipIfIngestedWithinHours}h)`,
    )
  } else {
    log(`[retailer-backfill] ${retailers.length} retailers ≤${options.maxDistanceMiles}mi from any of our stores`)
  }

  const totals: BackfillTotals = {
    retailersConsidered: all.length,
    retailersAttempted: retailers.length,
    productsSeen: 0,
    configsWritten: 0,
    retries: 0,
    terminalFailures: [],
    elapsedMs: 0,
  }

  if (retailers.length === 0) {
    totals.elapsedMs = Date.now() - start
    return totals
  }

  // First pass: full fanout, normal backoff.
  let surviving = await runPass({
    pool,
    stateCode: options.stateCode,
    retailers,
    concurrency: options.concurrency,
    perRetailerCooldownMs: 0,
    passLabel: 'pass1-full',
    totals,
    log,
  })

  for (const passCfg of DEFERRED_RETRY_PASSES) {
    if (surviving.length === 0) break
    log(
      `[retailer-backfill] deferred-retry ${passCfg.label}: ${surviving.length} retailer(s) still failing; concurrency=${passCfg.concurrency} perRetailerCooldownMs=${passCfg.perRetailerCooldownMs}`,
    )
    await sleep(15_000)
    surviving = await runPass({
      pool,
      stateCode: options.stateCode,
      retailers: surviving,
      concurrency: passCfg.concurrency,
      perRetailerCooldownMs: passCfg.perRetailerCooldownMs,
      passLabel: passCfg.label,
      totals,
      log,
    })
  }

  totals.terminalFailures = surviving
  totals.elapsedMs = Date.now() - start
  log(
    `[retailer-backfill] DONE attempted=${retailers.length} products=${totals.productsSeen} configs=${totals.configsWritten} retries=${totals.retries} terminal-failures=${surviving.length} elapsedMs=${totals.elapsedMs}`,
  )
  if (surviving.length > 0) {
    log(
      `[retailer-backfill] terminal failures: ${surviving.map((r) => `${r.retailerId} (${r.name})`).join(', ')}`,
    )
  }
  return totals
}

async function runPass(args: {
  pool: Pool
  stateCode: string
  retailers: Retailer[]
  concurrency: number
  perRetailerCooldownMs: number
  passLabel: string
  totals: BackfillTotals
  log: (line: string) => void
}): Promise<Retailer[]> {
  const { pool, stateCode, retailers, concurrency, perRetailerCooldownMs, passLabel, totals, log } = args
  const queue = retailers.slice()
  const failures: Retailer[] = []
  let processed = 0
  let cooldownExpiresAt = 0
  const startPass = Date.now()

  async function fetchRetailerProductsWithRetry(retailer: Retailer): Promise<LitAlertsProduct[]> {
    let attempt = 0
    // Sub-exponential power-law backoff: base * attempt^1.5. Grows
    // strictly slower than any exponential (a^n) — at attempt 6 this
    // gives ~750 * 14.7 ≈ 11s, capped at MAX_BACKOFF_MS. Compare
    // 1.5^n which is still exponential, just with base 1.5.
    const BASE_MS = 750
    const MAX_BACKOFF_MS = 30_000
    while (true) {
      attempt += 1
      try {
        return await listRetailerProducts(retailer.retailerId, stateCode)
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err
        const msg = err instanceof Error ? err.message : String(err)
        const is5xx = /HTTP 5\d\d/i.test(msg) || /timeout/i.test(msg) || /aborted/i.test(msg)
        if (!is5xx) throw err
        totals.retries += 1
        const backoffMs = Math.min(MAX_BACKOFF_MS, Math.round(BASE_MS * Math.pow(attempt, 1.5)))
        const jitter = Math.round(backoffMs * (Math.random() * 0.4 + 0.8))
        cooldownExpiresAt = Math.max(cooldownExpiresAt, Date.now() + Math.round(backoffMs / 2))
        await sleep(jitter)
      }
    }
  }

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const retailer = queue.shift()
      if (!retailer) return
      const now = Date.now()
      if (cooldownExpiresAt > now) {
        await sleep(cooldownExpiresAt - now)
      }
      if (perRetailerCooldownMs > 0) {
        await sleep(perRetailerCooldownMs + workerId * 1500)
      }
      const startRetailer = Date.now()
      try {
        const products = await fetchRetailerProductsWithRetry(retailer)
        totals.productsSeen += products.length
        if (products.length > 0) {
          const written = await persistProducts(pool, stateCode, retailer.retailerId, products)
          totals.configsWritten += written
        }
      } catch (err) {
        failures.push(retailer)
        log(
          `[retailer-backfill] [${passLabel}] retailer ${retailer.retailerId} (${retailer.name}) — fetch failed after ${MAX_ATTEMPTS} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      processed += 1
      const elapsed = ((Date.now() - startPass) / 1000).toFixed(1)
      const rate = processed / Math.max(1, (Date.now() - startPass) / 60_000)
      if (processed % 5 === 0 || processed === retailers.length) {
        log(
          `[retailer-backfill] [${passLabel}] (${processed}/${retailers.length}) products=${totals.productsSeen} configs=${totals.configsWritten} failures=${failures.length} retries=${totals.retries} elapsed=${elapsed}s rate=${rate.toFixed(1)}/min`,
        )
      }
      const took = Date.now() - startRetailer
      if (took > PER_RETAILER_DEADLINE_MS) {
        log(`[retailer-backfill] [${passLabel}] retailer ${retailer.retailerId} took ${took}ms (worker=${workerId})`)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)))
  return failures
}

export async function selectNearbyRetailers(
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

async function loadRecentlyIngestedRetailerIds(
  pool: Pool,
  stateCode: string,
  withinHours: number,
): Promise<Set<number>> {
  const result = await pool.query<{ retailer_id: string }>(
    `select distinct retailer_id::text as retailer_id
       from litalerts_products
      where state_code = $1
        and observed_at > now() - ($2 || ' hours')::interval`,
    [stateCode, String(withinHours)],
  )
  return new Set(result.rows.map((r) => Number(r.retailer_id)))
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
