#!/usr/bin/env node
/**
 * Gather everything the interactive OTD-pricing scratchpad needs for the
 * 9 brands that the Bronx "1Off Brands 20% Off" promo (campaign 13035 /
 * action 45102 at dealer 210249) targets:
 *
 *  - Per-product catalog facts pulled live from Sweed: name, brand,
 *    category/subcategory, wholesale cost, chain (global) price, any
 *    current Bronx local-price override.
 *  - Per-product competitor menu listings refreshed live via the
 *    Helios partner-API litAlerts pipeline (`buildPricingMarketContext`
 *    in `helios/dist/server/worker/pricing/litAlertsMarket.js`). This
 *    bypasses the helios worker queue entirely and just calls the
 *    same function the worker would call. The data goes into
 *    `data.json` for `build_page.mjs` to render; we don't persist
 *    it back to the helios `litalerts_competitor_observations` table.
 *
 * Output: `data.json` next to this script.
 *
 * Auth:
 *  - Sweed: shared file `~/.secret/sweed/...` via the existing
 *    `bulk_additions/2026-04-10/apply_product_catalog_attribute_updates.py`
 *    helper. The Sweed catalog/group enumeration is done in a separate
 *    Python subprocess (this script invokes it) because the existing
 *    Sweed RPC client is Python.
 *  - Lit Alerts partner API: token at
 *    `~/.secret/litalerts/partner-api-token` (the same token Helios's
 *    `partnerClient.ts` loads).
 *  - TigerData (helios DB): read-only URL at
 *    `~/.secret/tigerdata/helios-readonly-url`.
 *
 * Run:
 *    cd catalog/repricing/2026-05-18-1off-bronx-otd
 *    node gather_data.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// We deliberately import helios bits from the shared checkout (which
// has a populated `helios/node_modules` + compiled `helios/dist/`),
// not from this ephemeral worktree where those directories don't
// exist. The ephemeral checkout policy is about source-of-truth +
// committable artifacts; the helios runtime is read-only here.
import pg from '/home/amp-local/src/automation/helios/node_modules/pg/lib/index.js'
import { buildPricingMarketContext } from '/home/amp-local/src/automation/helios/dist/server/worker/pricing/litAlertsMarket.js'
import { NormalizedCatalogGroupLiveStateSchema } from '/home/amp-local/src/automation/helios/dist/server/worker/catalog/liveState.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(HERE, 'data.json')
const AUTOMATION_ROOT = resolve(HERE, '../../..')

// Bronx site dealer + the 9 brands the campaign covers.
const BRONX_DEALER_ID = 210249
const STATE_DEALER_ID = 210248
const CAMPAIGN_ID = '13035'
const ACTION_ID = '45102'
const BRAND_IDS = [
  { id: 15391, name: 'Doobie Labs' },
  { id: 11912, name: 'Herb' },
  { id: 16409, name: 'Jungle Girl' },
  { id: 14295, name: 'Moonlit Hash Co' },
  { id: 16596, name: 'Preferred Gardens' },
  { id: 14294, name: 'Purps' },
  { id: 16411, name: 'Runtz' },
  { id: 14289, name: 'Smartbud' },
  { id: 16412, name: 'Strain Gang' },
]

const NY_POST_TAX_MULTIPLIER = 1.13

function readDatabaseUrl() {
  const databaseUrl = process.env.HELIOS_READONLY_DATABASE_URL
    ? process.env.HELIOS_READONLY_DATABASE_URL
    : readFileSync(
        process.env.HELIOS_READONLY_DATABASE_URL_FILE ??
          `${process.env.HOME}/.secret/tigerdata/helios-readonly-url`,
        'utf8',
      ).trim()
  const parsed = new URL(databaseUrl)
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    decodeURIComponent(parsed.username) !== 'helios_agent_readonly' ||
    decodeURIComponent(parsed.pathname) !== '/tsdb' ||
    !parsed.hostname ||
    !parsed.password ||
    /\s/.test(databaseUrl)
  ) {
    throw new Error('The read-only URL must authenticate as helios_agent_readonly against /tsdb')
  }
  return databaseUrl
}

/**
 * Drive the Sweed RPC API from a small inline Python helper that
 * already wraps the API URL + auth token. Returns a JSON-parsed
 * payload: { products: [...], productsByGroupId: {...} }.
 */
