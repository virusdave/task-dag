// SEO auto-blog SOURCE-INGESTION routes (P4).
//
// Lets an operator (or an authorized API caller) manage the approved-source
// allowlist and record the source content / links Helios will later draft
// blog posts from (parent EPIC_PLAN §7.1). Per the operator-approved scope
// (issue #44, option (a)) this is schema + operator/API-driven ingest only:
// no automated fetchers. Ingest is FAIL-CLOSED against the allowlist.
//
// Nothing here publishes — source items are raw drafting INPUTS. The
// IRONCLAD human-approval gate (canon §1) applies one step later, to the
// posts a human authors/approves from these inputs (seoPost.ts).
//
// RBAC: reads = viewer; item ingest / status = editor; allowlist governance
// (which sources are approved) = approver.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import type { FastifyInstance } from 'fastify'

import {
  SeoSourceAllowlistDetailResponseSchema,
  SeoSourceAllowlistListResponseSchema,
  SeoSourceAllowlistRouteParamsSchema,
  SeoSourceAllowlistSetEnabledBodySchema,
  SeoSourceAllowlistUpsertBodySchema,
  SeoSourceItemDetailResponseSchema,
  SeoSourceItemGenerateDraftResponseSchema,
  SeoSourceItemIngestBodySchema,
  SeoSourceItemIngestResponseSchema,
  SeoSourceItemListQuerySchema,
  SeoSourceItemListResponseSchema,
  SeoSourceItemRouteParamsSchema,
  SeoSourceItemSetStatusBodySchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { createSeoPost } from '../db/queries/seoPostQueries.js'
import {
  getSeoSourceAllowlistEntry,
  getSeoSourceItem,
  ingestSeoSourceItem,
  listSeoSourceAllowlist,
  listSeoSourceItems,
  SeoSourceIngestError,
  setSeoSourceAllowlistEnabled,
  setSeoSourceItemStatus,
  upsertSeoSourceAllowlist,
} from '../db/queries/seoSourceQueries.js'
import { withTransaction } from '../db/tx.js'
import { generatePostDraft } from '../seo/postGenerate.js'

export async function registerSeoSourceRoutes(server: FastifyInstance): Promise<void> {
  // ── allowlist ──────────────────────────────────────────────────────

  // List the approved-source allowlist.
  server.get('/api/seo/source-allowlist', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const sources = await listSeoSourceAllowlist(getPool())
    return reply.send(SeoSourceAllowlistListResponseSchema.parse({ sources }))
  })

  // Upsert an approved source (governance — approver+).
  server.put('/api/seo/source-allowlist/:sourceKey', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const params = SeoSourceAllowlistRouteParamsSchema.parse(request.params)
    const body = SeoSourceAllowlistUpsertBodySchema.parse(request.body ?? {})
    const source = await upsertSeoSourceAllowlist(getPool(), {
      sourceKey: params.sourceKey,
      kind: body.kind,
      displayName: body.displayName,
      homepageUrl: body.homepageUrl ?? null,
      note: body.note ?? null,
      enabled: body.enabled,
      userId: user.id,
    })
    return reply.send(SeoSourceAllowlistDetailResponseSchema.parse({ source }))
  })

  // Enable/disable an approved source (governance — approver+).
  server.post('/api/seo/source-allowlist/:sourceKey/enabled', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const params = SeoSourceAllowlistRouteParamsSchema.parse(request.params)
    const body = SeoSourceAllowlistSetEnabledBodySchema.parse(request.body ?? {})
    const source = await setSeoSourceAllowlistEnabled(
      getPool(),
      params.sourceKey,
      body.enabled,
      user.id,
    )
    if (!source) {
      return reply.status(404).send({ error: 'Source not found.' })
    }
    return reply.send(SeoSourceAllowlistDetailResponseSchema.parse({ source }))
  })

  // ── source items ───────────────────────────────────────────────────

  // List recorded source items (optionally filtered by status / source).
  server.get('/api/seo/source-items', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const query = SeoSourceItemListQuerySchema.parse(request.query ?? {})
    const items = await listSeoSourceItems(getPool(), {
      status: query.status,
      sourceKey: query.sourceKey,
      limit: query.limit,
    })
    return reply.send(SeoSourceItemListResponseSchema.parse({ items }))
  })

  // Get one source item.
  server.get('/api/seo/source-items/:sourceItemId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = SeoSourceItemRouteParamsSchema.parse(request.params)
    const item = await getSeoSourceItem(getPool(), params.sourceItemId)
    if (!item) {
      return reply.status(404).send({ error: 'Source item not found.' })
    }
    return reply.send(SeoSourceItemDetailResponseSchema.parse({ item }))
  })

  // Ingest a source item. Fail-closed against the allowlist; idempotent on
  // the dedup hash. 201 for a newly recorded item, 200 for a dedup hit.
  server.post('/api/seo/source-items', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoSourceItemIngestBodySchema.parse(request.body ?? {})
    try {
      const result = await ingestSeoSourceItem({
        sourceKey: body.sourceKey,
        title: body.title,
        url: body.url ?? null,
        publishedAt: body.publishedAt ?? null,
        summary: body.summary ?? null,
        topicTags: body.topicTags,
        riskFlags: body.riskFlags,
        ingestSource: body.ingestSource,
        ingestMeta: body.ingestMeta,
        userId: user.id,
      })
      return reply
        .status(result.deduped ? 200 : 201)
        .send(SeoSourceItemIngestResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof SeoSourceIngestError) {
        // unknown_source → 400 (caller error); disabled_source → 409
        // (the source exists but is not currently accepting ingest).
        const status = error.code === 'disabled_source' ? 409 : 400
        return reply.status(status).send({ error: error.message, code: error.code })
      }
      throw error
    }
  })

  // Update a source item's intake status (new → reviewed/drafted/dismissed).
  server.post('/api/seo/source-items/:sourceItemId/status', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoSourceItemRouteParamsSchema.parse(request.params)
    const body = SeoSourceItemSetStatusBodySchema.parse(request.body ?? {})
    const item = await setSeoSourceItemStatus(
      getPool(),
      params.sourceItemId,
      body.status,
      user.id,
    )
    if (!item) {
      return reply.status(404).send({ error: 'Source item not found.' })
    }
    return reply.send(SeoSourceItemDetailResponseSchema.parse({ item }))
  })

  // Generate a blog-post DRAFT from a source item via Bedrock (P4, the
  // §7.1-intake → §7.3-draft wiring). Editor+. Bedrock produces a
  // draft-only proposal — NEVER auto-approved/published (canon §1): it is
  // saved as a `draft` post (source='generated', scope defaults to the
  // reserved global `all`, provenance recorded in generation_meta) and the
  // source item moves to `drafted`. The two writes commit atomically AFTER
  // the (slow, network) LLM call, which is made outside any DB transaction.
  server.post('/api/seo/source-items/:sourceItemId/generate-draft', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoSourceItemRouteParamsSchema.parse(request.params)
    const item = await getSeoSourceItem(getPool(), params.sourceItemId)
    if (!item) {
      return reply.status(404).send({ error: 'Source item not found.' })
    }
    if (item.status === 'dismissed') {
      return reply.status(409).send({
        error: 'This source item was dismissed; un-dismiss it before drafting from it.',
      })
    }

    const generated = await generatePostDraft({
      topic: item.title,
      source: {
        sourceKey: item.sourceKey,
        title: item.title,
        url: item.url,
        summary: item.summary,
      },
    })
    if (generated.kind === 'error') {
      return reply.status(502).send({
        error: 'Draft generation failed.',
        detail: generated.message,
      })
    }

    const { post, sourceItem } = await withTransaction(async (client) => {
      const created = await createSeoPost(client, {
        scope: 'all',
        slug: generated.draft.slug,
        title: generated.draft.title,
        metaDescription: generated.draft.meta_description,
        excerpt: generated.draft.excerpt,
        author: 'Freshly Baked Editorial',
        tags: generated.draft.tags,
        bodyRaw: generated.draft.body_raw,
        bodySanitized: generated.draft.body_sanitized,
        noindex: false,
        source: 'generated',
        // Provenance: which source lead this draft was generated from.
        generationMeta: {
          ...generated.meta,
          sourceItemId: item.sourceItemId,
          sourceKey: item.sourceKey,
          sourceUrl: item.url,
        },
        userId: user.id,
      })
      const updated = await setSeoSourceItemStatus(
        client,
        item.sourceItemId,
        'drafted',
        user.id,
      )
      return { post: created, sourceItem: updated }
    })

    // setSeoSourceItemStatus only returns null if the row vanished mid-tx
    // (it existed at the guard above); the tx would have surfaced any real
    // error. Fall back to the pre-tx item rather than 500ing the draft.
    return reply.status(201).send(
      SeoSourceItemGenerateDraftResponseSchema.parse({
        post,
        sourceItem: sourceItem ?? { ...item, status: 'drafted' },
      }),
    )
  })
}
