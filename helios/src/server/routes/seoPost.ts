// SEO auto-blog control-plane routes (P4).
//
// Lets an operator author / generate / review / APPROVE blog posts that
// feed the signed SEO bundle (WhatsNewFeed + BlogPost widgets). Approval is
// the IRONCLAD human gate (canon §1): it requires an `approver`-or-above
// session, re-verifies the exact fingerprint the reviewer saw, runs the
// sanitized-host compliance checks, writes the append-only approval ledger,
// and stamps the reviewer. Nothing here publishes — the approved content
// only becomes a bundle CANDIDATE via the `seo-bundle build --posts-from-db`
// dry-run path; prod publish stays operator-only.
//
// child FreshlyBakedNYC/automation#44 (P4) · Satisfies: virusdave/top-level#15

import type { FastifyInstance } from 'fastify'

import {
  SeoPostApproveBodySchema,
  SeoPostCreateBodySchema,
  SeoPostDetailResponseSchema,
  SeoPostGenerateBodySchema,
  SeoPostListResponseSchema,
  SeoPostRejectBodySchema,
  SeoPostRouteParamsSchema,
  SeoPostScheduleBodySchema,
  SeoPostUpdateBodySchema,
  SeoSocialExportResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  approveSeoPost,
  createSeoPost,
  getSeoPost,
  listSeoPosts,
  scheduleSeoPost,
  setSeoPostStatus,
  updateSeoPost,
  type PostContentFields,
} from '../db/queries/seoPostQueries.js'
import { buildSocialExport, checkPostApprovable } from '../seo/postContent.js'
import { generatePostDraft } from '../seo/postGenerate.js'

