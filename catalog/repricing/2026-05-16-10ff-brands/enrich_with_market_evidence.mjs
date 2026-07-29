#!/usr/bin/env node
/**
 * Enrich the reprice proposal with whatever competitor menu listings
 * Helios already has cached in `litalerts_competitor_observations`,
 * so the canonical pricing-ladder UI in the review packet can draw the
 * diamonds.
 *
 * For each proposal product:
 *   1. Pull the most recent `succeeded` row from
 *      `litalerts_competitor_observations`.
 *   2. Use the `evidence_json` (which already has the
 *      `matchedListings[]` shape the canonical ladder consumes — name,
 *      url, distanceMiles, postTaxPrice, dispensaryName, etc.).
 *   3. Annotate stale rows so the review caller can warn about them.
 *
 * Does NOT attempt to live-refresh — that requires the still-to-be-
 * built partner-API + geocoding sweep system (see task-dag for "B").
 * Live-refresh through the legacy `buildPricingMarketContext()` is
 * blocked: the brands-console bearer at
 * `~/.secret/litalerts/bearer-token` has expired and its Cognito
 * refresh token has been revoked.
 *
 * Writes `proposal_with_evidence.json` next to this script. Read-only
 * against TigerData; no live network calls.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

import pg from '../../../helios/node_modules/pg/lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROPOSAL_PATH = resolve(HERE, 'reprice_proposal_dryrun.json')
const OUT_PATH = resolve(HERE, 'proposal_with_evidence.json')

// 3 days per the proposed sweep policy: anything older is considered
// stale enough to warrant a fresh refresh.
const STALENESS_DAYS = 3

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

async function main() {
  const proposal = JSON.parse(await readFile(PROPOSAL_PATH, 'utf8'))

  const pool = new pg.Pool({ connectionString: readDatabaseUrl(), max: 4 })

  const allProductIds = []
  for (const group of proposal.groups) {
    for (const product of group.products) {
      allProductIds.push(product.productId)
    }
  }

  console.log(`Looking up cached observations for ${allProductIds.length} products...`)

  // One query: most-recent succeeded observation per product.
  const observationsResult = await pool.query(
    `select distinct on (product_id)
       product_id, brand_name, group_name, category_name,
       availability, listing_count, near_listing_count,
       mid_listing_count, far_listing_count,
       evidence_json, captured_at, search_term_label, notes
     from litalerts_competitor_observations
     where product_id = ANY($1::int[]) and status = 'succeeded'
     order by product_id, captured_at desc`,
    [allProductIds],
  )
  const observationByProductId = new Map()
  for (const row of observationsResult.rows) {
    // pg returns bigint as string by default; normalize to number to match
    // the integer productId in the proposal JSON.
    observationByProductId.set(Number(row.product_id), row)
  }

  console.log(
    `Found cached observations for ${observationByProductId.size}/${allProductIds.length} products.`,
  )

  const now = new Date()
  const enriched = {
    ...proposal,
    enrichedAt: now.toISOString(),
    enrichmentSource: 'helios.litalerts_competitor_observations (cached)',
    enrichmentStalenessThresholdDays: STALENESS_DAYS,
    groups: [],
  }

  let groupsWithEvidence = 0
  let productsWithEvidence = 0
  let productsTotal = 0
  let totalListings = 0
  let staleProducts = 0
  let veryStaleProducts = 0

  for (const group of proposal.groups) {
    const enrichedProducts = group.products.map((product) => {
      productsTotal += 1
      const observation = observationByProductId.get(product.productId)
      if (!observation) {
        return { ...product, marketEvidence: null, marketCacheStatus: 'absent' }
      }

      const evidence = observation.evidence_json ?? {}
      const matchedListings = Array.isArray(evidence.matchedListings)
        ? evidence.matchedListings
        : []
      const capturedAt = new Date(observation.captured_at)
      const ageMs = now.getTime() - capturedAt.getTime()
      const ageDays = ageMs / 86_400_000
      const isStale = ageDays > STALENESS_DAYS
      const isVeryStale = ageDays > STALENESS_DAYS * 2
      if (isStale) staleProducts += 1
      if (isVeryStale) veryStaleProducts += 1
      if (matchedListings.length > 0) {
        productsWithEvidence += 1
        totalListings += matchedListings.length
      }

      return {
        ...product,
        marketEvidence: {
          matchedListings,
          averagePostTaxPrice: evidence.averagePostTaxPrice ?? null,
          medianPostTaxPrice: evidence.medianPostTaxPrice ?? null,
          listingCount: evidence.listingCount ?? matchedListings.length,
          pricingEligibleListingCount:
            evidence.pricingEligibleListingCount ?? matchedListings.filter((l) => l.eligibleForPricing).length,
          searchTerm: evidence.searchTerm ?? observation.search_term_label,
          source: evidence.source ?? null,
        },
        marketCacheStatus: isStale
          ? (isVeryStale ? 'very_stale' : 'stale')
          : 'fresh',
        marketCacheCapturedAt: observation.captured_at,
        marketCacheAgeDays: Math.round(ageDays * 10) / 10,
        marketAvailability: observation.availability,
        marketSearchTerm: observation.search_term_label,
        marketNote: observation.notes,
      }
    })

    const groupHasEvidence = enrichedProducts.some(
      (p) => (p.marketEvidence?.matchedListings?.length ?? 0) > 0,
    )
    if (groupHasEvidence) groupsWithEvidence += 1

    enriched.groups.push({ ...group, products: enrichedProducts })
  }

  await writeFile(OUT_PATH, JSON.stringify(enriched, null, 2) + '\n')
  await pool.end()

  console.log(`\nSUMMARY:`)
  console.log(
    `  Products with cached competitor listings: ${productsWithEvidence}/${productsTotal}`,
  )
  console.log(
    `  Total competitor listings across all products: ${totalListings}`,
  )
  console.log(
    `  Groups with at least one product with evidence: ${groupsWithEvidence}/${proposal.groups.length}`,
  )
  console.log(`  Stale (>${STALENESS_DAYS}d): ${staleProducts}`)
  console.log(`  Very stale (>${STALENESS_DAYS * 2}d): ${veryStaleProducts}`)
  console.log(`\nWrote ${OUT_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
