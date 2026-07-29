#!/usr/bin/env -S npx tsx
/**
 * One-off: retrieve ALL current listing data for every brand in OUR catalog,
 * from every one of OUR near/mid geographic competitors (issue #55 follow-on).
 *
 * This is the concrete "pull the data" step the operator asked for after we
 * settled the geographic-competitor question:
 *
 *   1. We already geocode every NY LitAlerts retailer
 *      (`litalerts_retailer_locations`) and know our own store coordinates
 *      (`helios_store_locations`), so we can rank every retailer by min
 *      great-circle distance to one of our two stores.
 *   2. We keep an operator-confirmed catalog-brand -> LitAlerts-brand mapping
 *      (`catalog_litalerts_brand_overrides`), backfilled by a normalized-name
 *      exact match for brands not yet reviewed.
 *   3. The partner API's `/v1/retailers/{id}/products?brandIds=...` endpoint
 *      returns a retailer's menu restricted to a brand set server-side. We ask
 *      each near/mid competitor for our *entire* catalog brand set in ONE call
 *      (repeated `brandIds` params), so the whole pull is ~1 request per
 *      competitor regardless of catalog size.
 *
 * Unlike the LitAlerts sales-analytics endpoints, this does NOT depend on
 * whether LitAlerts thinks a retailer "sold" anything in a window: we query
 * each competitor's live menu directly. New dispensaries open rarely, so the
 * geocoded directory is a good enough competitor set between refreshes (see
 * FreshlyBakedNYC/automation#56 for the durable auto-refresh follow-up).
 *
 * Output: a self-contained HTML report (summary + per-competitor + per-brand
 * rollups, with the full row-level dataset downloadable as CSV) which the
 * caller uploads via `scripts/upload-to-mss`.
 *
 * Usage:
 *
 *   HELIOS_READONLY_DATABASE_URL="postgres://…" \
 *   npx tsx scripts/litalerts-catalog-brands-at-competitors.mts [maxMiles] [outFile]
 *
 * Defaults: maxMiles=3 (near+mid bands), outFile=/tmp/catalog-brands-at-competitors.html
 *
 * Env tunables:
 *   LITALERTS_PARTNER_API_TOKEN            (else ~/.secret/litalerts/partner-api-token)
 *   COMPETITOR_FANOUT_CONCURRENCY          (default 8)
 *   INCLUDE_OOS                            ('1'/'true' to include out-of-stock listings)
 */

import { writeFileSync } from 'node:fs'

import { Pool } from 'pg'
import { readRequiredReadOnlyDatabaseUrl } from '../src/shared/config/runtimeEnv.js'

import {
  PRICING_MID_DISTANCE_MAX_MILES,
  PRICING_NEAR_DISTANCE_MAX_MILES,
} from '../src/shared/domain/pricingGeneration.js'
import {
  listBrandsForState,
  listRetailerProducts,
  type LitAlertsProduct,
} from '../src/worker/litalerts/partnerClient.js'

const STATE_CODE = 'NY'
const DEFAULT_MAX_MILES = 3
const DEFAULT_OUT_FILE = '/tmp/catalog-brands-at-competitors.html'
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.COMPETITOR_FANOUT_CONCURRENCY ?? '8', 10))
const INCLUDE_OOS = /^(1|true|yes)$/i.test(process.env.INCLUDE_OOS ?? '')

/** Mirror of `normalizeBrandKey` in src/worker/pricing/litAlertsMarket.ts. */
function normalizeBrandKey(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function stripParentheticalSuffix(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*$/g, '').trim()
}

interface CompetitorRetailer {
  retailerId: number
  name: string
  address: string | null
  distanceMiles: number
  band: 'near' | 'mid'
  nearestStoreKey: string
}

interface BrandResolution {
  catalogBrandName: string
  litalertsBrandId: number
  litalertsBrandName: string
  source: 'override' | 'heuristic'
}

