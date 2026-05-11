/**
 * Per-SKU competitor enrichment for the slow-mover packet.
 *
 * For every product in every candidate group:
 *   1. resolve the SKU's brand to a Lit Alerts manufacturer id
 *   2. derive a search term from the product name
 *   3. fetch nearby listings (within 10 mi); if the name search is empty,
 *      retry with a brand-only nearby search
 *   4. tier-accumulate by distance band (near, then near+mid, then
 *      near+mid+far); only consult statewide when fewer than
 *      SUFFICIENCY_THRESHOLD listings have been collected
 *   5. cap the working set at MAX_LISTINGS_PER_SKU using a price-spread
 *      preserving sample within each tier
 *   6. build the canonical ladder geometry consumed by render.ts
 *
 * Every SKU in the candidate groups gets enriched; there is no per-group
 * cap. Bound on total work comes from the per-SKU listing cap and the
 * tier short-circuit only.
 */
import {
  buildLadderGeometry,
  type CompetitorListingInput,
  type LadderGeometry,
} from '../../../../../helios/src/shared/ui/pricing-ladder/index.js'

import {
  type CompetitorListing,
  type LitAlertsConfig,
  listMenuListings,
  loadLitAlertsConfig,
  resolveBrandId,
} from './litalerts.js'
import type { GroupRollup, ProductRollup } from './aggregate.js'

/** Hard cap on competitor listings per SKU (post-band-accumulation). */
const MAX_LISTINGS_PER_SKU = 18
/** Stop expanding to wider bands once we have at least this many. */
const SUFFICIENCY_THRESHOLD = 12
/**
 * Bounded concurrency for per-SKU enrichment. Lit Alerts comfortably
 * handles 8 concurrent /Products/menulistings calls per our prior
 * standalone packet runs; we stay well below that.
 */
const ENRICH_CONCURRENCY = 6

export interface ProductMarketData {
  ladder: LadderGeometry
  competitorListings: CompetitorListing[]
  unavailableReason: string | null
  searchTerm: string | null
  brandId: number | null
}

export interface EnrichResult {
  used: boolean
  note: string
  byProductId: Map<number, ProductMarketData>
}

export interface EnrichOptions {
  enabled: boolean
  /** Optional logger (defaults to console.log with [enrich] prefix). */
  log?: (line: string) => void
}