function loadSweedCatalogFacts() {
  const py = `
import json, sys
sys.path.insert(0, "${AUTOMATION_ROOT}/bulk_additions/2026-04-10")
import apply_product_catalog_attribute_updates as sweed

STATE = ${STATE_DEALER_ID}
BRONX = ${BRONX_DEALER_ID}
BRAND_IDS = ${JSON.stringify(BRAND_IDS.map((b) => b.id))}

# 1. Enumerate all groups + products for the 9 brands at STATE.
sweed.api_call("store.auth.dealer.set", {"dealerId": STATE})
products = []
for bid in BRAND_IDS:
    grp = sweed.api_call("store.product.group.list", {"page": 1, "pageSize": 1000, "brandId": bid})
    for g in grp.get("data") or []:
        full = sweed.api_call("store.product.group.get", {"id": g["id"]})
        for p in full.get("products") or []:
            products.append({
                "productId": int(p["id"]),
                "name": p.get("name"),
                "shortName": p.get("shortName"),
                "tab": p.get("tab"),
                "groupId": int(full["id"]),
                "groupName": full.get("name"),
                "brandId": (full.get("brand") or {}).get("id"),
                "brandName": (full.get("brand") or {}).get("name"),
                "categoryId": (full.get("category") or {}).get("id"),
                "categoryName": (full.get("category") or {}).get("name"),
                "subcategoryId": (full.get("subcategory") or {}).get("id"),
                "subcategoryName": (full.get("subcategory") or {}).get("name"),
                "imageUrl": (((p.get("images") or [{}])[0]) or {}).get("url") or ((full.get("images") or [{}])[0] or {}).get("url"),
                "size": p.get("size"),
                "wholesaleCost": p.get("wholesaleCost"),
                "globalPrice": p.get("price"),
                "displayInEcommerce": p.get("displayInEcommerce"),
                "status": p.get("status"),
            })

# 2. Switch to BRONX and pull each product's site-context priceInfo + actualPrice
sweed.api_call("store.auth.dealer.set", {"dealerId": BRONX})
for p in products:
    try:
        live = sweed.api_call("store.product.get", {"id": str(p["productId"])})["product"]
    except Exception as e:
        p["localPriceError"] = str(e)
        continue
    pi = live.get("priceInfo") or {}
    p["bronxLocalPrice"] = live.get("price")
    p["bronxActualPrice"] = pi.get("actualPrice")
    p["bronxIsStorePrice"] = pi.get("isStorePrice")
    if live.get("wholesaleCost") is not None:
        p["wholesaleCost"] = live.get("wholesaleCost")
    if pi.get("globalPrice") is not None:
        p["globalPrice"] = pi.get("globalPrice")

print(json.dumps({"products": products}, default=str))
`
  const r = spawnSync('python3', ['-c', py], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) {
    throw new Error(`Sweed catalog fetch failed: ${r.stderr}`)
  }
  return JSON.parse(r.stdout)
}