export async function registerSeoPostRoutes(server: FastifyInstance): Promise<void> {
  // List all posts.
  server.get('/api/seo/posts', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const posts = await listSeoPosts(getPool())
    return reply.send(SeoPostListResponseSchema.parse({ posts }))
  })

  // Get one post.
  server.get('/api/seo/posts/:postId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = SeoPostRouteParamsSchema.parse(request.params)
    const post = await getSeoPost(getPool(), params.postId)
    if (!post) {
      return reply.status(404).send({ error: 'Post not found.' })
    }
    return reply.send(SeoPostDetailResponseSchema.parse({ post }))
  })

  // Create a new draft post.
  server.post('/api/seo/posts', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoPostCreateBodySchema.parse(request.body ?? {})
    const post = await createSeoPost(getPool(), {
      scope: body.scope,
      ...contentFields(body),
      userId: user.id,
    })
    return reply.status(201).send(SeoPostDetailResponseSchema.parse({ post }))
  })

  // Replace the post content. Always resets the post to `draft` and clears
  // any approval (server-enforced) so an approval can never cover edits.
  server.put('/api/seo/posts/:postId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoPostRouteParamsSchema.parse(request.params)
    const body = SeoPostUpdateBodySchema.parse(request.body ?? {})
    const post = await updateSeoPost(getPool(), params.postId, {
      scope: body.scope,
      ...contentFields(body),
      userId: user.id,
    })
    if (!post) {
      return reply.status(404).send({ error: 'Post not found.' })
    }
    return reply.send(SeoPostDetailResponseSchema.parse({ post }))
  })

  // Submit a draft for review (no content change).
  server.post('/api/seo/posts/:postId/submit', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoPostRouteParamsSchema.parse(request.params)
    const post = await setSeoPostStatus(getPool(), params.postId, 'needs_review', user.id)
    if (!post) {
      return reply.status(404).send({ error: 'Post not found.' })
    }
    return reply.send(SeoPostDetailResponseSchema.parse({ post }))
  })

  // Reject a post (clears any approval, marks rejected).
  server.post('/api/seo/posts/:postId/reject', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const params = SeoPostRouteParamsSchema.parse(request.params)
    SeoPostRejectBodySchema.parse(request.body ?? {})
    const post = await setSeoPostStatus(getPool(), params.postId, 'rejected', user.id)
    if (!post) {
      return reply.status(404).send({ error: 'Post not found.' })
    }
    return reply.send(SeoPostDetailResponseSchema.parse({ post }))
  })

  // APPROVE — the IRONCLAD human gate (canon §1). Approver+ only.
  server.post('/api/seo/posts/:postId/approve', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const params = SeoPostRouteParamsSchema.parse(request.params)
    const body = SeoPostApproveBodySchema.parse(request.body ?? {})
    const result = await approveSeoPost(params.postId, {
      expectedContentSha256: body.expectedContentSha256,
      reviewer: user.name,
      note: body.note,
      userId: user.id,
    })
    switch (result.kind) {
      case 'not_found':
        return reply.status(404).send({ error: 'Post not found.' })
      case 'stale':
        return reply.status(409).send({
          error:
            'This post changed after you loaded it; reload and review the current content before approving.',
          currentContentSha256: result.currentSha256,
        })
      case 'not_compliant':
        return reply.status(422).send({
          error: 'Post is not approvable.',
          detail: result.problems.join('\n'),
        })
      case 'ok':
        return reply.send(SeoPostDetailResponseSchema.parse({ post: result.record }))
    }
  })

  // Set / clear the scheduled release time (no content / approval change).
  // Editor+; scheduled_publish_at is excluded from the content fingerprint
  // so rescheduling never invalidates an approval.
  server.post('/api/seo/posts/:postId/schedule', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoPostRouteParamsSchema.parse(request.params)
    const body = SeoPostScheduleBodySchema.parse(request.body ?? {})
    const post = await scheduleSeoPost(
      getPool(),
      params.postId,
      body.scheduledPublishAt,
      user.id,
    )
    if (!post) {
      return reply.status(404).send({ error: 'Post not found.' })
    }
    return reply.send(SeoPostDetailResponseSchema.parse({ post }))
  })

  // Per-post social/marketing export (export-only — nothing auto-posts).
  server.get('/api/seo/posts/:postId/social-export', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = SeoPostRouteParamsSchema.parse(request.params)
    const post = await getSeoPost(getPool(), params.postId)
    if (!post) {
      return reply.status(404).send({ error: 'Post not found.' })
    }
    const exported = buildSocialExport(
      { title: post.title, excerpt: post.excerpt, tags: post.tags },
      post.canonicalUrl,
    )
    return reply.send(
      SeoSocialExportResponseSchema.parse({
        canonicalUrl: exported.canonical_url,
        entries: exported.entries,
      }),
    )
  })

  // Generate a DRAFT proposal via Bedrock and save it as a new draft post.
  // Proposals only — never auto-approved/published (canon §1).
  server.post('/api/seo/posts/generate', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoPostGenerateBodySchema.parse(request.body ?? {})
    const generated = await generatePostDraft({ topic: body.topic })
    if (generated.kind === 'error') {
      return reply.status(502).send({
        error: 'Post generation failed.',
        detail: generated.message,
      })
    }
    // Scope defaults to the reserved global `all` token; the operator
    // narrows it to a concrete site before approving.
    const post = await createSeoPost(getPool(), {
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
      generationMeta: generated.meta,
      userId: user.id,
    })
    return reply.status(201).send(SeoPostDetailResponseSchema.parse({ post }))
  })

  // Dry-run compliance check for the editor (no mutation). Lets the UI
  // surface the same problems the approve path would raise.
  server.post('/api/seo/posts/check', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const body = SeoPostUpdateBodySchema.parse(request.body ?? {})
    const problems = checkPostApprovable({
      post_id: 'post_check',
      scope: body.scope,
      slug: body.slug,
      title: body.title,
      meta_description: body.metaDescription,
      excerpt: body.excerpt,
      author: body.author,
      tags: body.tags,
      body_raw: body.bodyRaw,
      body_sanitized: body.bodySanitized,
      noindex: body.noindex,
    })
    return reply.send({
      ok: problems.length === 0,
      problems: problems.map((p) => `${p.field}: ${p.message}`),
    })
  })
}

// Pull the shared content fields out of a create/update body into the
// queries-layer shape.
function contentFields(body: {
  slug: string
  title: string
  metaDescription: string
  excerpt: string
  author: string
  tags: string[]
  bodyRaw: string
  bodySanitized: string
  noindex: boolean
}): PostContentFields {
  return {
    slug: body.slug,
    title: body.title,
    metaDescription: body.metaDescription,
    excerpt: body.excerpt,
    author: body.author,
    tags: body.tags,
    bodyRaw: body.bodyRaw,
    bodySanitized: body.bodySanitized,
    noindex: body.noindex,
  }
}
