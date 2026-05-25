#!/usr/bin/env -S npx tsx
/**
 * Structured LitAlerts product ingest (issue #20).
 *
 * Walks `/v1/brands?state=<STATE>` and then, for each brand,
 * `/v1/brands/{brandId}/products?state=<STATE>&includeOOS=true`,
 * upserting the structured `LAProduct` + `LAProductConfig` payload
 * into `litalerts_brands` and `litalerts_products` (migration 028).
 *
 * Usage (from helios/):
 *
 *   DATABASE_URL="postgres://..." \
 *   LITALERTS_PARTNER_API_TOKEN="..." \
 *   npx tsx scripts/litalerts-structured-ingest.mts NY
 *
 * Token discovery follows the same convention as
 * src/worker/litalerts/partnerClient.ts (env var first, then
 * ~/.secret/litalerts/partner-api-token).
 *
 * This is intentionally a one-shot script for now. Once we trust
 * the structured snapshots vs. the legacy observation table, the
 * crawl will be promoted to a scheduled worker job; see the
 * litalerts_structured_ingest_runs heartbeat row this script
 * writes for the scaffolding.
 */

import { Pool } from 'pg'

import {
  listBrandsForState,
  listBrandProducts,
  listSystemCategories,
  listSystemSubcategories,
  type LitAlertsProduct,
} from '../src/worker/litalerts/partnerClient.js'

