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
  // Generous pool so 32-way concurrent crawl workers don't queue
  // waiting for a DB client when their fetches return at the same time.
  const pool = new Pool({ connectionString: databaseUrl, max: 40 })

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
    const categoryCounts: Record<string, number> = {}
    const concurrency = Number(process.env.LITALERTS_INGEST_CONCURRENCY ?? '32')
    const maxAttempts = Number(process.env.LITALERTS_INGEST_MAX_ATTEMPTS ?? '5')
    const baseBackoffMs = Number(process.env.LITALERTS_INGEST_BACKOFF_BASE_MS ?? '500')

    // Subexponential (power-law) backoff: delay = base * attempt^1.5.
    // For base=500ms gives 500, 1414, 2598, 4000, 5590 — bounded growth
    // so a struggling endpoint isn't smashed harder than 6 in-flight
    // retries at any moment, even at concurrency=32.
    async function fetchBrandProductsWithRetry(brand: { id: number; name: string }): Promise<LitAlertsProduct[]> {
      let lastErr: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await listBrandProducts(brand.id, { stateCode, includeOutOfStock: true })
        } catch (err) {
          lastErr = err
          if (attempt < maxAttempts) {
            retries += 1
            const delay = Math.round(baseBackoffMs * Math.pow(attempt, 1.5))
            await new Promise((r) => setTimeout(r, delay))
          }
        }
      }
      throw lastErr
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
            `[run #${runId}] (${processed}/${brands.length}) processed; products=${productsSeen} configs=${configRowsWritten} fetch-failures=${fetchFailures} retries=${retries}`,
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
