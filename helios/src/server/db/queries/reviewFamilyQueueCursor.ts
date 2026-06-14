/**
 * Keyset cursor for the family-grouped review queue (Phase A, top-level#16).
 *
 * The cursor is an opaque base64url-encoded JSON token handed back to the
 * client in `pageInfo.endCursor`; the client never inspects it. It pins
 * the keyset boundary (the last family emitted, in SQL/keyset order) plus
 * the filter state it was generated under, so a cursor cannot silently
 * leak rows across a filter change. `familyKeyVersion` lets Phase B change
 * family-key semantics (adding `sizeName`) while still rejecting — rather
 * than mis-paging — in-flight v1 cursors.
 *
 * This is integrity-by-validation, not encryption: there is nothing
 * secret in a cursor, but a malformed/foreign cursor is rejected.
 */
import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  REVIEW_FAMILY_KEY_VERSION,
  type ReviewFamilyQueueQuery,
} from '../../../shared/contracts/index.js'

export const ReviewFamilyQueueCursorSchema = z.object({
  v: z.literal(1),
  familyKeyVersion: z.literal(REVIEW_FAMILY_KEY_VERSION),
  hasDrift: z.boolean(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  filtersHash: z.string(),
})
export type ReviewFamilyQueueCursor = z.infer<typeof ReviewFamilyQueueCursorSchema>

export class InvalidReviewCursorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidReviewCursorError'
  }
}

/**
 * Hash the filter state that defines a queue ordering. `limit` and
 * `cursor` are excluded: paging deeper/shallower with the same filters
 * must keep the same cursor lineage.
 */
export function hashReviewFilters(filters: ReviewFamilyQueueQuery): string {
  const normalized = {
    approvalStatus: filters.approvalStatus ?? 'pending',
    proposalType: filters.proposalType ?? null,
    driftOnly: Boolean(filters.driftOnly),
    search: filters.search ?? null,
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('base64url').slice(0, 16)
}

export function encodeReviewCursor(input: {
  hasDrift: boolean
  brand: string | null
  category: string | null
  subcategory: string | null
  filters: ReviewFamilyQueueQuery
}): string {
  const payload: ReviewFamilyQueueCursor = {
    v: 1,
    familyKeyVersion: REVIEW_FAMILY_KEY_VERSION,
    hasDrift: input.hasDrift,
    brand: input.brand,
    category: input.category,
    subcategory: input.subcategory,
    filtersHash: hashReviewFilters(input.filters),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode + validate a cursor against the current filters. Throws
 * `InvalidReviewCursorError` on any malformed token, unknown version, or
 * filter mismatch so the route can answer `400` rather than mis-page.
 */
export function decodeReviewCursor(
  cursor: string,
  filters: ReviewFamilyQueueQuery,
): ReviewFamilyQueueCursor {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidReviewCursorError('Malformed review queue cursor.')
  }

  const result = ReviewFamilyQueueCursorSchema.safeParse(parsedJson)
  if (!result.success) {
    throw new InvalidReviewCursorError('Unrecognized review queue cursor.')
  }

  if (result.data.filtersHash !== hashReviewFilters(filters)) {
    throw new InvalidReviewCursorError('Cursor does not match the current filters.')
  }

  return result.data
}
