// Issue #35 (slice 5) — canonical-product-row formatting helpers.
//
// Extracted verbatim from /catalog/review's ReviewPage.tsx so every
// surface that renders the canonical row formats money, tooltips,
// previews, and rollup pills identically. Behavior unchanged.
import type { ReviewRow } from '../../../shared/contracts/index.js'

export function rollupTone(rollup: ReviewRow['approvalRollup']): 'danger' | 'muted' | 'success' | 'warning' {
  switch (rollup) {
    case 'approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'mixed':
      return 'warning'
    case 'pending':
    default:
      return 'warning'
  }
}

export function formatCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `$${value.toFixed(2)}`
}

export function truncateForTooltip(text: string): string {
  if (text.length <= 400) return text
  return `${text.slice(0, 400).trimEnd()}…`
}

export function truncatePreview(text: string): string {
  if (text.length <= 110) return text
  return `${text.slice(0, 110).trimEnd()}…`
}