export async function enrichGroupsWithCompetitors(
  groups: GroupRollup[],
  options: EnrichOptions,
): Promise<EnrichResult> {
  const log = options.log ?? ((line: string) => console.log(`[enrich] ${line}`))
  const byProductId = new Map<number, ProductMarketData>()

  if (!options.enabled) {
    return { used: false, note: 'disabled', byProductId }
  }
  const config = loadLitAlertsConfig()
  if (!config) {
    return {
      used: false,
      note: 'Lit Alerts bearer token not configured (set LITALERTS_BEARER_TOKEN or place at /Users/amp-local/.secret/litalerts/bearer-token)',
      byProductId,
    }
  }

  // Resolve unique brand names once to avoid re-hitting the manufacturer
  // directory; the directory call itself is cached inside litalerts.ts.
  const brandIdByName = await resolveBrandIdsForGroups(groups, config, log)

  // Enrich every distinct SKU across all candidate groups.
  const skus = collectAllSkus(groups)
  log(
    `enriching ${skus.length} SKU(s) across ${groups.length} group(s) (concurrency=${ENRICH_CONCURRENCY}; no per-group cap; ${brandIdByName.size} brand(s) mapped)`,
  )

  let completed = 0
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const myIndex = nextIndex
      nextIndex += 1
      if (myIndex >= skus.length) return
      const product = skus[myIndex]
      if (byProductId.has(product.productId)) {
        completed += 1
        continue
      }
      const data = await enrichOneProduct(product, brandIdByName, config, log)
      byProductId.set(product.productId, data)
      completed += 1
      if (completed % 10 === 0 || completed === skus.length) {
        log(`  ${completed}/${skus.length} enriched`)
      }
    }
  }
  const workerCount = Math.min(ENRICH_CONCURRENCY, Math.max(1, skus.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return {
    used: true,
    note: `Lit Alerts ${config.apiUrl} (${skus.length} SKUs, all candidate-group products)`,
    byProductId,
  }
}

async function resolveBrandIdsForGroups(
  groups: GroupRollup[],
  config: LitAlertsConfig,
  log: (line: string) => void,
): Promise<Map<string, number | null>> {
  const distinct = new Set<string>()
  for (const group of groups) {
    for (const product of group.products) {
      if (product.brand && product.brand.toLowerCase() !== 'unbranded') {
        distinct.add(product.brand)
      }
    }
  }
  const out = new Map<string, number | null>()
  for (const name of distinct) {
    const id = await resolveBrandId(config, name)
    out.set(name, id)
  }
  const matched = [...out.values()].filter((v) => v !== null).length
  log(`brand-id resolution: ${matched}/${distinct.size} matched`)
  return out
}

function collectAllSkus(groups: GroupRollup[]): ProductRollup[] {
  const seen = new Set<number>()
  const out: ProductRollup[] = []
  for (const group of groups) {
    for (const product of group.products) {
      if (seen.has(product.productId)) continue
      seen.add(product.productId)
      out.push(product)
    }
  }
  return out
}

async function enrichOneProduct(
  product: ProductRollup,
  brandIdByName: Map<string, number | null>,
  config: LitAlertsConfig,
  log: (line: string) => void,
): Promise<ProductMarketData> {
  const brandId = product.brand ? brandIdByName.get(product.brand) ?? null : null
  if (brandId === null) {
    return {
      ladder: buildLadderGeometry({
        productId: product.productId,
        livePrice: product.retailPrice,
        proposedPrice: null,
        marketAveragePostTax: null,
        marketMedianPostTax: null,
        competitorListings: [],
      }),
      competitorListings: [],
      unavailableReason: product.brand
        ? `No Lit Alerts manufacturer match for brand "${product.brand}".`
        : 'Product has no brand on file.',
      searchTerm: null,
      brandId: null,
    }
  }

  const searchTerm = deriveSearchTerm(product.productName)

  // Step 1: name-based nearby search (within 10mi).
  let nameMatchedNearby = await listMenuListings(config, {
    brandId,
    searchTerm,
    scope: 'nearby',
  })

  // Step 2: brand-only nearby fallback when the name search returns
  // nothing (the brand+nearby+Sweed-side category signal is strong enough
  // that no client-side category filter is added).
  let nearbyAll = nameMatchedNearby
  if (nameMatchedNearby.length === 0 && searchTerm) {
    nearbyAll = await listMenuListings(config, {
      brandId,
      searchTerm: '',
      scope: 'nearby',
    })
  }

  // Step 3: tier accumulation by distance band.
  const buckets = bucketByBand(nearbyAll)
  const working: CompetitorListing[] = []
  const stop = (): boolean => working.length >= SUFFICIENCY_THRESHOLD
  working.push(...buckets.near)
  if (!stop()) working.push(...buckets.mid)
  if (!stop()) working.push(...buckets.far)

  // Step 4: only fetch statewide ("very far") if we still don't have
  // enough comps after near+mid+far.
  if (!stop()) {
    const statewide = await listMenuListings(config, {
      brandId,
      searchTerm: searchTerm || '',
      scope: 'statewide',
    })
    const veryFar = bucketByBand(statewide).veryFar.filter(
      (listing) => !alreadySeen(working, listing),
    )
    working.push(...veryFar)
  }

  // Step 5: cap to MAX_LISTINGS_PER_SKU with price-spread-preserving sample.
  const capped = capListings(working, MAX_LISTINGS_PER_SKU)

  const ladderInput = capped.map<CompetitorListingInput>((listing) => ({
    listingId: `${listing.listingId}:${listing.dispensaryName ?? ''}:${listing.prePrice}`,
    postTaxPrice: listing.postPrice,
    distanceMiles: listing.distanceMiles,
    dispensaryName: listing.dispensaryName,
    dispensaryAddress: listing.dispensaryAddress,
    listingName: listing.productName,
    url: listing.url,
    eligibleForPricing: true,
  }))

  const ladder = buildLadderGeometry({
    productId: product.productId,
    livePrice: product.retailPrice,
    proposedPrice: null,
    marketAveragePostTax: averageOrNull(capped.map((l) => l.postPrice)),
    marketMedianPostTax: medianOrNull(capped.map((l) => l.postPrice)),
    competitorListings: ladderInput,
  })

  return {
    ladder,
    competitorListings: capped,
    unavailableReason:
      capped.length === 0
        ? `No Lit Alerts listings found for brand id ${brandId} (tried name "${searchTerm}", broad-by-brand, and statewide).`
        : null,
    searchTerm,
    brandId,
  }
}

interface BandBuckets {
  near: CompetitorListing[]
  mid: CompetitorListing[]
  far: CompetitorListing[]
  veryFar: CompetitorListing[]
  unknown: CompetitorListing[]
}

function bucketByBand(listings: CompetitorListing[]): BandBuckets {
  const buckets: BandBuckets = { near: [], mid: [], far: [], veryFar: [], unknown: [] }
  for (const listing of listings) {
    switch (listing.distanceBand) {
      case 'near':
        buckets.near.push(listing)
        break
      case 'mid':
        buckets.mid.push(listing)
        break
      case 'far':
        buckets.far.push(listing)
        break
      case 'very_far':
        buckets.veryFar.push(listing)
        break
      default:
        buckets.unknown.push(listing)
    }
  }
  for (const key of Object.keys(buckets) as Array<keyof BandBuckets>) {
    buckets[key].sort((a, b) => a.postPrice - b.postPrice)
  }
  return buckets
}

function alreadySeen(working: CompetitorListing[], listing: CompetitorListing): boolean {
  const key = `${listing.listingId}:${listing.prePrice}:${listing.dispensaryName ?? ''}`
  return working.some(
    (existing) =>
      `${existing.listingId}:${existing.prePrice}:${existing.dispensaryName ?? ''}` === key,
  )
}

function capListings(listings: CompetitorListing[], cap: number): CompetitorListing[] {
  if (listings.length <= cap) return listings
  const buckets = bucketByBand(listings)
  const tiers: CompetitorListing[][] = [
    buckets.near,
    buckets.mid,
    buckets.far,
    buckets.veryFar,
    buckets.unknown,
  ]
  const out: CompetitorListing[] = []
  for (const tier of tiers) {
    if (out.length >= cap) break
    const remaining = cap - out.length
    if (tier.length <= remaining) {
      out.push(...tier)
    } else {
      out.push(...evenSample(tier, remaining))
    }
  }
  return out
}

function evenSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  const out: T[] = []
  const step = (items.length - 1) / (n - 1)
  for (let i = 0; i < n; i += 1) {
    out.push(items[Math.round(i * step)])
  }
  return out
}

function averageOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Best-effort search term derivation. Strips weight/size suffixes ("3.5g",
 * "1g", "2pk", "100mg"), trims punctuation, collapses whitespace.
 */
function deriveSearchTerm(productName: string): string {
  if (!productName) return ''
  return productName
    .replace(/\b\d+(\.\d+)?\s*(g|gm|gram|grams|mg|oz|pk|pack|count|ct)\b/gi, ' ')
    .replace(/[\(\)\[\]\{\}|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
