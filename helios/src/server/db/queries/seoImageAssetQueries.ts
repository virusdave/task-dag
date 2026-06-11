// Query layer for the SEO image-asset control plane (migration 074).
//
// Helios-driven SEO widgets — auto-blog MVP, INDEPENDENT image approval
// (parent EPIC_PLAN §0.3, child FreshlyBakedNYC/automation#44, P4,
// Satisfies: virusdave/top-level#15).
//
// Backs the /api/seo/image-assets routes and the approved-asset bundle
// loader. The approve path is the IRONCLAD human-approval gate (canon §1):
// it runs under a row lock, re-checks the fingerprint the reviewer saw,
// writes an append-only ledger row, stamps the reviewer, and binds the
// asset to that approval. Any edit recomputes the fingerprint and resets
// the asset to `draft`.

import type { PoolClient } from 'pg'

import type {
  SeoImageAssetRecord,
  SeoImageAssetSource,
  SeoImageRole,
} from '../../../shared/contracts/index.js'
import { newSeoApprovalId } from '../../seo/faqContent.js'
import {
  checkImageAssetApprovable,
  imageAssetContentSha256,
  newImageAssetId,
  type ImageAssetContentInput,
} from '../../seo/imageContent.js'
import type { Queryable } from '../pool.js'
import { withTransaction } from '../tx.js'

interface SeoImageAssetRow {
  asset_id: string
  asset_sha256: string
  role: string
  media_type: string
  width: number | string | null
  height: number | string | null
  alt_text: string
  status: string
  source: string
  content_sha256: string
  approval_id: string | null
  reviewer: string | null
  generation_meta: unknown
  created_by_user_id: string | number | null
  updated_by_user_id: string | number | null
  created_at: Date | string
  updated_at: Date | string
  // from the seo_approvals join
  approved_by_user_id: string | number | null
  approved_at: Date | string | null
  approval_note: string | null
}

const SELECT_ASSET = `
  select
    i.asset_id,
    i.asset_sha256,
    i.role,
    i.media_type,
    i.width,
    i.height,
    i.alt_text,
    i.status,
    i.source,
    i.content_sha256,
    i.approval_id,
    i.reviewer,
    i.generation_meta,
    i.created_by_user_id,
    i.updated_by_user_id,
    i.created_at,
    i.updated_at,
    a.approved_by_user_id,
    a.approved_at,
    a.note as approval_note
  from seo_image_assets i
  left join seo_approvals a on a.approval_id = i.approval_id
`

const RETURNING_ASSET = `
  returning
    asset_id, asset_sha256, role, media_type, width, height, alt_text, status,
    source, content_sha256, approval_id, reviewer, generation_meta,
    created_by_user_id, updated_by_user_id, created_at, updated_at,
    null::bigint as approved_by_user_id, null::timestamptz as approved_at,
    null::text as approval_note
`

function toIsoString(value: Date | string | null): string | null {
  if (value === null) {
    return null
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) {
    return null
  }
  return typeof value === 'number' ? value : Number.parseInt(value, 10)
}

function dimensionOrNull(value: number | string | null): number | null {
  if (value === null) {
    return null
  }
  return typeof value === 'number' ? value : Number.parseInt(value, 10)
}

function rowToContentInput(row: {
  asset_id: string
  asset_sha256: string
  role: string
  media_type: string
  width: number | string | null
  height: number | string | null
  alt_text: string
}): ImageAssetContentInput {
  return {
    asset_id: row.asset_id,
    asset_sha256: row.asset_sha256,
    role: row.role as SeoImageRole,
    media_type: row.media_type,
    width: dimensionOrNull(row.width),
    height: dimensionOrNull(row.height),
    alt_text: row.alt_text,
  }
}