interface ListingRow {
  retailerId: number
  retailerName: string
  distanceMiles: number
  band: 'near' | 'mid'
  nearestStoreKey: string
  litalertsBrandId: number | null
  brandName: string
  productId: number
  productName: string
  category: string | null
  amount: string | null
  units: string | null
  normalPrice: number | null
  salePrice: number | null
  currentStock: number | null
  recreational: boolean | null
  medical: boolean | null
  url: string | null
}

async function loadCompetitors(pool: Pool, maxMiles: number): Promise<CompetitorRetailer[]> {
  const result = await pool.query<{
    retailer_id: string
    name: string
    address: string | null
    miles: number
    nearest_store_key: string
  }>(
    `
      with retailer_distances as (
        select
          r.retailer_id,
          r.name,
          r.address,
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
        where r.latitude is not null and r.longitude is not null
          and s.latitude is not null and s.longitude is not null
          and r.state_code = $1
      ),
      nearest as (
        select distinct on (retailer_id)
          retailer_id, name, address, miles, site_key as nearest_store_key
        from retailer_distances
        order by retailer_id, miles asc
      )
      select retailer_id::text as retailer_id, name, address, miles, nearest_store_key
      from nearest
      where miles <= $2
        and lower(name) not like '%freshly baked%'
      order by miles asc
    `,
    [STATE_CODE, maxMiles],
  )
  return result.rows.map((row) => ({
    retailerId: Number(row.retailer_id),
    name: row.name,
    address: row.address,
    distanceMiles: row.miles,
    band: row.miles <= PRICING_NEAR_DISTANCE_MAX_MILES ? 'near' : 'mid',
    nearestStoreKey: row.nearest_store_key,
  }))
}

