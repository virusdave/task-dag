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
 * The full implementation lives in
 * `src/worker/litalerts/retailerProductsBackfill.ts` so the
 * scheduled background job (config.workers.litalerts_retailer_
 * backfill) and this one-shot script share the same resume /
 * retry / deferred-retry semantics. Keep them in sync; do not
 * fork.
 *
 * Usage:
 *
 *   DATABASE_URL="postgres://…" \
 *   LITALERTS_PARTNER_API_TOKEN="…" \
 *   npx tsx scripts/litalerts-retailer-products-backfill.mts NY
 *
 * Tunables (env):
 *   LITALERTS_RETAILER_BACKFILL_CONCURRENCY (default 24)
 *   LITALERTS_MAX_DISTANCE_MILES            (default 50)
 *   LITALERTS_SKIP_IF_INGESTED_WITHIN_HOURS (default 6)
 */

import { Pool } from 'pg'

import { runRetailerProductsBackfill } from '../src/worker/litalerts/retailerProductsBackfill.js'

const DEFAULT_CONCURRENCY = Number.parseInt(process.env.LITALERTS_RETAILER_BACKFILL_CONCURRENCY ?? '24', 10)
const DEFAULT_MAX_DISTANCE_MILES = Number.parseFloat(process.env.LITALERTS_MAX_DISTANCE_MILES ?? '50')
const DEFAULT_SKIP_IF_INGESTED_WITHIN_HOURS = Number.parseFloat(
  process.env.LITALERTS_SKIP_IF_INGESTED_WITHIN_HOURS ?? '6',
)

async function main(): Promise<void> {
  const stateCode = (process.argv[2] ?? 'NY').trim().toUpperCase()
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  const concurrency = Math.max(1, DEFAULT_CONCURRENCY)
  const maxDistance = Math.max(0, DEFAULT_MAX_DISTANCE_MILES)
  const skipHours = Math.max(0, DEFAULT_SKIP_IF_INGESTED_WITHIN_HOURS)
  const pool = new Pool({ connectionString: databaseUrl, max: Math.min(concurrency + 4, 64) })

  try {
    await runRetailerProductsBackfill(pool, {
      stateCode,
      concurrency,
      maxDistanceMiles: maxDistance,
      skipIfIngestedWithinHours: skipHours,
    })
  } finally {
    await pool.end()
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