function mapRow(row: SeoImageAssetRow): SeoImageAssetRecord {
  return {
    assetId: row.asset_id,
    assetSha256: row.asset_sha256,
    role: row.role as SeoImageRole,
    mediaType: row.media_type,
    width: dimensionOrNull(row.width),
    height: dimensionOrNull(row.height),
    altText: row.alt_text,
    status: row.status as SeoImageAssetRecord['status'],
    source: row.source as SeoImageAssetSource,
    contentSha256: row.content_sha256,
    approvalId: row.approval_id,
    reviewer: row.reviewer,
    approvedByUserId: toNumberOrNull(row.approved_by_user_id),
    approvedAt: toIsoString(row.approved_at),
    approvalNote: row.approval_note,
    generationMeta: row.generation_meta ?? null,
    createdByUserId: toNumberOrNull(row.created_by_user_id),
    updatedByUserId: toNumberOrNull(row.updated_by_user_id),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  }
}

export interface ImageAssetContentFields {
  readonly assetSha256: string
  readonly role: SeoImageRole
  readonly mediaType: string
  readonly width: number | null
  readonly height: number | null
  readonly altText: string
}

function contentInput(assetId: string, c: ImageAssetContentFields): ImageAssetContentInput {
  return {
    asset_id: assetId,
    asset_sha256: c.assetSha256,
    role: c.role,
    media_type: c.mediaType,
    width: c.width,
    height: c.height,
    alt_text: c.altText,
  }
}

export async function listSeoImageAssets(db: Queryable): Promise<SeoImageAssetRecord[]> {
  const result = await db.query<SeoImageAssetRow>(`${SELECT_ASSET} order by i.updated_at desc`)
  return result.rows.map(mapRow)
}