async function resolveCatalogBrands(pool: Pool): Promise<{
  resolutions: BrandResolution[]
  explicitlyUnmapped: string[]
  unresolved: string[]
}> {
  const [catalogRows, overrideRows, litalertsBrands] = await Promise.all([
    pool.query<{ brand_name: string }>(
      `select distinct brand_name from catalog_groups
        where brand_name is not null and length(trim(brand_name)) > 0
        order by brand_name`,
    ),
    pool.query<{ catalog_brand_name: string; litalerts_brand_id: string | null; litalerts_brand_name: string | null }>(
      `select catalog_brand_name, litalerts_brand_id::text as litalerts_brand_id, litalerts_brand_name
         from catalog_litalerts_brand_overrides`,
    ),
    listBrandsForState(STATE_CODE),
  ])

  const overrideByName = new Map<string, { id: number | null; name: string | null }>()
  for (const row of overrideRows.rows) {
    overrideByName.set(row.catalog_brand_name, {
      id: row.litalerts_brand_id != null ? Number(row.litalerts_brand_id) : null,
      name: row.litalerts_brand_name,
    })
  }

  const brandById = new Map<number, string>()
  const brandByKey = new Map<string, { id: number; name: string }>()
  const brandByStrippedKey = new Map<string, { id: number; name: string }>()
  for (const brand of litalertsBrands) {
    brandById.set(brand.id, brand.name)
    const key = normalizeBrandKey(brand.name)
    if (key && !brandByKey.has(key)) brandByKey.set(key, { id: brand.id, name: brand.name })
    const strippedKey = stripParentheticalSuffix(key)
    if (strippedKey && !brandByStrippedKey.has(strippedKey)) {
      brandByStrippedKey.set(strippedKey, { id: brand.id, name: brand.name })
    }
  }

  const resolutions: BrandResolution[] = []
  const explicitlyUnmapped: string[] = []
  const unresolved: string[] = []

  for (const { brand_name: catalogBrandName } of catalogRows.rows) {
    const override = overrideByName.get(catalogBrandName)
    if (override) {
      if (override.id === null) {
        explicitlyUnmapped.push(catalogBrandName)
        continue
      }
      resolutions.push({
        catalogBrandName,
        litalertsBrandId: override.id,
        litalertsBrandName: override.name ?? brandById.get(override.id) ?? `#${override.id}`,
        source: 'override',
      })
      continue
    }
    // No operator override row: fall back to a normalized-name exact match
    // against the live LitAlerts NY brand directory (parenthetical-suffix
    // tolerant), mirroring the pricing path's heuristic.
    const key = normalizeBrandKey(catalogBrandName)
    const hit = brandByKey.get(key) ?? brandByStrippedKey.get(stripParentheticalSuffix(key))
    if (hit) {
      resolutions.push({
        catalogBrandName,
        litalertsBrandId: hit.id,
        litalertsBrandName: hit.name,
        source: 'heuristic',
      })
    } else {
      unresolved.push(catalogBrandName)
    }
  }

  return { resolutions, explicitlyUnmapped, unresolved }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function toStringOrNull(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}

function productToRows(
  competitor: CompetitorRetailer,
  product: LitAlertsProduct,
  catalogBrandByLitId: Map<number, string>,
): ListingRow[] {
  const brandName =
    (product.brandId != null ? catalogBrandByLitId.get(product.brandId) : undefined) ??
    product.brand ??
    (product.brandId != null ? `#${product.brandId}` : 'unknown')
  const url = product.recreationalURL ?? product.medicalURL ?? null
  const configs = product.configs.length > 0 ? product.configs : [null]
  return configs.map((config) => ({
    retailerId: competitor.retailerId,
    retailerName: competitor.name,
    distanceMiles: competitor.distanceMiles,
    band: competitor.band,
    nearestStoreKey: competitor.nearestStoreKey,
    litalertsBrandId: product.brandId ?? null,
    brandName,
    productId: product.id,
    productName: product.name,
    category: product.category ?? null,
    amount: config ? toStringOrNull(config.amount) : null,
    units: config?.units ?? null,
    normalPrice: config ? toNumber(config.normalPrice) : null,
    salePrice: config ? toNumber(config.salePrice) : null,
    currentStock: config ? toNumber(config.currentStock) : null,
    recreational: config?.recreational ?? null,
    medical: config?.medical ?? null,
    url,
  }))
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function buildCsv(rows: ListingRow[]): string {
  const header = [
    'retailer_id',
    'retailer_name',
    'distance_miles',
    'band',
    'nearest_store',
    'litalerts_brand_id',
    'brand',
    'product_id',
    'product_name',
    'category',
    'amount',
    'units',
    'normal_price',
    'sale_price',
    'current_stock',
    'recreational',
    'medical',
    'url',
  ]
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.retailerId,
        r.retailerName,
        r.distanceMiles.toFixed(3),
        r.band,
        r.nearestStoreKey,
        r.litalertsBrandId ?? '',
        r.brandName,
        r.productId,
        r.productName,
        r.category ?? '',
        r.amount ?? '',
        r.units ?? '',
        r.normalPrice ?? '',
        r.salePrice ?? '',
        r.currentStock ?? '',
        r.recreational ?? '',
        r.medical ?? '',
        r.url ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return lines.join('\n')
}

function fmtPrice(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`
}

function buildHtml(input: {
  rows: ListingRow[]
  competitors: CompetitorRetailer[]
  resolutions: BrandResolution[]
  explicitlyUnmapped: string[]
  unresolved: string[]
  competitorErrors: { retailerId: number; name: string; error: string }[]
  maxMiles: number
  generatedAt: Date
  csvDataUri: string
}): string {
  const { rows, competitors, resolutions, explicitlyUnmapped, unresolved, competitorErrors, maxMiles, generatedAt, csvDataUri } =
    input

  const distinctProducts = new Set(rows.map((r) => `${r.retailerId}:${r.productId}`)).size
  const distinctBrandsWithListings = new Set(rows.map((r) => r.brandName)).size
  const competitorsWithData = new Set(rows.map((r) => r.retailerId)).size

  // Per-competitor rollup
  const byCompetitor = new Map<number, { c: CompetitorRetailer; listings: number; brands: Set<string> }>()
  for (const c of competitors) byCompetitor.set(c.retailerId, { c, listings: 0, brands: new Set() })
  for (const r of rows) {
    const entry = byCompetitor.get(r.retailerId)
    if (entry) {
      entry.listings += 1
      entry.brands.add(r.brandName)
    }
  }
  const competitorRows = [...byCompetitor.values()]
    .sort((a, b) => a.c.distanceMiles - b.c.distanceMiles)
    .map(
      (e) => `<tr>
        <td>${esc(e.c.name)}</td>
        <td class="num">${e.c.distanceMiles.toFixed(2)}</td>
        <td><span class="band band-${e.c.band}">${e.c.band}</span></td>
        <td>${esc(e.c.nearestStoreKey)}</td>
        <td class="num">${e.listings.toLocaleString()}</td>
        <td class="num">${e.brands.size.toLocaleString()}</td>
      </tr>`,
    )
    .join('')

  // Per-brand rollup
  const byBrand = new Map<string, { listings: number; competitors: Set<number>; prices: number[] }>()
  for (const r of rows) {
    let entry = byBrand.get(r.brandName)
    if (!entry) {
      entry = { listings: 0, competitors: new Set(), prices: [] }
      byBrand.set(r.brandName, entry)
    }
    entry.listings += 1
    entry.competitors.add(r.retailerId)
    const price = r.salePrice ?? r.normalPrice
    if (price !== null) entry.prices.push(price)
  }
  const brandRows = [...byBrand.entries()]
    .sort((a, b) => b[1].competitors.size - a[1].competitors.size || b[1].listings - a[1].listings)
    .map(([brand, e]) => {
      const min = e.prices.length ? Math.min(...e.prices) : null
      const max = e.prices.length ? Math.max(...e.prices) : null
      return `<tr>
        <td>${esc(brand)}</td>
        <td class="num">${e.competitors.size}</td>
        <td class="num">${e.listings.toLocaleString()}</td>
        <td class="num">${fmtPrice(min)}</td>
        <td class="num">${fmtPrice(max)}</td>
      </tr>`
    })
    .join('')

  // Row-level PREVIEW only (kept collapsed; the downloadable CSV is the
  // canonical full export). Rendering all 37k rows inline balloons the page to
  // ~24MB and janks phones, so cap the DOM to the nearest-first preview.
  const PREVIEW_LIMIT = 500
  const sortedRows = rows
    .slice()
    .sort(
      (a, b) =>
        a.distanceMiles - b.distanceMiles ||
        a.retailerId - b.retailerId ||
        a.brandName.localeCompare(b.brandName) ||
        a.productName.localeCompare(b.productName),
    )
  const fullRows = sortedRows
    .slice(0, PREVIEW_LIMIT)
    .map(
      (r) => `<tr>
        <td>${esc(r.retailerName)}</td>
        <td class="num">${r.distanceMiles.toFixed(2)}</td>
        <td>${esc(r.brandName)}</td>
        <td>${esc(r.productName)}</td>
        <td>${esc(r.category ?? '')}</td>
        <td class="num">${esc([r.amount, r.units].filter(Boolean).join(' '))}</td>
        <td class="num">${fmtPrice(r.normalPrice)}</td>
        <td class="num">${r.salePrice !== null ? fmtPrice(r.salePrice) : '—'}</td>
        <td class="num">${r.currentStock ?? '—'}</td>
      </tr>`,
    )
    .join('')

  const overrideCount = resolutions.filter((r) => r.source === 'override').length
  const heuristicCount = resolutions.filter((r) => r.source === 'heuristic').length

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Catalog brands @ near/mid competitors</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; line-height: 1.4; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; }
  .sub { color: #888; font-size: 13px; margin: 0 0 16px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 8px; }
  .card { background: rgba(127,127,127,.12); border-radius: 10px; padding: 12px 16px; min-width: 120px; }
  .card .n { font-size: 24px; font-weight: 700; }
  .card .l { font-size: 12px; color: #888; }
  .dl { display: inline-block; margin: 8px 0 0; padding: 8px 14px; background: #2563eb; color: #fff;
        border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(127,127,127,.2); }
  th { position: sticky; top: 0; background: Canvas; cursor: default; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .band { font-size: 11px; padding: 1px 6px; border-radius: 6px; }
  .band-near { background: #16a34a33; color: #16a34a; }
  .band-mid { background: #ca8a0433; color: #ca8a04; }
  .scroll { max-height: 70vh; overflow: auto; border: 1px solid rgba(127,127,127,.2); border-radius: 8px; }
  details { margin: 16px 0; }
  summary { cursor: pointer; font-weight: 600; }
</style>
</head>
<body>
  <h1>Our catalog brands at near/mid competitors</h1>
  <p class="sub">Live LitAlerts menus pulled ${esc(generatedAt.toLocaleString('en-US', { timeZone: 'America/New_York' }))} America/New_York
     · within ${maxMiles} mi of a Freshly Baked store · ${INCLUDE_OOS ? 'including' : 'excluding'} out-of-stock listings</p>

  <div class="cards">
    <div class="card"><div class="n">${competitorsWithData}/${competitors.length}</div><div class="l">competitors with our brands</div></div>
    <div class="card"><div class="n">${rows.length.toLocaleString()}</div><div class="l">listing rows (product×size)</div></div>
    <div class="card"><div class="n">${distinctProducts.toLocaleString()}</div><div class="l">distinct products</div></div>
    <div class="card"><div class="n">${distinctBrandsWithListings}</div><div class="l">of our brands seen</div></div>
    <div class="card"><div class="n">${resolutions.length}</div><div class="l">catalog brands queried</div></div>
  </div>
  <a class="dl" href="${csvDataUri}" download="catalog-brands-at-competitors.csv">⬇ Download full CSV (${rows.length.toLocaleString()} rows)</a>

  <h2>Per-competitor (${competitors.length})</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>Competitor</th><th class="num">Dist (mi)</th><th>Band</th><th>Nearest</th><th class="num">Listings</th><th class="num">Brands</th></tr></thead>
      <tbody>${competitorRows}</tbody>
    </table>
  </div>

  <h2>Per-brand (${byBrand.size} with listings)</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>Brand</th><th class="num"># comps</th><th class="num">Listings</th><th class="num">Min price</th><th class="num">Max price</th></tr></thead>
      <tbody>${brandRows}</tbody>
    </table>
  </div>

  <details>
    <summary>Row-level listing preview (nearest ${Math.min(500, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} — full set in the CSV)</summary>
    <div class="scroll">
      <table>
        <thead><tr><th>Competitor</th><th class="num">Dist</th><th>Brand</th><th>Product</th><th>Category</th><th class="num">Size</th><th class="num">Normal</th><th class="num">Sale</th><th class="num">Stock</th></tr></thead>
        <tbody>${fullRows}</tbody>
      </table>
    </div>
  </details>

  <details>
    <summary>Methodology &amp; coverage</summary>
    <p>Competitors are every geocoded NY LitAlerts retailer within ${maxMiles} mi of one of our two stores
       (Bronx / Midtown), excluding our own locations, ranked by min great-circle distance. Near ≤
       ${PRICING_NEAR_DISTANCE_MAX_MILES} mi, mid ≤ ${PRICING_MID_DISTANCE_MAX_MILES} mi.</p>
    <p>Catalog brands come from <code>catalog_groups.brand_name</code>, mapped to LitAlerts brand ids via the
       operator-confirmed <code>catalog_litalerts_brand_overrides</code> table (${overrideCount}) plus a
       normalized-name exact match against the live LitAlerts NY directory for un-reviewed brands
       (${heuristicCount}). Each competitor menu is pulled in one
       <code>/v1/retailers/{id}/products?brandIds=…</code> call (repeated <code>brandIds</code> params) scoped
       to that brand set.</p>
    <p><strong>${explicitlyUnmapped.length}</strong> catalog brands are operator-flagged as having no LitAlerts
       equivalent and <strong>${unresolved.length}</strong> could not be resolved to a LitAlerts brand id;
       both are excluded from the pull.</p>
    ${
      unresolved.length
        ? `<p><strong>Unresolved:</strong> ${esc(unresolved.slice(0, 60).join(', '))}${unresolved.length > 60 ? ' …' : ''}</p>`
        : ''
    }
    ${
      competitorErrors.length
        ? `<p><strong>${competitorErrors.length} competitor fetch error(s):</strong> ${esc(
            competitorErrors.map((e) => `${e.name} (${e.error})`).slice(0, 20).join('; '),
          )}</p>`
        : '<p>All competitor menus fetched successfully.</p>'
    }
  </details>
</body>
</html>`
}

async function main(): Promise<void> {
  const maxMiles = Number.parseFloat(process.argv[2] ?? String(DEFAULT_MAX_MILES))
  const outFile = process.argv[3] ?? DEFAULT_OUT_FILE
  const databaseUrl = readRequiredReadOnlyDatabaseUrl()
  if (!Number.isFinite(maxMiles) || maxMiles <= 0) {
    console.error(`Invalid maxMiles: ${process.argv[2]}`)
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl, max: Math.min(CONCURRENCY + 4, 32) })
  try {
    console.log(`Resolving catalog brands and near/mid competitors (≤${maxMiles} mi)…`)
    const [{ resolutions, explicitlyUnmapped, unresolved }, competitors] = await Promise.all([
      resolveCatalogBrands(pool),
      loadCompetitors(pool, maxMiles),
    ])
    const brandIds = [...new Set(resolutions.map((r) => r.litalertsBrandId))]
    const catalogBrandByLitId = new Map<number, string>()
    for (const r of resolutions) {
      if (!catalogBrandByLitId.has(r.litalertsBrandId)) {
        catalogBrandByLitId.set(r.litalertsBrandId, r.catalogBrandName)
      }
    }
    console.log(
      `  ${resolutions.length} catalog brands -> ${brandIds.length} distinct LitAlerts brand ids ` +
        `(${explicitlyUnmapped.length} explicitly unmapped, ${unresolved.length} unresolved)`,
    )
    console.log(`  ${competitors.length} competitors within ${maxMiles} mi`)

    if (brandIds.length === 0) {
      console.error('No resolvable catalog brands; aborting.')
      process.exit(1)
    }

    const competitorErrors: { retailerId: number; name: string; error: string }[] = []
    const allRows: ListingRow[] = []
    let done = 0
    await mapWithConcurrency(competitors, CONCURRENCY, async (competitor) => {
      try {
        const products = await listRetailerProducts(competitor.retailerId, {
          stateCode: STATE_CODE,
          brandIds,
          includeOutOfStock: INCLUDE_OOS,
        })
        for (const product of products) {
          allRows.push(...productToRows(competitor, product, catalogBrandByLitId))
        }
      } catch (error) {
        competitorErrors.push({
          retailerId: competitor.retailerId,
          name: competitor.name,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        done += 1
        if (done % 10 === 0 || done === competitors.length) {
          console.log(`  fetched ${done}/${competitors.length} competitors (${allRows.length} rows so far)`)
        }
      }
    })

    console.log(`Done: ${allRows.length} listing rows across ${competitors.length} competitors.`)
    if (competitorErrors.length) {
      console.warn(`  ${competitorErrors.length} competitor(s) failed to fetch.`)
    }

    const csv = buildCsv(allRows)
    const csvDataUri = `data:text/csv;base64,${Buffer.from(csv, 'utf8').toString('base64')}`
    const html = buildHtml({
      rows: allRows,
      competitors,
      resolutions,
      explicitlyUnmapped,
      unresolved,
      competitorErrors,
      maxMiles,
      generatedAt: new Date(),
      csvDataUri,
    })
    writeFileSync(outFile, html, 'utf8')
    console.log(`Wrote report: ${outFile}`)
    console.log(`Upload with: scripts/upload-to-mss ${outFile} "Catalog brands @ near/mid competitors" 86400`)
  } finally {
    await pool.end()
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
