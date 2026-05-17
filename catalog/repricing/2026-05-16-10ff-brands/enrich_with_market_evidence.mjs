#!/usr/bin/env node
/**
 * Enrich the reprice proposal with live competitor menu listings via the
 * canonical Helios `buildPricingMarketContext()` worker module, so the
 * canonical pricing-ladder UI in the review packet can render the
 * competitor diamonds (not just the live/proposed markers).
 *
 * Strategy: re-normalize the live Sweed group detail through the
 * canonical `normalizeCatalogGroupDetail()` (the same path the catalog
 * mirror takes) instead of round-tripping through the Helios DB, since
 * TigerData is firewalled from this host's egress IPs. Then feed that
 * NormalizedCatalogGroupLiveState into the canonical
 * `buildPricingMarketContext()`, which talks to Lit Alerts using the
 * legacy brands-console bearer at `~/.secret/litalerts/bearer-token`.
 *
 * Writes `proposal_with_evidence.json` next to this script. Does NOT
 * mutate the original dry-run proposal artefacts.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  buildPricingMarketContext,
} from '../../../helios/dist/server/worker/pricing/litAlertsMarket.js'
import {
  normalizeCatalogGroupDetail,
} from '../../../helios/dist/server/worker/catalog/liveState.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROPOSAL_PATH = resolve(HERE, 'reprice_proposal_dryrun.json')
const OUT_PATH = resolve(HERE, 'proposal_with_evidence.json')

const SWEED_API_URL = 'https://prime.sweedpos.com/api/'
const SWEED_AUTH_TOKEN = '74a71554-e0ef-4fe6-bdc0-d02ad68db483'
const STATE_DEALER_ID = 210248

function randomId() {
  return crypto.randomUUID()
}

async function sweedCall(name, params = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(SWEED_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'amp/reprice-enrichment' },
      body: JSON.stringify({ auth: SWEED_AUTH_TOKEN, name, params, id: randomId() }),
    })
    if (response.ok) {
      const body = await response.json()
      if (body.error) {
        throw new Error(`${name} failed: ${JSON.stringify(body.error)}`)
      }
      if (!('result' in body)) {
        throw new Error(`${name} returned unexpected payload`)
      }
      return body.result
    }
    if (![403, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
      throw new Error(`${name} HTTP ${response.status}`)
    }
    await new Promise((r) => setTimeout(r, 1000 + attempt * 1000))
  }
  throw new Error(`${name} exceeded retry budget`)
}

async function ensureStateContext() {
  await sweedCall('store.auth.dealer.set', { dealerId: STATE_DEALER_ID })
}

async function main() {
  const proposal = JSON.parse(await readFile(PROPOSAL_PATH, 'utf8'))

  await ensureStateContext()

  const enriched = {
    ...proposal,
    enrichedAt: new Date().toISOString(),
    groups: [],
  }

  let groupIndex = 0
  const totalGroups = proposal.groups.length
  for (const group of proposal.groups) {
    groupIndex += 1
    let availability = 'unknown'
    let searchTerm = null
    let note = null
    let productEvidenceById = {}
    let liveState = null

    try {
      const detail = await sweedCall('store.product.group.get', { id: group.groupId })
      liveState = normalizeCatalogGroupDetail(detail)
    } catch (error) {
      note = `Failed to fetch/normalize group ${group.groupId}: ${error.message}`
      availability = 'error'
    }

    if (liveState) {
      try {
        const marketContext = await buildPricingMarketContext(liveState)
        availability = marketContext.availability
        searchTerm = marketContext.searchTerm
        note = marketContext.note
        productEvidenceById = marketContext.productEvidenceById ?? {}
      } catch (fetchError) {
        availability = 'error'
        note = `buildPricingMarketContext failed: ${fetchError.message}`
      }
    }

    const enrichedProducts = group.products.map((product) => {
      const evidence = productEvidenceById[product.productId] ?? null
      return { ...product, marketEvidence: evidence }
    })

    const listingCount = Object.values(productEvidenceById).reduce(
      (sum, ev) => sum + (ev?.matchedListings?.length ?? 0),
      0,
    )
    console.log(
      `[${groupIndex}/${totalGroups}] ${group.brandName} / ${group.groupName} (sweed=${group.groupId}) ` +
      `→ ${availability} · listings=${listingCount}` +
      (note ? ` · ${note.slice(0, 90)}` : ''),
    )

    enriched.groups.push({
      ...group,
      marketAvailability: availability,
      marketSearchTerm: searchTerm,
      marketNote: note,
      products: enrichedProducts,
    })
  }

  await writeFile(OUT_PATH, JSON.stringify(enriched, null, 2) + '\n')
  console.log(`\nWrote ${OUT_PATH}`)

  // Summary
  let totalListings = 0
  let groupsWithListings = 0
  let productsWithListings = 0
  let productsTotal = 0
  for (const group of enriched.groups) {
    let listingsHere = 0
    for (const product of group.products) {
      productsTotal += 1
      const n = product.marketEvidence?.matchedListings?.length ?? 0
      if (n > 0) productsWithListings += 1
      listingsHere += n
    }
    if (listingsHere > 0) groupsWithListings += 1
    totalListings += listingsHere
  }
  console.log(
    `\nSUMMARY: ${totalListings} total competitor listings across ` +
    `${productsWithListings}/${productsTotal} products in ` +
    `${groupsWithListings}/${enriched.groups.length} groups.`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
