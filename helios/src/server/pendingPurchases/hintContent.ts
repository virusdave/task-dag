// Pure helpers for the prospective pending-purchase classifier's HINT BUNDLE
// storage (child FreshlyBakedNYC/automation#54, task C2) — id minting, the
// per-bundle dedup fingerprint, and the one canonical text normalization. No
// I/O, so these are unit-tested and reused by the queries layer + routes.
//
// Satisfies: virusdave/top-level#33

import { createHash, randomBytes } from 'node:crypto'

// ── id minting ────────────────────────────────────────────────────────

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function mintStructuredId(prefix: string, now: Date): string {
  const y = pad(now.getUTCFullYear(), 4)
  const mo = pad(now.getUTCMonth() + 1, 2)
  const d = pad(now.getUTCDate(), 2)
  const h = pad(now.getUTCHours(), 2)
  const mi = pad(now.getUTCMinutes(), 2)
  const s = pad(now.getUTCSeconds(), 2)
  const suffix = randomBytes(3).toString('hex')
  return `${prefix}_${y}-${mo}-${d}_${h}${mi}${s}_${suffix}`
}

export const HINT_BUNDLE_ID_RE =
  /^pphint_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/
export const HINT_DOCUMENT_ID_RE =
  /^pphdoc_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/

/** Mint a fresh, sortable hint-bundle id `pphint_YYYY-MM-DD_HHMMSS_<6hex>`. */
export function newHintBundleId(now: Date = new Date()): string {
  return mintStructuredId('pphint', now)
}

/** Mint a fresh, sortable hint-document id `pphdoc_YYYY-MM-DD_HHMMSS_<6hex>`. */
export function newHintDocumentId(now: Date = new Date()): string {
  return mintStructuredId('pphdoc', now)
}

// ── taxonomy ──────────────────────────────────────────────────────────

// How the operator says a document helps (decision 2). DB-mirrored by the
// pending_purchase_hint_documents_kind_check constraint + the
// PendingPurchaseHintDocumentKindSchema enum.
export const HINT_DOCUMENT_KINDS = [
  'distributor_menu',
  'sibling_purchase_order',
  'operator_note',
  'other',
] as const
export type HintDocumentKind = (typeof HINT_DOCUMENT_KINDS)[number]

export const HINT_BUNDLE_STATUSES = ['active', 'archived'] as const
export type HintBundleStatus = (typeof HINT_BUNDLE_STATUSES)[number]

export const HINT_EXTRACTION_STATUSES = ['pending', 'extracted', 'failed', 'skipped'] as const
export type HintExtractionStatus = (typeof HINT_EXTRACTION_STATUSES)[number]

// ── normalization + dedup fingerprint ─────────────────────────────────

/**
 * The single canonical normalization applied to pasted hint text before it
 * is stored AND before the dedup hash is computed. Deliberately minimal:
 * normalize CRLF/CR → LF and trim leading/trailing whitespace, but DO NOT
 * collapse internal whitespace — menus / POs can be column-aligned and that
 * layout is meaningful to the extractor (C3).
 */
export function normalizeHintText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim()
}

/**
 * Per-bundle dedup key over the normalized text. Re-pasting identical text
 * into the same bundle hashes to the same value, so the
 * unique(bundle_id, content_sha256) constraint makes it an idempotent no-op.
 */
export function hintDocumentContentSha256(normalizedText: string): string {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex')
}