export async function getSeoImageAsset(
  db: Queryable,
  assetId: string,
): Promise<SeoImageAssetRecord | null> {
  const result = await db.query<SeoImageAssetRow>(`${SELECT_ASSET} where i.asset_id = $1`, [assetId])
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export interface CreateSeoImageAssetInput extends ImageAssetContentFields {
  readonly source?: SeoImageAssetSource
  readonly generationMeta?: unknown
  readonly userId: number
  readonly now?: Date
}

export async function createSeoImageAsset(
  db: Queryable,
  input: CreateSeoImageAssetInput,
): Promise<SeoImageAssetRecord> {
  const now = input.now ?? new Date()
  const assetId = newImageAssetId(now)
  const contentSha256 = imageAssetContentSha256(contentInput(assetId, input))
  const result = await db.query<SeoImageAssetRow>(
    `
      insert into seo_image_assets (
        asset_id, asset_sha256, role, media_type, width, height, alt_text,
        status, source, generation_meta, content_sha256, approval_id, reviewer,
        created_by_user_id, updated_by_user_id
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        'draft', $8, $9::jsonb, $10, null, null,
        $11, $11
      )
      ${RETURNING_ASSET}
    `,
    [
      assetId,
      input.assetSha256,
      input.role,
      input.mediaType,
      input.width,
      input.height,
      input.altText,
      input.source ?? 'manual',
      input.generationMeta === undefined ? null : JSON.stringify(input.generationMeta),
      contentSha256,
      input.userId,
    ],
  )
  return mapRow(result.rows[0]!)
}

export interface UpdateSeoImageAssetInput extends ImageAssetContentFields {
  readonly userId: number
}

/**
 * Replace an asset's metadata. Always resets the asset to `draft` and clears
 * its approval + reviewer (so an approval can never silently cover edited
 * metadata) and recomputes the fingerprint. Returns null if not found.
 */
export async function updateSeoImageAsset(
  db: Queryable,
  assetId: string,
  input: UpdateSeoImageAssetInput,
): Promise<SeoImageAssetRecord | null> {
  const contentSha256 = imageAssetContentSha256(contentInput(assetId, input))
  const result = await db.query<SeoImageAssetRow>(
    `
      update seo_image_assets
         set asset_sha256 = $2,
             role = $3,
             media_type = $4,
             width = $5,
             height = $6,
             alt_text = $7,
             content_sha256 = $8,
             status = 'draft',
             approval_id = null,
             reviewer = null,
             updated_by_user_id = $9,
             updated_at = now()
       where asset_id = $1
      ${RETURNING_ASSET}
    `,
    [
      assetId,
      input.assetSha256,
      input.role,
      input.mediaType,
      input.width,
      input.height,
      input.altText,
      contentSha256,
      input.userId,
    ],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export type ImageAssetStatusTransition = 'needs_review' | 'rejected'

/**
 * Move an asset to `needs_review` (submit) or `rejected`. Never touches
 * metadata; clears approval + reviewer bindings. Returns null if not found.
 */
export async function setSeoImageAssetStatus(
  db: Queryable,
  assetId: string,
  status: ImageAssetStatusTransition,
  userId: number,
): Promise<SeoImageAssetRecord | null> {
  const result = await db.query<SeoImageAssetRow>(
    `
      update seo_image_assets
         set status = $2,
             approval_id = null,
             reviewer = null,
             updated_by_user_id = $3,
             updated_at = now()
       where asset_id = $1
      ${RETURNING_ASSET}
    `,
    [assetId, status, userId],
  )
  const row = result.rows[0]
  return row ? mapRow(row) : null
}

export type ApproveImageAssetResult =
  | { kind: 'ok'; record: SeoImageAssetRecord }
  | { kind: 'not_found' }
  | { kind: 'stale'; currentSha256: string }
  | { kind: 'not_compliant'; problems: string[] }

export interface ApproveImageAssetInput {
  readonly expectedContentSha256: string
  readonly reviewer: string
  readonly note?: string
  readonly userId: number
  readonly now?: Date
}

/**
 * The IRONCLAD human-approval gate (canon §1). Under a row lock:
 *   1. load the current row + recompute its fingerprint,
 *   2. reject if the reviewer's `expectedContentSha256` no longer matches
 *      (stale review — metadata changed after the page loaded),
 *   3. re-run the structural + sanitized-host compliance checks,
 *   4. mint a server-side approval id, write the append-only ledger row,
 *   5. bind the asset to that approval + stamp the reviewer (status='approved').
 */
export async function approveSeoImageAsset(
  assetId: string,
  input: ApproveImageAssetInput,
): Promise<ApproveImageAssetResult> {
  return withTransaction(async (client: PoolClient) => {
    const locked = await client.query<{
      asset_id: string
      asset_sha256: string
      role: string
      media_type: string
      width: number | string | null
      height: number | string | null
      alt_text: string
    }>(
      `
        select asset_id, asset_sha256, role, media_type, width, height, alt_text
          from seo_image_assets
         where asset_id = $1
         for update
      `,
      [assetId],
    )
    const lockedRow = locked.rows[0]
    if (!lockedRow) {
      return { kind: 'not_found' }
    }

    const content = rowToContentInput(lockedRow)
    const currentSha256 = imageAssetContentSha256(content)
    if (currentSha256 !== input.expectedContentSha256) {
      return { kind: 'stale', currentSha256 }
    }

    const problems = checkImageAssetApprovable(content)
    if (problems.length > 0) {
      return {
        kind: 'not_compliant',
        problems: problems.map((p) => `${p.field}: ${p.message}`),
      }
    }

    // Image assets share the `seoapr_` ledger id space with FAQ sets + posts.
    const approvalId = newSeoApprovalId(input.now ?? new Date())
    await client.query(
      `
        insert into seo_approvals (
          approval_id, content_kind, content_ref, content_sha256,
          approved_by_user_id, note
        )
        values ($1, 'image', $2, $3, $4, $5)
      `,
      [approvalId, assetId, currentSha256, input.userId, input.note ?? null],
    )

    const updated = await client.query<SeoImageAssetRow>(
      `
        update seo_image_assets
           set status = 'approved',
               approval_id = $2,
               reviewer = $3,
               content_sha256 = $4,
               updated_by_user_id = $5,
               updated_at = now()
         where asset_id = $1
        returning
          asset_id, asset_sha256, role, media_type, width, height, alt_text,
          status, source, content_sha256, approval_id, reviewer, generation_meta,
          created_by_user_id, updated_by_user_id, created_at, updated_at,
          (select approved_by_user_id from seo_approvals where approval_id = $2) as approved_by_user_id,
          (select approved_at from seo_approvals where approval_id = $2) as approved_at,
          (select note from seo_approvals where approval_id = $2) as approval_note
      `,
      [assetId, approvalId, input.reviewer, currentSha256, input.userId],
    )
    return { kind: 'ok', record: mapRow(updated.rows[0]!) }
  })
}
