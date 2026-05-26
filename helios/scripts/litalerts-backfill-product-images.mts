#!/usr/bin/env -S npx tsx
/**
 * One-off backfill: per-product primary image URLs from LitAlerts.
 *
 * The structured partner-API (partnerapi.litalerts.com) does not
 * surface image fields on any documented endpoint — only
 * medicalURL/recreationalURL (Dutchie embedded-menu pages that are
 * Cloudflare-protected and unscrapeable from datacenter IPs).
 *
 * The LitAlerts *dashboard* backend at
 *
 *   POST https://public-api.litalerts.com/Products/menulistings
 *
 * (Cognito-bearer-auth, used by the app.litalerts.com SPA) DOES
 * return a per-listing `imageUrl` that resolves to a stable S3
 * Dutchie CDN URL — directly fetchable, no CF in the middle.
 *
 * This script enumerates every brand_id we've cached in
 * `litalerts_products` for a given state, calls /Products/menulistings
 * once per brand at pagesize=5000, and upserts each
 * (state_code, listing.id, imageUrl) tuple into
 * `litalerts_product_images`.
 *
 * The Cognito access token has only a ~6h TTL, so we read it from
 * the LITALERTS_DASHBOARD_BEARER env var (or a path passed via
 * LITALERTS_DASHBOARD_BEARER_FILE). We do NOT persist it.
 *
 * Usage:
 *
 *   DATABASE_URL="postgres://..." \
 *   LITALERTS_DASHBOARD_BEARER_FILE=/tmp/har/bearer \
 *   npx tsx scripts/litalerts-backfill-product-images.mts NY
 *
 * Tunables (env):
 *   LITALERTS_IMG_CONCURRENCY (default 8)
 *   LITALERTS_IMG_PAGESIZE    (default 5000)
 */

import fs from 'node:fs'
import { Pool } from 'pg'

const STATE_ID_BY_CODE: Record<string, number> = {
  NY: 265,
}

interface DashboardListing {
  id: number
  imageUrl?: string | null
}

interface DashboardResponse {
  listings: DashboardListing[]
  total: number
}

async function fetchBrandListings(args: {
  bearer: string
  stateId: number
  brandId: number
  pagesize: number
}): Promise<DashboardListing[]> {
  const { bearer, stateId, brandId, pagesize } = args
  const all: DashboardListing[] = []
  let page = 0
  while (true) {
    const body = {
      brandIDs: [brandId],
      page,
      pagesize,
      sortfields: ['Name'],
      filters: {
        Brand: `[${brandId}]`,
        Availability: 'All',
        Image: 'All',
        MedRec: 'All',
        ShowStaleItems: 'False',
        ShowHiddenDisps: 'false',
        StateID: String(stateId),
      },
      dispensaryIDs: null,
      stateID: stateId,
    }
    let lastError: unknown = null
    let resp: Response | null = null
    // n^1.5 backoff on 5xx / network
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const r = await fetch('https://public-api.litalerts.com/Products/menulistings', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json; charset=utf-8',
            origin: 'https://app.litalerts.com',
            referer: 'https://app.litalerts.com/',
          },
          body: JSON.stringify(body),
        })
        if (r.status === 401 || r.status === 403) {
          throw new Error(`auth-failed http=${r.status} (token likely expired)`)
        }
        if (r.status >= 500 || r.status === 429) {
          throw new Error(`retryable http=${r.status}`)
        }
        if (!r.ok) {
          throw new Error(`non-retryable http=${r.status} body=${(await r.text()).slice(0, 200)}`)
        }
        resp = r
        break
      } catch (e) {
        lastError = e
        if (e instanceof Error && e.message.startsWith('auth-failed')) throw e
        if (e instanceof Error && e.message.startsWith('non-retryable')) throw e
        const delayMs = Math.min(30_000, Math.round(1000 * Math.pow(attempt, 1.5)))
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    if (!resp) throw lastError instanceof Error ? lastError : new Error(String(lastError))
    const data = (await resp.json()) as DashboardResponse
    const batch = data.listings ?? []
    all.push(...batch)
    if (batch.length < pagesize || all.length >= (data.total ?? 0)) break
    page += 1
    if (page > 50) break // hard safety
  }
  return all
}

