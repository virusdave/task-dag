// Load APPROVED SEO image assets from the control-plane DB into the shape
// the SEO bundle compiler consumes (contracts.ts SeoAsset[] for
// assets.json). This is the layer that turns operator-approved image
// metadata into bundle assets — used by the `seo-bundle build
// --assets-from-db` dry-run path.
//
// The pure compiler (compile.ts) stays I/O-free; ALL ledger verification
// lives here. We do not TRUST `seo_image_assets.approval_id`: we join the
// append-only `seo_approvals` ledger and re-verify, for every approved row,
// that
//   • a ledger row exists for the bound approval_id,
//   • it is an `image` approval for THIS asset_id,
//   • its recorded content_sha256 matches the row's stored fingerprint,
//   • and that fingerprint matches a freshly recomputed hash of the row's
//     actual metadata.
// Any mismatch fails the build LOUDLY (never silently omitted) — a broken
// approval record must stop a publish, not quietly drop an asset.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import { SeoAssetSchema, type SeoAsset } from './contracts.js'
import { imageAssetContentSha256, type ImageAssetContentInput } from './imageContent.js'
import type { Queryable } from '../db/pool.js'

export class ImageAssetBundleSourceError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Approved image-asset verification failed:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ImageAssetBundleSourceError'
  }
}

interface ApprovedImageAssetRow {
  asset_id: string
  asset_sha256: string
  role: string
  media_type: string
  width: number | string | null
  height: number | string | null
  alt_text: string
  content_sha256: string
  approval_id: string | null
  approval_kind: string | null
  approval_ref: string | null
  approval_sha256: string | null
}

function dimensionOrNull(value: number | string | null): number | null {
  if (value === null) {
    return null
  }
  return typeof value === 'number' ? value : Number.parseInt(value, 10)
}

function rowToContentInput(row: ApprovedImageAssetRow): ImageAssetContentInput {
  return {
    asset_id: row.asset_id,
    asset_sha256: row.asset_sha256,
    role: row.role as ImageAssetContentInput['role'],
    media_type: row.media_type,
    width: dimensionOrNull(row.width),
    height: dimensionOrNull(row.height),
    alt_text: row.alt_text,
  }
}

/**
 * Fetch every `approved` image asset, verify the approval ledger join + hash
 * for each, and return them as validated contract SeoAsset objects ready for
 * compileSeoBundle()'s assets.json. Throws ImageAssetBundleSourceError if
 * any approved row is inconsistent.
 */
export async function loadApprovedImageAssetsForBundle(db: Queryable): Promise<SeoAsset[]> {
  const result = await db.query<ApprovedImageAssetRow>(
    `
      select
        i.asset_id,
        i.asset_sha256,
        i.role,
        i.media_type,
        i.width,
        i.height,
        i.alt_text,
        i.content_sha256,
        i.approval_id,
        a.content_kind as approval_kind,
        a.content_ref  as approval_ref,
        a.content_sha256 as approval_sha256
      from seo_image_assets i
      left join seo_approvals a on a.approval_id = i.approval_id
      where i.status = 'approved'
      order by i.asset_id
    `,
  )

  const problems: string[] = []
  const assets: SeoAsset[] = []

  for (const row of result.rows) {
    const id = row.asset_id

    if (row.approval_id === null) {
      problems.push(`${id}: status=approved but approval_id is null.`)
      continue
    }
    if (row.approval_kind === null || row.approval_ref === null || row.approval_sha256 === null) {
      problems.push(`${id}: no seo_approvals ledger row for approval_id ${row.approval_id}.`)
      continue
    }
    if (row.approval_kind !== 'image') {
      problems.push(
        `${id}: approval ${row.approval_id} has content_kind '${row.approval_kind}', expected 'image'.`,
      )
      continue
    }
    if (row.approval_ref !== id) {
      problems.push(
        `${id}: approval ${row.approval_id} references content_ref '${row.approval_ref}', not this asset.`,
      )
      continue
    }
    if (row.approval_sha256 !== row.content_sha256) {
      problems.push(
        `${id}: stored content_sha256 ${row.content_sha256} does not match the approved fingerprint ${row.approval_sha256}.`,
      )
      continue
    }

    const content = rowToContentInput(row)
    const recomputed = imageAssetContentSha256(content)
    if (recomputed !== row.content_sha256) {
      problems.push(
        `${id}: actual metadata hashes to ${recomputed} but the stored/approved fingerprint is ${row.content_sha256} (metadata changed without re-approval).`,
      )
      continue
    }

    const width = dimensionOrNull(row.width)
    const height = dimensionOrNull(row.height)
    const candidate: Record<string, unknown> = {
      sha256: row.asset_sha256,
      role: row.role,
      media_type: row.media_type,
      alt_text: row.alt_text,
      approval_status: 'approved',
      approval_id: row.approval_id,
    }
    if (width !== null) {
      candidate.width = width
    }
    if (height !== null) {
      candidate.height = height
    }

    const parsed = SeoAssetSchema.safeParse(candidate)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${id}: ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      }
      continue
    }
    assets.push(parsed.data)
  }

  if (problems.length > 0) {
    throw new ImageAssetBundleSourceError(problems)
  }
  return assets
}