async function main() {
  console.log('Pulling live Sweed catalog facts for the 9 1Off brands at Bronx...')
  const sweed = loadSweedCatalogFacts()
  const products = sweed.products
  console.log(`  ${products.length} products across ${new Set(products.map((p) => p.groupId)).size} groups.`)

  const pool = new pg.Pool({ connectionString: readDatabaseUrl(), max: 4 })
  try {
    // Find the catalog_groups row for each unique groupId.
    const productIds = products.map((p) => p.productId)
    const groupRowByGroupId = new Map()
    const productIdToGroupRowId = new Map()
    {
      const result = await pool.query(
        `select cg.id, cg.group_name, cg.brand_name, cg.category_name, cg.live_state_json,
                (cg.live_state_json -> 'products') as products_json
         from catalog_groups cg
         where cg.live_state_json -> 'products' ?| $1::text[]`,
        [productIds.map(String)],
      )
      // Above '?|' looks for any of the productId keys - but live_state_json's
      // products is an array of {productId,...} objects, so '?|' won't match.
      // Fall back to a per-product lookup.
      void result
    }
    for (const product of products) {
      const r = await pool.query(
        `select id, group_name, brand_name, category_name, live_state_json
         from catalog_groups
         where (live_state_json -> 'products') @> $1::jsonb
         limit 1`,
        [JSON.stringify([{ productId: product.productId }])],
      )
      const row = r.rows[0]
      if (row) {
        groupRowByGroupId.set(row.id, row)
        productIdToGroupRowId.set(product.productId, row.id)
      }
    }
    console.log(`  ${groupRowByGroupId.size} catalog_groups rows resolved (out of ${new Set(products.map((p) => p.groupId)).size} Sweed groups).`)

    // Refresh competitor data live for each catalog_group via the
    // helios partner-API pipeline.
    const evidenceByProductId = new Map()
    const refreshNotesByGroupId = new Map()
    const failuresByGroupId = new Map()
    let i = 0
    for (const [groupRowId, row] of groupRowByGroupId) {
      i += 1
      const label = `${row.brand_name ?? '?'} / ${row.group_name ?? '?'}`
      console.log(`  [${i}/${groupRowByGroupId.size}] live refresh: ${label}`)
      let liveState
      try {
        liveState = NormalizedCatalogGroupLiveStateSchema.parse(row.live_state_json)
      } catch (error) {
        failuresByGroupId.set(groupRowId, `liveState parse failed: ${error.message}`)
        continue
      }
      let ctx
      try {
        ctx = await buildPricingMarketContext(liveState)
      } catch (error) {
        failuresByGroupId.set(groupRowId, `buildPricingMarketContext threw: ${error.message}`)
        continue
      }
      refreshNotesByGroupId.set(groupRowId, {
        availability: ctx.availability,
        note: ctx.note ?? null,
        searchTerm: ctx.searchTerm ?? null,
      })
      for (const [productIdStr, evidence] of Object.entries(ctx.productEvidenceById ?? {})) {
        evidenceByProductId.set(Number(productIdStr), evidence)
      }
    }

    // Stitch evidence + refresh notes onto each product record.
    const refreshedAt = new Date().toISOString()
    const enrichedProducts = products.map((product) => {
      const groupRowId = productIdToGroupRowId.get(product.productId)
      const refreshNote = groupRowId ? refreshNotesByGroupId.get(groupRowId) : null
      const failure = groupRowId ? failuresByGroupId.get(groupRowId) : null
      const evidence = evidenceByProductId.get(product.productId)
      const matchedListings = evidence?.matchedListings ?? []
      const pricingEligibleListings = matchedListings.filter((l) => l.eligibleForPricing !== false)
      return {
        ...product,
        market: {
          refreshedAt,
          status: failure ? 'error' : refreshNote?.availability ?? (groupRowId ? 'no_data' : 'no_catalog_group'),
          searchTerm: refreshNote?.searchTerm ?? null,
          note: refreshNote?.note ?? null,
          error: failure ?? null,
          averagePostTaxPrice: evidence?.averagePostTaxPrice ?? null,
          medianPostTaxPrice: evidence?.medianPostTaxPrice ?? null,
          listingCount: matchedListings.length,
          pricingEligibleListingCount: pricingEligibleListings.length,
          matchedListings: matchedListings.map((listing, index) => ({
            id: `${product.productId}:${index}`,
            dispensaryName: listing.dispensaryName ?? null,
            listingName: listing.listingName ?? null,
            url: listing.url ?? null,
            preTaxPrice: listing.preTaxPrice ?? null,
            postTaxPrice: listing.postTaxPrice ?? null,
            distanceMiles: listing.distanceMiles ?? null,
            distanceBand: listing.distanceBand ?? null,
            source: listing.source ?? null,
            availability: listing.availability ?? null,
            eligibleForPricing: listing.eligibleForPricing !== false,
            sizeLabel: listing.sizeLabel ?? null,
          })),
        },
      }
    })

    const out = {
      generatedAt: refreshedAt,
      bronxDealerId: BRONX_DEALER_ID,
      stateDealerId: STATE_DEALER_ID,
      campaignId: CAMPAIGN_ID,
      actionId: ACTION_ID,
      campaignName: '1Off',
      actionName: '1Off Brands 20% Off',
      currentPromoDiscountPercent: 20.0,
      postTaxMultiplier: NY_POST_TAX_MULTIPLIER,
      brands: BRAND_IDS,
      products: enrichedProducts,
    }
    await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n')

    const productsWithListings = enrichedProducts.filter((p) => (p.market?.listingCount ?? 0) > 0).length
    const totalListings = enrichedProducts.reduce((sum, p) => sum + (p.market?.listingCount ?? 0), 0)
    console.log(`\nWrote ${OUT_PATH}`)
    console.log(`  products: ${enrichedProducts.length}`)
    console.log(`  with competitor listings: ${productsWithListings}`)
    console.log(`  total listings across products: ${totalListings}`)
    if (failuresByGroupId.size > 0) {
      console.log(`  group-level failures: ${failuresByGroupId.size}`)
      for (const [gid, msg] of failuresByGroupId) {
        const row = groupRowByGroupId.get(gid)
        console.log(`    ${row?.brand_name}/${row?.group_name}: ${msg}`)
      }
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
