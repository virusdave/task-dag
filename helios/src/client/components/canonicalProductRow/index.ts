// Issue #35 (slice 4b.1) — shared canonical-product-row module.
//
// Reviewer surfaces (`/catalog/review`, `/catalog/pending-purchases`,
// and later /catalog/repricing, /catalog/market-data, /catalog/promos)
// render a common "live → proposed" canonical product row with status
// pills, comparisons, a pricing-ladder block, an overrides panel and a
// decision bar. This module provides the model-agnostic layout shell
// that holds those pieces in a consistent layout, plus the shared
// helpers (formatters, structured-overrides field + helpers) the
// surfaces all need.
//
// The shell itself takes primitive / slot props (title, statusPills,
// comparisons cells, slots for pricingLadder / overrides / decisions
// / bodyExtras / footer). Each calling surface adapts its own row
// schema at the boundary instead of being forced through a single
// shared row type.
export {
  CanonicalProductRow,
  type CanonicalProductRowComparisonCell,
  type CanonicalProductRowProps,
  type CanonicalProductRowValidationIssue,
} from './CanonicalProductRow.js'
export {
  formatCurrency,
  rollupTone,
  truncateForTooltip,
  truncatePreview,
} from './formatters.js'
export {
  STRUCTURED_OVERRIDE_KEYS,
  StructuredOverrideField,
  areStructuredOverridesEqual,
  buildStructuredOverridePayload,
  effectiveStructured,
  effectiveStructuredPackCount,
  hasStructuredOverride,
  readInitialDraftStructured,
  readParsedStructuredValue,
  type ParsedStructuredValues,
  type StructuredOverrideDraft,
  type StructuredOverrideKey,
  type StructuredOverrideStringKey,
} from './structuredOverrides.js'
