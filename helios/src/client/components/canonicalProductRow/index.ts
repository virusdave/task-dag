// Issue #35 (slice 5) — shared canonical-product-row module.
//
// `/catalog/review` (ReviewPage.tsx) was the first surface to render
// the canonical row contract (issue #15). This module is the durable
// home for that row + its sub-components, extracted verbatim from
// ReviewPage so the next reviewer surface that needs the same
// before/after comparator + pricing ladder + decision bar — currently
// `/catalog/pending-purchases`, and later /catalog/repricing,
// /catalog/market-data, /catalog/promos — can import from one place
// instead of forking the implementation.
//
// Public surface kept minimal: the row card itself + the formatters
// the row uses for any caller (currency, tooltip / preview truncation,
// rollup-tone). Sub-components stay encapsulated; if a caller needs
// a comparison panel or pricing ladder block in isolation we can
// promote them then.
export { CanonicalProductRow } from './CanonicalProductRow.js'
export {
  formatCurrency,
  rollupTone,
  truncateForTooltip,
  truncatePreview,
} from './formatters.js'
