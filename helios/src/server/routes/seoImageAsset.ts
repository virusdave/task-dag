// SEO image-asset control-plane routes (P4 remainder).
//
// Lets an operator register / review / APPROVE SEO image assets (hero / og /
// derivative) INDEPENDENTLY of any blog post (parent EPIC_PLAN §0.3).
// Approval is the IRONCLAD human gate (canon §1): it requires an
// `approver`-or-above session, re-verifies the exact fingerprint the
// reviewer saw, runs the sanitized-host compliance checks (alt text),
// writes the append-only approval ledger, and stamps the reviewer. Nothing
// here publishes — the approved assets only become bundle CANDIDATES via the
// `seo-bundle build --assets-from-db` dry-run path; prod publish stays
// operator-only.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import type { FastifyInstance } from 'fastify'

import {
  SeoImageAssetApproveBodySchema,
  SeoImageAssetCreateBodySchema,
  SeoImageAssetDetailResponseSchema,
  SeoImageAssetListResponseSchema,
  SeoImageAssetRejectBodySchema,
  SeoImageAssetRouteParamsSchema,
  SeoImageAssetUpdateBodySchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  approveSeoImageAsset,
  createSeoImageAsset,
  getSeoImageAsset,
  listSeoImageAssets,
  setSeoImageAssetStatus,
  updateSeoImageAsset,
  type ImageAssetContentFields,
} from '../db/queries/seoImageAssetQueries.js'
import { checkImageAssetApprovable } from '../seo/imageContent.js'

export async function registerSeoImageAssetRoutes(server: FastifyInstance): Promise<void> {
  // List all image assets.
  server.get('/api/seo/image-assets', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const assets = await listSeoImageAssets(getPool())
    return reply.send(SeoImageAssetListResponseSchema.parse({ assets }))
  })

  // Get one image asset.
  server.get('/api/seo/image-assets/:assetId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = SeoImageAssetRouteParamsSchema.parse(request.params)
    const asset = await getSeoImageAsset(getPool(), params.assetId)
    if (!asset) {
      return reply.status(404).send({ error: 'Image asset not found.' })
    }
    return reply.send(SeoImageAssetDetailResponseSchema.parse({ asset }))
  })

  // Create a new draft image asset.
  server.post('/api/seo/image-assets', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoImageAssetCreateBodySchema.parse(request.body ?? {})
    const asset = await createSeoImageAsset(getPool(), {
      ...contentFields(body),
      userId: user.id,
    })
    return reply.status(201).send(SeoImageAssetDetailResponseSchema.parse({ asset }))
  })

  // Replace the asset metadata. Always resets the asset to `draft` and
  // clears any approval (server-enforced) so an approval can never cover
  // edits.
  server.put('/api/seo/image-assets/:assetId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoImageAssetRouteParamsSchema.parse(request.params)
    const body = SeoImageAssetUpdateBodySchema.parse(request.body ?? {})
    const asset = await updateSeoImageAsset(getPool(), params.assetId, {
      ...contentFields(body),
      userId: user.id,
    })
    if (!asset) {
      return reply.status(404).send({ error: 'Image asset not found.' })
    }
    return reply.send(SeoImageAssetDetailResponseSchema.parse({ asset }))
  })

  // Submit a draft for review (no metadata change).
  server.post('/api/seo/image-assets/:assetId/submit', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoImageAssetRouteParamsSchema.parse(request.params)
    const asset = await setSeoImageAssetStatus(getPool(), params.assetId, 'needs_review', user.id)
    if (!asset) {
      return reply.status(404).send({ error: 'Image asset not found.' })
    }
    return reply.send(SeoImageAssetDetailResponseSchema.parse({ asset }))
  })

  // Reject an asset (clears any approval, marks rejected).
  server.post('/api/seo/image-assets/:assetId/reject', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const params = SeoImageAssetRouteParamsSchema.parse(request.params)
    SeoImageAssetRejectBodySchema.parse(request.body ?? {})
    const asset = await setSeoImageAssetStatus(getPool(), params.assetId, 'rejected', user.id)
    if (!asset) {
      return reply.status(404).send({ error: 'Image asset not found.' })
    }
    return reply.send(SeoImageAssetDetailResponseSchema.parse({ asset }))
  })

  // APPROVE — the IRONCLAD human gate (canon §1). Approver+ only.
  server.post('/api/seo/image-assets/:assetId/approve', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const params = SeoImageAssetRouteParamsSchema.parse(request.params)
    const body = SeoImageAssetApproveBodySchema.parse(request.body ?? {})
    const result = await approveSeoImageAsset(params.assetId, {
      expectedContentSha256: body.expectedContentSha256,
      reviewer: user.name,
      note: body.note,
      userId: user.id,
    })
    switch (result.kind) {
      case 'not_found':
        return reply.status(404).send({ error: 'Image asset not found.' })
      case 'stale':
        return reply.status(409).send({
          error:
            'This image asset changed after you loaded it; reload and review the current metadata before approving.',
          currentContentSha256: result.currentSha256,
        })
      case 'not_compliant':
        return reply.status(422).send({
          error: 'Image asset is not approvable.',
          detail: result.problems.join('\n'),
        })
      case 'ok':
        return reply.send(SeoImageAssetDetailResponseSchema.parse({ asset: result.record }))
    }
  })

  // Dry-run compliance check for the editor (no mutation). Lets the UI
  // surface the same problems the approve path would raise.
  server.post('/api/seo/image-assets/check', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const body = SeoImageAssetUpdateBodySchema.parse(request.body ?? {})
    const problems = checkImageAssetApprovable({
      asset_id: 'img_check',
      asset_sha256: body.assetSha256,
      role: body.role,
      media_type: body.mediaType,
      width: body.width,
      height: body.height,
      alt_text: body.altText,
    })
    return reply.send({
      ok: problems.length === 0,
      problems: problems.map((p) => `${p.field}: ${p.message}`),
    })
  })
}

// Pull the shared metadata fields out of a create/update body into the
// queries-layer shape.
function contentFields(body: {
  assetSha256: string
  role: ImageAssetContentFields['role']
  mediaType: string
  width: number | null
  height: number | null
  altText: string
}): ImageAssetContentFields {
  return {
    assetSha256: body.assetSha256,
    role: body.role,
    mediaType: body.mediaType,
    width: body.width,
    height: body.height,
    altText: body.altText,
  }
}