async function main(): Promise<void> {
  const stateCode = (process.argv[2] ?? 'NY').trim().toUpperCase()
  if (!stateCode) {
    console.error('usage: litalerts-structured-ingest.mts <STATE>  (e.g. NY)')
    process.exit(1)
  }
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  // Generous pool so highly-concurrent crawl workers don't queue
  // waiting for a DB client when their fetches return at the same time.
  // At default concurrency (384), most workers spend their time on
  // HTTP I/O, so a 64-conn pool is more than enough.
  const pool = new Pool({ connectionString: databaseUrl, max: 64 })

  // Heartbeat row — written on entry, finalised on exit.
  const startedAt = new Date()
  const heartbeat = await pool.query<{ run_id: number }>(
    `insert into litalerts_structured_ingest_runs (state_code, started_at)
       values ($1, $2)
       returning run_id`,
    [stateCode, startedAt],
  )
  const runId = heartbeat.rows[0].run_id
  console.log(`[run #${runId}] state=${stateCode} started ${startedAt.toISOString()}`)

  try {
    console.log(`[run #${runId}] fetching brand directory for state=${stateCode}…`)
    const brands = await listBrandsForState(stateCode)
    console.log(`[run #${runId}] saw ${brands.length} brands`)

    // Upsert the brand directory snapshot.
    const brandUpsert = await pool.connect()
    try {
      await brandUpsert.query('begin')
      for (const brand of brands) {
        const statesCsv = Array.isArray(brand.states) ? brand.states.join(',') : null
        await brandUpsert.query(
          `insert into litalerts_brands (brand_id, name, state_code, states_csv, last_seen_at)
             values ($1, $2, $3, $4, now())
             on conflict (brand_id) do update set
               name = excluded.name,
               state_code = excluded.state_code,
               states_csv = excluded.states_csv,
               last_seen_at = excluded.last_seen_at`,
          [brand.id, brand.name, stateCode, statesCsv],
        )
      }
      await brandUpsert.query('commit')
    } finally {
      brandUpsert.release()
    }

    // Walk each brand's product list and snapshot every config row.
    // Run fetches in parallel (LitAlerts partner API can answer up
    // to ~6 concurrent requests without rate-limit issues in our
    // current tier) and serialize writes through the shared pool.
    let productsSeen = 0
    let configRowsWritten = 0
    let processed = 0
    let fetchFailures = 0
    let retries = 0
    let categoryFallbacks = 0
    let subcategoryFallbacks = 0
    const categoryCounts: Record<string, number> = {}
    const concurrency = Number(process.env.LITALERTS_INGEST_CONCURRENCY ?? '384')
    const maxAttempts = Number(process.env.LITALERTS_INGEST_MAX_ATTEMPTS ?? '5')
    const baseBackoffMs = Number(process.env.LITALERTS_INGEST_BACKOFF_BASE_MS ?? '500')

    // Prefetch the global category list so the fallback path can split
    // a "too big" brand fetch into per-category requests without making
    // every worker independently re-discover the category set.
    console.log(`[run #${runId}] fetching system categories for fallback splitting…`)
    let categoryList: string[] = []
    try {
      categoryList = await listSystemCategories()
      console.log(`[run #${runId}] system categories: ${categoryList.join(', ')}`)
    } catch (err) {
      console.warn(
        `[run #${runId}] WARN failed to fetch system categories; large-brand fallback disabled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    // Cache of category -> subcategory list (lazy, populated on first
    // category that needs a subcategory fallback).
    const subcategoryCache = new Map<string, string[]>()
    async function getSubcategories(category: string): Promise<string[]> {
      const cached = subcategoryCache.get(category)
      if (cached) return cached
      const subs = await listSystemSubcategories(category)
      subcategoryCache.set(category, subs)
      return subs
    }

    // Adaptive global throttle: when any worker sees a 503 / 429
    // (upstream is overloaded), every other worker waits until the
    // cooldown expires before issuing its next request. The cooldown
    // grows multiplicatively while the storm persists and decays
    // back as successful requests come through.
    let throttledUntil = 0
    let throttleStreak = 0
    function noteOverloaded(): void {
      throttleStreak = Math.min(throttleStreak + 1, 12)
      // Subexponential (power-law) growth: 1000 * streak^1.5 ms.
      // streak = 1..12 yields 1000, 2828, 5196, 8000, 11180, 14697,
      // 18520, 22627, 27000, 31623 — capped to 30s so we never wedge
      // forever, but ramp slowly enough that we don't smash the API
      // harder than the natural per-attempt retry already does.
      const cooldownMs = Math.min(30_000, Math.round(1000 * Math.pow(throttleStreak, 1.5)))
      const candidate = Date.now() + cooldownMs
      if (candidate > throttledUntil) throttledUntil = candidate
    }
    function noteOk(): void {
      if (throttleStreak > 0) throttleStreak = Math.max(0, throttleStreak - 1)
    }
    async function awaitThrottle(): Promise<void> {
      while (Date.now() < throttledUntil) {
        await new Promise((r) => setTimeout(r, Math.min(500, throttledUntil - Date.now())))
      }
    }
    function isOverloadError(err: unknown): boolean {
      const m = err instanceof Error ? err.message : String(err)
      return /\b(503|429)\b/.test(m) || /Service Unavailable|Too Many Requests/i.test(m)
    }

    // Subexponential (power-law) backoff: delay = base * attempt^1.5.
    // For base=500ms gives 500, 1414, 2598, 4000, 5590 — bounded growth
    // so a struggling endpoint isn't smashed harder than ~6 in-flight
    // retries at any moment even at high concurrency.
    async function retryFetch<T>(
      op: () => Promise<T>,
      label: string,
    ): Promise<T> {
      let lastErr: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await awaitThrottle()
        try {
          const result = await op()
          noteOk()
          return result
        } catch (err) {
          lastErr = err
          if (isOverloadError(err)) noteOverloaded()
          if (attempt < maxAttempts) {
            retries += 1
            const delay = Math.round(baseBackoffMs * Math.pow(attempt, 1.5))
            await new Promise((r) => setTimeout(r, delay))
          }
        }
      }
      throw new Error(
        `${label}: failed after ${maxAttempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      )
    }

    async function fetchBrandProductsByCategory(
      brand: { id: number; name: string },
      category: string,
    ): Promise<LitAlertsProduct[]> {
      try {
        return await retryFetch(
          () => listBrandProducts(brand.id, { stateCode, includeOutOfStock: true, categoryFilter: category }),
          `brand ${brand.id} cat=${category}`,
        )
      } catch {
        // Per-category fetch still too big — split by subcategory.
        subcategoryFallbacks += 1
        const subs = await retryFetch(() => getSubcategories(category), `subcategories cat=${category}`).catch(() => [])
        if (subs.length === 0) throw new Error(`brand ${brand.id} cat=${category}: no subcategories available for split`)
        const out: LitAlertsProduct[] = []
        for (const sub of subs) {
          try {
            const subProducts = await retryFetch(
              () =>
                listBrandProducts(brand.id, {
                  stateCode,
                  includeOutOfStock: true,
                  categoryFilter: category,
                  subcategoryFilter: sub,
                }),
              `brand ${brand.id} cat=${category} sub=${sub}`,
            )
            out.push(...subProducts)
          } catch (err) {
            console.warn(
              `[run #${runId}] brand ${brand.id} cat=${category} sub=${sub} skipped: ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
        return out
      }
    }

    async function fetchBrandProductsWithRetry(brand: { id: number; name: string }): Promise<LitAlertsProduct[]> {
      try {
        return await retryFetch(
          () => listBrandProducts(brand.id, { stateCode, includeOutOfStock: true }),
          `brand ${brand.id}`,
        )
      } catch {
        // Full-brand fetch keeps timing out (likely too many products
        // for the endpoint to materialize within 30s). Fall back to
        // per-category fanout and aggregate the union.
        categoryFallbacks += 1
        if (categoryList.length === 0) throw new Error(`brand ${brand.id}: full fetch failed and no categories available for fallback`)
        const aggregate = new Map<number, LitAlertsProduct>()
        const results = await Promise.all(
          categoryList.map(async (cat) => {
            try {
              return await fetchBrandProductsByCategory(brand, cat)
            } catch (err) {
              console.warn(
                `[run #${runId}] brand ${brand.id} cat=${cat} skipped: ${err instanceof Error ? err.message : String(err)}`,
              )
              return [] as LitAlertsProduct[]
            }
          }),
        )
        for (const bucket of results) {
          for (const p of bucket) {
            // Dedupe by product id — a product belongs to a single
            // category in practice, but defend against duplicates.
            if (!aggregate.has(p.id)) aggregate.set(p.id, p)
          }
        }
        if (aggregate.size === 0) throw new Error(`brand ${brand.id}: full + per-category fallback both produced 0 rows`)
        return [...aggregate.values()]
      }
    }

    let cursor = 0
    async function worker(): Promise<void> {
      while (true) {
        const i = cursor++
        if (i >= brands.length) return
        const brand = brands[i]
        let products: LitAlertsProduct[]
        try {
          products = await fetchBrandProductsWithRetry(brand)
        } catch (err) {
          fetchFailures += 1
          console.warn(
            `[run #${runId}] brand ${brand.id} (${brand.name}) — fetch failed after ${maxAttempts} attempts: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          processed += 1
          continue
        }
        productsSeen += products.length
        if (products.length > 0) {
          const client = await pool.connect()
          try {
            await client.query('begin')
            for (const product of products) {
              const configs = Array.isArray(product.configs) ? product.configs : []
              for (let configIdx = 0; configIdx < configs.length; configIdx += 1) {
                const cfg = configs[configIdx]
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
                    product.brandId ?? brand.id ?? null,
                    product.brand ?? brand.name ?? null,
                    product.retailerId ?? null,
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
                configRowsWritten += 1
              }
              if (product.category) {
                categoryCounts[product.category] = (categoryCounts[product.category] ?? 0) + 1
              }
            }
            await client.query('commit')
          } catch (err) {
            await client.query('rollback').catch(() => {})
            console.warn(
              `[run #${runId}] brand ${brand.id} (${brand.name}) — write failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          } finally {
            client.release()
          }
        }
        processed += 1
        if (processed % 25 === 0 || processed === brands.length) {
          console.log(
            `[run #${runId}] (${processed}/${brands.length}) processed; products=${productsSeen} configs=${configRowsWritten} fetch-failures=${fetchFailures} retries=${retries} cat-fallbacks=${categoryFallbacks} sub-fallbacks=${subcategoryFallbacks}`,
          )
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))

    await pool.query(
      `update litalerts_structured_ingest_runs
         set finished_at = now(), ok = true,
             brands_seen = $2, products_seen = $3, config_rows_written = $4,
             category_counts = $5::jsonb
         where run_id = $1`,
      [runId, brands.length, productsSeen, configRowsWritten, JSON.stringify(categoryCounts)],
    )
    console.log(`[run #${runId}] ok — brands=${brands.length} products=${productsSeen} configs=${configRowsWritten}`)
    console.log(`[run #${runId}] category counts:`, categoryCounts)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await pool.query(
      `update litalerts_structured_ingest_runs
         set finished_at = now(), ok = false, error_message = $2
         where run_id = $1`,
      [runId, message],
    )
    console.error(`[run #${runId}] FAILED: ${message}`)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

function numericOrNull(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function integerOrNull(v: unknown): number | null {
  const n = numericOrNull(v)
  return n == null ? null : Math.trunc(n)
}

function stringOrNull(v: unknown): string | null {
  if (v == null) return null
  return String(v)
}

void main()