async function upsertImages(
  pool: Pool,
  stateCode: string,
  pairs: Array<{ productId: number; imageUrl: string }>,
): Promise<number> {
  if (pairs.length === 0) return 0
  const productIds = pairs.map((p) => p.productId)
  const imageUrls = pairs.map((p) => p.imageUrl)
  const result = await pool.query(
    `insert into litalerts_product_images (state_code, product_id, image_url, fetched_at)
     select $1, p_id, img, now()
     from unnest($2::bigint[], $3::text[]) as t(p_id, img)
     on conflict (state_code, product_id) do update
       set image_url  = excluded.image_url,
           fetched_at = excluded.fetched_at`,
    [stateCode, productIds, imageUrls],
  )
  return result.rowCount ?? 0
}

async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

async function main(): Promise<void> {
  const stateCode = (process.argv[2] ?? 'NY').trim().toUpperCase()
  const stateId = STATE_ID_BY_CODE[stateCode]
  if (!stateId) {
    throw new Error(`unknown state ${stateCode}; supported: ${Object.keys(STATE_ID_BY_CODE).join(', ')}`)
  }
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL required')
  const bearerFile = process.env.LITALERTS_DASHBOARD_BEARER_FILE
  const bearer = (process.env.LITALERTS_DASHBOARD_BEARER ?? (bearerFile ? fs.readFileSync(bearerFile, 'utf8') : '')).trim()
  if (!bearer) throw new Error('LITALERTS_DASHBOARD_BEARER or LITALERTS_DASHBOARD_BEARER_FILE required')

  const concurrency = Number.parseInt(process.env.LITALERTS_IMG_CONCURRENCY ?? '8', 10)
  const pagesize = Number.parseInt(process.env.LITALERTS_IMG_PAGESIZE ?? '5000', 10)

  const pool = new Pool({ connectionString: databaseUrl, max: 8 })
  try {
    // Brands we've cached in litalerts_products for the state.
    const { rows: brandRows } = await pool.query<{ brand_id: number; brand_name: string | null; n: number }>(
      `select brand_id, brand_name, count(distinct product_id)::int as n
       from litalerts_products
       where state_code = $1 and brand_id is not null
       group by brand_id, brand_name
       order by n desc`,
      [stateCode],
    )
    console.log(`[backfill] state=${stateCode} brands=${brandRows.length} concurrency=${concurrency} pagesize=${pagesize}`)

    let totalListings = 0
    let totalWithImage = 0
    let totalUpserted = 0
    let brandsDone = 0
    const failures: Array<{ brandId: number; brandName: string | null; error: string }> = []
    const t0 = Date.now()

    await withConcurrency(brandRows, concurrency, async (b) => {
      try {
        const listings = await fetchBrandListings({ bearer, stateId, brandId: b.brand_id, pagesize })
        const pairs = listings
          .filter((l) => typeof l.imageUrl === 'string' && l.imageUrl && l.id)
          .map((l) => ({ productId: l.id, imageUrl: l.imageUrl as string }))
        const upserted = await upsertImages(pool, stateCode, pairs)
        totalListings += listings.length
        totalWithImage += pairs.length
        totalUpserted += upserted
        brandsDone += 1
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
        console.log(
          `[backfill] [${brandsDone}/${brandRows.length}] brand=${b.brand_id} ${b.brand_name ?? '(?)'} listings=${listings.length} withImg=${pairs.length} upserted=${upserted} elapsedSec=${elapsed}`,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        failures.push({ brandId: b.brand_id, brandName: b.brand_name, error: msg })
        brandsDone += 1
        console.error(`[backfill] [${brandsDone}/${brandRows.length}] brand=${b.brand_id} ${b.brand_name ?? '(?)'} FAILED: ${msg}`)
        if (msg.startsWith('auth-failed')) throw e // stop the whole run on dead token
      }
    })

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(
      `[backfill] DONE state=${stateCode} brands=${brandRows.length} failures=${failures.length} ` +
        `listings=${totalListings} withImage=${totalWithImage} upserted=${totalUpserted} elapsedSec=${elapsed}`,
    )
    if (failures.length > 0) {
      console.log(`[backfill] failed brands:`, failures.slice(0, 20))
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
