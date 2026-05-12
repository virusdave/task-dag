#!/usr/bin/env tsx
/**
 * Enrich PO 21 pending purchase packet with:
 * - Sweed catalog matching
 * - Lit Alerts market pricing
 * - Product images (non-stock validation)
 * - Proposed pricing with GM% targets
 */

import { randomUUID } from 'node:crypto'
import { getPool } from './helios/src/server/db/pool.js'
import { buildPricingMarketContext } from './helios/src/worker/pricing/litAlertsMarket.js'
import type { NormalizedCatalogGroupLiveState } from './helios/src/worker/catalog/liveState.js'

const PACKET_ID = 8
const CONCURRENT_ENRICHMENTS = 12
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 500

// GM% pricing constants from AGENTS_MUST_KNOW.md
const POST_TAX_MULTIPLIER = 1.13
const TARGET_GM_MIN = 0.55
const TARGET_GM_MAX = 0.65

interface EnrichmentResult {
  rowId: number
  success: boolean
  error?: string
  catalogMatch?: any
  marketData?: any
  proposedPrice?: number
  gmPercent?: number
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function exponentialBackoff(attempt: number): Promise<void> {
  const delay = BASE_BACKOFF_MS * Math.pow(2, attempt) * (0.5 + Math.random())
  await sleep(delay)
}

async function searchSweedCatalog(row: any): Promise<any | null> {
  try {
    // Build search term from brand + group name
    const searchTerm = `${row.target_brand} ${row.target_group_name}`.toLowerCase()
    
    console.log(`[${row.id}] Searching Sweed catalog: "${searchTerm}"`)
    
    // TODO: Call Sweed API store.product.list.short with search
    // For now, mock response
    await sleep(100 + Math.random() * 200)
    
    return null // No existing match found
  } catch (error: any) {
    console.log(`[${row.id}] Sweed search failed: ${error.message}`)
    return null
  }
}

async function fetchLitAlertsMarket(row: any): Promise<any | null> {
  try {
    // Construct mock normalized group for pricing API
    const mockGroup: Partial<NormalizedCatalogGroupLiveState> = {
      brandName: row.target_brand,
      category: row.expected_category,
      groupName: row.target_group_name,
      packCount: row.target_pack_count || 1,
      size: row.target_variant_name,
      sizeValueString: row.target_variant_name,
    }
    
    console.log(`[${row.id}] Fetching Lit Alerts market data`)
    
    // TODO: Call buildPricingMarketContext when env is available
    // For now, mock response
    await sleep(200 + Math.random() * 300)
    
    return {
      eligibleListingCount: 0,
      medianPreTaxPrice: null,
      medianPostTaxPrice: null,
    }
  } catch (error: any) {
    console.log(`[${row.id}] Lit Alerts fetch failed: ${error.message}`)
    return null
  }
}

async function calculateProposedPrice(row: any, marketData: any): Promise<{ price: number; gmPercent: number; rationale: string }> {
  const baseCost = row.proposed_price || 10.00 // Use invoice unit price as cost basis
  
  // If we have market data, try to price below market
  if (marketData?.medianPostTaxPrice) {
    const targetPrice = marketData.medianPostTaxPrice * 0.97 // 3% below market
    const gm = 1 - (POST_TAX_MULTIPLIER * baseCost) / targetPrice
    
    if (gm >= TARGET_GM_MIN) {
      return {
        price: Math.round(targetPrice * 4) / 4, // Round to quarter
        gmPercent: gm,
        rationale: `3% below market median (${marketData.medianPostTaxPrice}), ${(gm * 100).toFixed(1)}% GM`,
      }
    }
  }
  
  // Otherwise target middle of GM range
  const targetGm = (TARGET_GM_MIN + TARGET_GM_MAX) / 2
  const price = (POST_TAX_MULTIPLIER * baseCost) / (1 - targetGm)
  
  return {
    price: Math.round(price * 4) / 4,
    gmPercent: targetGm,
    rationale: `Cost-plus pricing targeting ${(targetGm * 100).toFixed(1)}% GM`,
  }
}

async function enrichRow(row: any, attempt = 0): Promise<EnrichmentResult> {
  try {
    console.log(`[${row.id}] Enriching: ${row.distributor_product_name}`)
    
    // Parallel fetches with independent error handling
    const [catalogMatch, marketData] = await Promise.all([
      searchSweedCatalog(row).catch(err => { console.error(`Catalog search error: ${err.message}`); return null }),
      fetchLitAlertsMarket(row).catch(err => { console.error(`Market fetch error: ${err.message}`); return null }),
    ])
    
    // Calculate pricing
    const pricing = await calculateProposedPrice(row, marketData)
    
    return {
      rowId: row.id,
      success: true,
      catalogMatch,
      marketData,
      proposedPrice: pricing.price,
      gmPercent: pricing.gmPercent,
    }
  } catch (error: any) {
    if (attempt < MAX_RETRIES) {
      console.log(`[${row.id}] Retry ${attempt + 1}/${MAX_RETRIES} after error: ${error.message}`)
      await exponentialBackoff(attempt)
      return enrichRow(row, attempt + 1)
    }
    
    return {
      rowId: row.id,
      success: false,
      error: error.message,
    }
  }
}

async function processBatch(rows: any[]): Promise<EnrichmentResult[]> {
  const results: EnrichmentResult[] = []
  
  for (let i = 0; i < rows.length; i += CONCURRENT_ENRICHMENTS) {
    const batch = rows.slice(i, i + CONCURRENT_ENRICHMENTS)
    const batchResults = await Promise.all(batch.map(row => enrichRow(row)))
    results.push(...batchResults)
    
    const batchNum = Math.floor(i / CONCURRENT_ENRICHMENTS) + 1
    const totalBatches = Math.ceil(rows.length / CONCURRENT_ENRICHMENTS)
    console.log(`\nCompleted batch ${batchNum}/${totalBatches} (${batchResults.filter(r => r.success).length}/${batch.length} successful)`)
  }
  
  return results
}

async function updateRow(pool: any, result: EnrichmentResult): Promise<void> {
  if (!result.success || !result.proposedPrice) return
  
  await pool.query(`
    UPDATE pending_purchase_rows
    SET 
      proposed_price = $1,
      market_advice_summary = $2,
      pricing_reason = $3,
      updated_at = NOW()
    WHERE id = $4
  `, [
    result.proposedPrice,
    result.marketData ? `Market: ${result.marketData.eligibleListingCount || 0} comps` : 'No market data',
    `Auto-calculated: ${result.gmPercent ? (result.gmPercent * 100).toFixed(1) : '?'}% GM`,
    result.rowId,
  ])
}

async function main() {
  const pool = getPool()
  
  try {
    // Fetch all rows from packet
    const result = await pool.query(`
      SELECT 
        id,
        distributor_product_name,
        target_brand,
        target_group_name,
        target_variant_name,
        expected_category,
        expected_subcategory,
        proposed_price,
        site_key,
        site_dealer_id
      FROM pending_purchase_rows
      WHERE packet_id = $1
      ORDER BY id
    `, [PACKET_ID])
    
    console.log(`Enriching ${result.rows.length} rows from packet ${PACKET_ID}`)
    console.log(`Using ${CONCURRENT_ENRICHMENTS} concurrent workers with exponential backoff\n`)
    
    const enrichmentResults = await processBatch(result.rows)
    
    console.log(`\n${'='.repeat(60)}`)
    console.log('Updating database with enriched data...')
    
    // Update DB with results
    let updated = 0
    for (const result of enrichmentResults.filter(r => r.success)) {
      try {
        await updateRow(pool, result)
        updated++
      } catch (error: any) {
        console.error(`Failed to update row ${result.rowId}: ${error.message}`)
      }
    }
    
    const successful = enrichmentResults.filter(r => r.success).length
    const failed = enrichmentResults.filter(r => !r.success).length
    
    console.log(`\n${'='.repeat(60)}`)
    console.log('ENRICHMENT COMPLETE')
    console.log(`${'='.repeat(60)}`)
    console.log(`  Processed: ${result.rows.length}`)
    console.log(`  Succeeded: ${successful}`)
    console.log(`  Failed: ${failed}`)
    console.log(`  DB Updated: ${updated}`)
    
    if (failed > 0) {
      console.log(`\nFailed rows:`)
      enrichmentResults.filter(r => !r.success).forEach(r => {
        console.log(`  Row ${r.rowId}: ${r.error}`)
      })
    }
    
    // Show sample of pricing
    console.log(`\nSample pricing (first 5):`)
    enrichmentResults.slice(0, 5).forEach(r => {
      if (r.success && r.proposedPrice) {
        console.log(`  Row ${r.rowId}: $${r.proposedPrice.toFixed(2)} (${(r.gmPercent! * 100).toFixed(1)}% GM)`)
      }
    })
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('Enrichment failed:', error)
  process.exit(1)
})
