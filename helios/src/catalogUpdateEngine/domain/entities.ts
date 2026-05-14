/**
 * Core entity types and hierarchical references for the Catalog Update Engine.
 *
 * These types provide a unified way to reference catalog entities across
 * different triggers (purchases, repricing, promos, etc.) and outputs.
 */

export type CatalogEntityType =
  | 'catalog_group' // existing catalog_groups table
  | 'catalog_item' // individual SKU / product
  | 'brand'
  | 'site'
  | 'promo'
  | 'category'
  | 'subcategory'

export interface SiteRef {
  siteId: number
  dealerId: number
}

export interface CatalogHierarchyRef {
  site: SiteRef
  catalogId: number
  brandId?: number | null
  itemId?: number | null // SKU or catalog item id
}

export interface MSOBrandAnnotation {
  msoBrandId?: number | null
  isMSOBrand?: boolean
  isHouseBrand?: boolean
  notes?: string | null
}

export interface CatalogTargetRef {
  entityType: CatalogEntityType
  // DB-level identity (e.g. catalog_group_id, sku_id, brand_id, etc.)
  entityId: number | null
  // Logical / external identity that helps group triggers (e.g. Sweed group)
  externalKey?: {
    provider: 'sweed' | 'metrc' | 'leaflink' | 'manual'
    id: string | number
  }
  hierarchy: CatalogHierarchyRef
  msoAnnotation?: MSOBrandAnnotation
}

/**
 * Pricing ladder entry for stepped pricing based on quantity.
 */
export interface PricingLadderEntry {
  minQty: number
  maxQty?: number | null
  retailPrice: number
  wholesaleCost?: number | null
  gmPercent?: number | null
}

/**
 * Complete pricing ladder for a product.
 */
export interface PricingLadder {
  entries: PricingLadderEntry[]
}
