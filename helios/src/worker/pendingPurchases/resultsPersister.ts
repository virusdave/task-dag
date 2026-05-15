/**
 * Results Persister for Pending Purchases
 * Saves enriched proposal data to database
 */

import type { Pool } from 'pg'
import type { ParsedTaxonomy } from './skuParser.js'
import type { PricingOutput } from './pricingCalculator.js'

export interface EnrichedRow {
  packetId: number
  rowIndex: number
  siteKey: string
  siteDealerId: number
  orderId: string
  positionId: string
  distributorProductName: string
  
  // Parsed taxonomy
  parsedTaxonomy: ParsedTaxonomy
  
  // Pricing
  costPerUnit: number
  pricing: PricingOutput
  
  // Market research
  marketAvgPrice?: number
  competitorListings?: unknown[]
  evidenceTier?: 'exact' | 'categorical' | 'none'
  
  // Catalog matching
  matchedProductId?: number
  matchedGroupId?: number
  createProduct: boolean
  createGroup: boolean
  
  // Enrichment
  primaryImageUrl?: string
  metrcTag?: string
  
  // Flags
  reviewFlags: string[]
}

/**
 * Persist enriched row to pending_purchase_rows table
 */
export async function persistEnrichedRow(pool: Pool, row: EnrichedRow): Promise<number> {
  const result = await pool.query<{ row_id: number }>(
    `INSERT INTO pending_purchase_rows (
      packet_id, row_index, site_key, site_dealer_id, order_id, position_id,
      distributor_product_name,
      parsed_brand, parsed_category, parsed_subcategory, parsed_variant_name,
      parsed_strain_name, parsed_pack_size, parsed_pack_count,
      cost_per_unit, proposed_retail_price, gm_percent,
      market_avg_price, competitor_listings, evidence_tier,
      matched_product_id, matched_group_id, create_product, create_group,
      primary_image_url, metrc_tag, distributor_sku,
      review_flags, mapping_status, approval_status, apply_status
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31
    ) RETURNING row_id`,
    [
      row.packetId,
      row.rowIndex,
      row.siteKey,
      row.siteDealerId,
      row.orderId,
      row.positionId,
      row.distributorProductName,
      row.parsedTaxonomy.brand,
      row.parsedTaxonomy.category,
      row.parsedTaxonomy.subcategory,
      row.parsedTaxonomy.variantName,
      row.parsedTaxonomy.strainName,
      row.parsedTaxonomy.packSize,
      row.parsedTaxonomy.packCount,
      row.costPerUnit,
      row.pricing.proposedRetailPrice,
      row.pricing.gmPercent,
      row.marketAvgPrice,
      row.competitorListings ? JSON.stringify(row.competitorListings) : null,
      row.evidenceTier,
      row.matchedProductId,
      row.matchedGroupId,
      row.createProduct,
      row.createGroup,
      row.primaryImageUrl,
      row.metrcTag,
      row.parsedTaxonomy.distributorSku,
      row.reviewFlags.concat(row.pricing.reviewFlags),
      row.createProduct ? 'needs_catalog_create' : row.matchedProductId ? 'mapped_variant_ready_for_link' : 'needs_review',
      'pending',
      'not_requested',
    ]
  )
  
  return result.rows[0].row_id
}

/**
 * Persist entire packet with all enriched rows
 */
export async function persistPacket(
  pool: Pool,
  packetTitle: string,
  siteKeys: string[],
  siteLabels: string[],
  rows: EnrichedRow[]
): Promise<number> {
  // Create packet
  const packetResult = await pool.query<{ packet_id: number }>(
    `INSERT INTO pending_purchase_packets (
      packet_title, source, status, site_keys, site_labels, generated_at, summary
    ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
    RETURNING packet_id`,
    [
      packetTitle,
      'generated',
      'ready',
      siteKeys,
      siteLabels,
      JSON.stringify({
        rowCount: rows.length,
        totalCost: rows.reduce((sum, r) => sum + r.costPerUnit, 0),
        totalProposedRevenue: rows.reduce((sum, r) => sum + r.pricing.proposedRetailPrice, 0),
      }),
    ]
  )
  
  const packetId = packetResult.rows[0].packet_id
  
  // Persist all rows
  for (const row of rows) {
    await persistEnrichedRow(pool, { ...row, packetId })
  }
  
  return packetId
}
