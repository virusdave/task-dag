// Pure helpers for the SEO image-asset control plane (P4 remainder) —
// image-asset id minting, the content-addressed approval fingerprint, and
// the sanitized-host compliance heuristic for the operator-authored,
// publicly-visible metadata (alt text). No I/O, so these are exhaustively
// unit-tested and reused by the route, the queries layer, and the DB→bundle
// asset loader.
//
// This is the direct analog of postContent.ts (P4) / faqContent.ts (P3):
// the IRONCLAD human-approval gate (canon §1) binds an approval to the EXACT
// image identity + metadata fingerprint, any edit recomputes it and resets
// the row to draft, and the sanitized host (FB.us) can never be left with a
// non-compliant alt text. Images are approved INDEPENDENTLY of any post
// (parent EPIC_PLAN §0.3) — a post may publish image-less, and an image is
// approved on its own merits and can later be referenced by a post.
//
// parent EPIC_PLAN §0.3/§6.2/§7 · child FreshlyBakedNYC/automation#44 (P4) ·
// Satisfies: virusdave/top-level#15

import { createHash, randomBytes } from 'node:crypto'

import { RAW_ONLY_TERMS } from './faqContent.js'

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

export const IMAGE_ASSET_ID_RE =
  /^img_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/

/** Mint a fresh, sortable image-asset id `img_YYYY-MM-DD_HHMMSS_<6hex>`. */
export function newImageAssetId(now: Date = new Date()): string {
  return mintStructuredId('img', now)
}

// A hex sha256 (the content address of the underlying image bytes; the
// actual bytes are hosted by the renderer / object store, not by Helios —
// Helios owns the metadata + approval).
export const SHA256_RE = /^[0-9a-f]{64}$/

export type ImageRole = 'hero' | 'og' | 'derivative'
export const IMAGE_ROLES: readonly ImageRole[] = ['hero', 'og', 'derivative']

// ── content fingerprint ───────────────────────────────────────────────

/**
 * The operator-authored, publicly-meaningful identity + metadata of an SEO
 * image asset. `asset_sha256` is the content address of the image bytes
 * (provided by the operator / generation pipeline); `alt_text` is visible,
 * shared across BOTH hosts, and so must be sanitized-safe; `role` /
 * `media_type` / dimensions describe how the asset is used in the bundle.
 */
export interface ImageAssetContentInput {
  readonly asset_id: string
  readonly asset_sha256: string
  readonly role: ImageRole
  readonly media_type: string
  readonly width: number | null
  readonly height: number | null
  readonly alt_text: string
}

/**
 * Canonical, versioned payload a `content_sha256` is computed over. It
 * includes the control-plane identity (`asset_id`) + the content address of
 * the bytes (`asset_sha256`) + every operator-authored, publicly-meaningful
 * metadata field, and EXCLUDES everything assigned at approval/publish time:
 * status, source, generation metadata, timestamps, the reviewer, user ids,
 * and the `approval_id` itself. Built with an explicit fixed field order so
 * the hash is stable regardless of JSONB key ordering.
 */
export function imageAssetCanonicalPayload(input: ImageAssetContentInput): string {
  const canonical = {
    schema: 'freshlybaked.seo.image-asset-approval.v1',
    content_kind: 'image',
    asset_id: input.asset_id,
    asset_sha256: input.asset_sha256,
    role: input.role,
    media_type: input.media_type,
    width: input.width ?? null,
    height: input.height ?? null,
    alt_text: input.alt_text,
  }
  return JSON.stringify(canonical)
}

/** Hex sha256 over the canonical image-asset payload. */
export function imageAssetContentSha256(input: ImageAssetContentInput): string {
  return createHash('sha256').update(imageAssetCanonicalPayload(input), 'utf8').digest('hex')
}

// ── sanitized-host compliance heuristic ───────────────────────────────
//
// Reuses the conservative raw-only cannabis-term denylist from
// faqContent.ts (`RAW_ONLY_TERMS`). `alt_text` renders on BOTH hosts
// (it's the accessible text + an OG/structured-data signal), so it must be
// free of raw-only terms exactly like the post's shared fields.

function findRawOnlyLeaksLower(lower: string): string[] {
  const hits = new Set<string>()
  for (const term of RAW_ONLY_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
    if (re.test(lower)) {
      hits.add(term)
    }
  }
  return [...hits]
}

/** Distinct raw-only terms in `text` (case-insensitive, whole-token). */
export function findImageRawOnlyLeaks(text: string): string[] {
  return findRawOnlyLeaksLower(text.toLowerCase())
}

export type ImageAssetField =
  | 'asset_sha256'
  | 'role'
  | 'media_type'
  | 'width'
  | 'height'
  | 'alt_text'

export interface ImageAssetComplianceProblem {
  readonly field: ImageAssetField
  readonly message: string
}

/**
 * Validate an image asset for APPROVAL. Checks structural completeness (a
 * well-formed content address, an `image/*` media type, a role, non-empty
 * alt text, positive dimensions when present) and the sanitized-host
 * compliance heuristic (no raw-only terms in the alt text). Returns the
 * list of problems; empty = approvable.
 */
export function checkImageAssetApprovable(
  input: ImageAssetContentInput,
): ImageAssetComplianceProblem[] {
  const problems: ImageAssetComplianceProblem[] = []
  const sha = input.asset_sha256?.trim() ?? ''
  const mediaType = input.media_type?.trim() ?? ''
  const altText = input.alt_text?.trim() ?? ''

  if (sha.length === 0) {
    problems.push({ field: 'asset_sha256', message: 'Image content hash (sha256) is empty.' })
  } else if (!SHA256_RE.test(sha)) {
    problems.push({
      field: 'asset_sha256',
      message: 'Image content hash must be a 64-char lowercase hex sha256.',
    })
  }

  if (!IMAGE_ROLES.includes(input.role)) {
    problems.push({
      field: 'role',
      message: `Role must be one of ${IMAGE_ROLES.join(', ')}.`,
    })
  }

  if (mediaType.length === 0) {
    problems.push({ field: 'media_type', message: 'Media type is empty.' })
  } else if (!/^image\/[a-z0-9.+-]+$/i.test(mediaType)) {
    problems.push({
      field: 'media_type',
      message: `Media type '${mediaType}' must be an image/* MIME type.`,
    })
  }

  if (input.width !== null && (!Number.isInteger(input.width) || input.width < 1)) {
    problems.push({ field: 'width', message: 'Width must be a positive integer when set.' })
  }
  if (input.height !== null && (!Number.isInteger(input.height) || input.height < 1)) {
    problems.push({ field: 'height', message: 'Height must be a positive integer when set.' })
  }

  if (altText.length === 0) {
    problems.push({ field: 'alt_text', message: 'Alt text is empty (required for a11y + SEO).' })
  } else {
    const leaks = findImageRawOnlyLeaks(altText)
    if (leaks.length > 0) {
      problems.push({
        field: 'alt_text',
        message: `Contains raw-only term(s) that would leak onto the sanitized host: ${leaks.join(', ')}.`,
      })
    }
  }

  return problems
}
