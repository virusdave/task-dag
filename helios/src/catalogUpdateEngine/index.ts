/**
 * Unified Catalog Update Engine - Main exports
 *
 * This module provides a single, modular system for handling all types of catalog
 * maintenance operations (purchases, repricing, promos, taxonomy, attributes).
 */

// Domain types
export type {
  CatalogEntityType,
  SiteRef,
  CatalogHierarchyRef,
  MSOBrandAnnotation,
  CatalogTargetRef,
  PricingLadderEntry,
  PricingLadder,
} from './domain/entities.js'

export type {
  CatalogChangeFieldGroup,
  CatalogChangeFieldPath,
  CatalogChangeLineItemDraft,
  CatalogChangeLineItemPersisted,
} from './domain/changes.js'

export {
  CATALOG_FIELD_REGISTRY,
  getFieldDescriptor,
  isValidFieldPath,
} from './domain/changes.js'

export type {
  CatalogUpdateTriggerType,
  CatalogUpdateBatchType,
  CatalogUpdateBatchDraft,
  CatalogProposalRowDraft,
  CatalogUpdateBatchPersisted,
} from './domain/proposals.js'

// Core service
export {
  CatalogUpdateEngine,
  type CreateBatchResult,
  type ApplyBatchResult,
} from './service/CatalogUpdateEngine.js'

// Input adapters
export type {
  CatalogUpdateTriggerContext,
  CatalogUpdateInputAdapter,
} from './input/CatalogUpdateInputAdapter.js'

export {
  PurchasesInputAdapter,
  type PurchaseMetric,
  type PurchasesTriggerPayload,
} from './input/PurchasesInputAdapter.js'

// Output adapters
export type {
  ApplyContext,
  CatalogChangeOutputAdapter,
} from './output/CatalogChangeOutputAdapter.js'

export { PricingOutputAdapter } from './output/PricingOutputAdapter.js'
