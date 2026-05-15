/**
 * Change field definitions and line item structures for the Catalog Update Engine.
 *
 * These types represent proposed changes to catalog entities, supporting
 * multiple change types (pricing, promos, taxonomy, attributes) through a
 * unified field_path + JSON approach.
 */

import type { ValidationIssue } from '../../shared/contracts/domain/proposals.js'
import type { CatalogTargetRef, PricingLadder } from './entities.js'

export type CatalogChangeFieldGroup =
  | 'pricing'
  | 'promo'
  | 'taxonomy'
  | 'attributes'
  | 'mso_brand'
  | 'maintenance'
  | 'correction'

export interface CatalogChangeFieldPath {
  /**
   * Machine-usable path – maps to proposal_line_items.field_path.
   * Examples:
   *   'pricing.basePrice'
   *   'pricing.ladder'
   *   'pricing.ladder[0].retail'
   *   'promo.bogo'
   *   'taxonomy.category'
   *   'attributes.thcPercent'
   *   'msoBrand.msoBrandId'
   */
  path: string
  group: CatalogChangeFieldGroup
  displayLabel: string
  valueType: 'string' | 'number' | 'boolean' | 'price' | 'json' | 'pricingLadder'
}

/**
 * Draft line item for a proposed change, before persistence.
 */
export interface CatalogChangeLineItemDraft {
  target: CatalogTargetRef
  field: CatalogChangeFieldPath
  baselineValue: unknown // what's currently in catalog / snapshot
  suggestedValue: unknown // proposed by trigger or ML or operator
  // UI / workflow fields
  validationIssues?: ValidationIssue[]
  notes?: string | null
  // Additional context / evidence for reviewer
  merchandisingContext?: Record<string, unknown> // e.g. competitors, size tier
  evidence?: Record<string, unknown> // invoices, market data, etc.
}

/**
 * Persisted line item with approval workflow state.
 */
export interface CatalogChangeLineItemPersisted extends CatalogChangeLineItemDraft {
  id: number
  approvalStatus: 'pending' | 'approved' | 'rejected'
  version: number
  editedValue?: unknown
  effectiveValue: unknown
}

/**
 * Field descriptor registry - defines all supported field paths.
 */
export const CATALOG_FIELD_REGISTRY: Record<string, CatalogChangeFieldPath> = {
  'pricing.basePrice': {
    path: 'pricing.basePrice',
    group: 'pricing',
    displayLabel: 'Base Price',
    valueType: 'price',
  },
  'pricing.ladder': {
    path: 'pricing.ladder',
    group: 'pricing',
    displayLabel: 'Pricing Ladder',
    valueType: 'pricingLadder',
  },
  'promo.bogo': {
    path: 'promo.bogo',
    group: 'promo',
    displayLabel: 'BOGO Promotion',
    valueType: 'json',
  },
  'promo.discount': {
    path: 'promo.discount',
    group: 'promo',
    displayLabel: 'Discount Promotion',
    valueType: 'json',
  },
  'taxonomy.category': {
    path: 'taxonomy.category',
    group: 'taxonomy',
    displayLabel: 'Category',
    valueType: 'string',
  },
  'taxonomy.subcategory': {
    path: 'taxonomy.subcategory',
    group: 'taxonomy',
    displayLabel: 'Subcategory',
    valueType: 'string',
  },
  'taxonomy.strain': {
    path: 'taxonomy.strain',
    group: 'taxonomy',
    displayLabel: 'Strain',
    valueType: 'string',
  },
  'attributes.thcPercent': {
    path: 'attributes.thcPercent',
    group: 'attributes',
    displayLabel: 'THC %',
    valueType: 'number',
  },
  'attributes.cbdPercent': {
    path: 'attributes.cbdPercent',
    group: 'attributes',
    displayLabel: 'CBD %',
    valueType: 'number',
  },
  'attributes.description': {
    path: 'attributes.description',
    group: 'attributes',
    displayLabel: 'Description',
    valueType: 'string',
  },
  'msoBrand.msoBrandId': {
    path: 'msoBrand.msoBrandId',
    group: 'mso_brand',
    displayLabel: 'MSO Brand ID',
    valueType: 'number',
  },
  'msoBrand.isMSOBrand': {
    path: 'msoBrand.isMSOBrand',
    group: 'mso_brand',
    displayLabel: 'Is MSO Brand',
    valueType: 'boolean',
  },
  'msoBrand.isHouseBrand': {
    path: 'msoBrand.isHouseBrand',
    group: 'mso_brand',
    displayLabel: 'Is House Brand',
    valueType: 'boolean',
  },
}

/**
 * Get field descriptor from registry, ensuring it exists.
 */
export function getFieldDescriptor(path: string): CatalogChangeFieldPath {
  const descriptor = CATALOG_FIELD_REGISTRY[path]
  if (!descriptor) {
    throw new Error(`Unknown field path: ${path}. Register it in CATALOG_FIELD_REGISTRY.`)
  }
  return descriptor
}

/**
 * Validate that a field path exists in the registry.
 */
export function isValidFieldPath(path: string): boolean {
  return path in CATALOG_FIELD_REGISTRY
}
