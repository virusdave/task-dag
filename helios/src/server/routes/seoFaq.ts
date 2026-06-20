// SEO FAQ control-plane routes (P3).
//
// Lets an operator author / generate / review / APPROVE FAQ sets that feed
// the signed SEO bundle. Approval is the IRONCLAD human gate (canon §1):
// it requires an `approver`-or-above session, re-verifies the exact
// fingerprint the reviewer saw, runs the sanitized-host compliance checks,
// and writes the append-only approval ledger. Nothing here publishes — the
// approved content only becomes a bundle CANDIDATE via the
// `seo-bundle build --faq-from-db` dry-run path; prod publish stays
// operator-only.
//
// child FreshlyBakedNYC/automation#44 (P3) · Satisfies: virusdave/top-level#15

import type { FastifyInstance } from 'fastify'

import {
  SeoFaqFamilyGenerateBodySchema,
  SeoFaqGenerateBodySchema,
  SeoFaqRouteParamsSchema,
  SeoFaqSetApproveBodySchema,
  SeoFaqSetCheckBodySchema,
  SeoFaqSetCreateBodySchema,
  SeoFaqSetDetailResponseSchema,
  SeoFaqReviewResponseSchema,
  SeoFaqSetListResponseSchema,
  SeoFaqSetRejectBodySchema,
  SeoFaqSetUpdateBodySchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  approveSeoFaqSet,
  createSeoFaqSet,
  getSeoFaqSet,
  listSeoFaqSets,
  setSeoFaqSetStatus,
  updateSeoFaqSet,
} from '../db/queries/seoFaqQueries.js'
import { checkFaqSetApprovable } from '../seo/faqContent.js'
import { buildFaqReviewBundle } from '../seo/faqReview.js'
import { generateFamilyFaqDraft } from '../seo/faqFamilyGenerate.js'
import { generateFaqDraft } from '../seo/faqGenerate.js'
import { getLpFamily, listLpFamilies, lpFamilyFaqSourceKey } from '../seo/lpFamilyRegistry.js'

export async function registerSeoFaqRoutes(server: FastifyInstance): Promise<void> {
  // List all FAQ sets.
  server.get('/api/seo/faq-sets', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const faqSets = await listSeoFaqSets(getPool())
    return reply.send(SeoFaqSetListResponseSchema.parse({ faqSets }))
  })

  // Get one FAQ set.
  server.get('/api/seo/faq-sets/:faqSetId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = SeoFaqRouteParamsSchema.parse(request.params)
    const faqSet = await getSeoFaqSet(getPool(), params.faqSetId)
    if (!faqSet) {
      return reply.status(404).send({ error: 'FAQ set not found.' })
    }
    return reply.send(SeoFaqSetDetailResponseSchema.parse({ faqSet }))
  })

  // Review bundle for one FAQ set (#46 P5) — everything a reviewer needs to
  // decide, derived server-side from the persisted set: approval blockers,
  // advisory governance warnings, sanitized-host leak markers, route
  // placement (from the PERSISTED source key), and JSON-LD preview for both
  // host modes. Read-only (viewer+); the approve/reject mutations below keep
  // their stricter approver+ gate.
  server.get('/api/seo/faq-sets/:faqSetId/review', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const params = SeoFaqRouteParamsSchema.parse(request.params)
    const faqSet = await getSeoFaqSet(getPool(), params.faqSetId)
    if (!faqSet) {
      return reply.status(404).send({ error: 'FAQ set not found.' })
    }
    const bundle = buildFaqReviewBundle({ items: faqSet.items, sourceKey: faqSet.sourceKey })
    return reply.send(SeoFaqReviewResponseSchema.parse({ faqSet, ...bundle }))
  })

  // Create a new draft FAQ set.
  server.post('/api/seo/faq-sets', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoFaqSetCreateBodySchema.parse(request.body ?? {})
    const faqSet = await createSeoFaqSet(getPool(), {
      scope: body.scope,
      items: body.items,
      userId: user.id,
    })
    return reply.status(201).send(SeoFaqSetDetailResponseSchema.parse({ faqSet }))
  })

  // Replace scope + items. Always resets the set to `draft` and clears any
  // approval (server-enforced) so an approval can never cover edited content.
  server.put('/api/seo/faq-sets/:faqSetId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoFaqRouteParamsSchema.parse(request.params)
    const body = SeoFaqSetUpdateBodySchema.parse(request.body ?? {})
    const faqSet = await updateSeoFaqSet(getPool(), params.faqSetId, {
      scope: body.scope,
      items: body.items,
      userId: user.id,
    })
    if (!faqSet) {
      return reply.status(404).send({ error: 'FAQ set not found.' })
    }
    return reply.send(SeoFaqSetDetailResponseSchema.parse({ faqSet }))
  })

  // Submit a draft for review (no content change).
  server.post('/api/seo/faq-sets/:faqSetId/submit', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = SeoFaqRouteParamsSchema.parse(request.params)
    const faqSet = await setSeoFaqSetStatus(getPool(), params.faqSetId, 'needs_review', user.id)
    if (!faqSet) {
      return reply.status(404).send({ error: 'FAQ set not found.' })
    }
    return reply.send(SeoFaqSetDetailResponseSchema.parse({ faqSet }))
  })

  // Reject a set (clears any approval, marks rejected).
  server.post('/api/seo/faq-sets/:faqSetId/reject', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const params = SeoFaqRouteParamsSchema.parse(request.params)
    SeoFaqSetRejectBodySchema.parse(request.body ?? {})
    const faqSet = await setSeoFaqSetStatus(getPool(), params.faqSetId, 'rejected', user.id)
    if (!faqSet) {
      return reply.status(404).send({ error: 'FAQ set not found.' })
    }
    return reply.send(SeoFaqSetDetailResponseSchema.parse({ faqSet }))
  })

  // APPROVE — the IRONCLAD human gate (canon §1). Approver+ only.
  server.post('/api/seo/faq-sets/:faqSetId/approve', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const params = SeoFaqRouteParamsSchema.parse(request.params)
    const body = SeoFaqSetApproveBodySchema.parse(request.body ?? {})
    const result = await approveSeoFaqSet(params.faqSetId, {
      expectedContentSha256: body.expectedContentSha256,
      note: body.note,
      userId: user.id,
    })
    switch (result.kind) {
      case 'not_found':
        return reply.status(404).send({ error: 'FAQ set not found.' })
      case 'stale':
        return reply.status(409).send({
          error:
            'This FAQ set changed after you loaded it; reload and review the current content before approving.',
          currentContentSha256: result.currentSha256,
        })
      case 'not_compliant':
        return reply.status(422).send({
          error: 'FAQ set is not approvable.',
          detail: result.problems.join('\n'),
        })
      case 'ok':
        return reply.send(SeoFaqSetDetailResponseSchema.parse({ faqSet: result.record }))
    }
  })

  // Generate a DRAFT proposal via Bedrock and save it as a new draft set.
  // Proposals only — never auto-approved/published (canon §1).
  server.post('/api/seo/faq-sets/generate', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoFaqGenerateBodySchema.parse(request.body ?? {})
    const generated = await generateFaqDraft({ topic: body.topic, itemCount: body.itemCount })
    if (generated.kind === 'error') {
      return reply.status(502).send({
        error: 'FAQ generation failed.',
        detail: generated.message,
      })
    }
    // Scope defaults to the reserved global `all` token; the operator
    // narrows it to a concrete site before approving.
    const faqSet = await createSeoFaqSet(getPool(), {
      scope: 'all',
      items: generated.items,
      source: 'generated',
      generationMeta: generated.meta,
      userId: user.id,
    })
    return reply.status(201).send(SeoFaqSetDetailResponseSchema.parse({ faqSet }))
  })

  // List the FBUS LP families available for family-contextual generation,
  // read from the vendored mss LP-family registry. Lets the editor UI pick a
  // valid family id and see where its FAQs will be scoped (route patterns).
  server.get('/api/seo/faq-families', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    return reply.send({
      families: listLpFamilies().map((family) => ({
        id: family.id,
        aliases: family.aliases,
        sourceKey: lpFamilyFaqSourceKey(family.id),
        canonicalRepresentativeRoute: family.canonical_representative_route,
        routePatterns: family.widget_route_patterns,
        indexabilityPolicy: family.indexability_policy,
      })),
    })
  })

  // Generate a family-contextual DRAFT proposal via Bedrock and save it as a
  // new draft set, keyed by the family's FBUS source key (`fbus-<id>-faq`) so
  // it is held to the stricter FBUS denylist at approval time (CI gate 2).
  // Proposals only — never auto-approved/published (canon §1).
  server.post('/api/seo/faq-sets/generate-family', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = SeoFaqFamilyGenerateBodySchema.parse(request.body ?? {})
    // Resolve the family up front so an unknown id is a 400 (client error),
    // not a 502 (which we reserve for an actual Bedrock gateway failure).
    if (!getLpFamily(body.familyId)) {
      return reply.status(400).send({
        error: `Unknown LP family '${body.familyId}'.`,
        detail: `Known families: ${listLpFamilies()
          .map((f) => f.id)
          .join(', ')}.`,
      })
    }
    const generated = await generateFamilyFaqDraft({
      familyId: body.familyId,
      itemCount: body.itemCount,
      focus: body.focus,
    })
    if (generated.kind === 'error') {
      return reply.status(502).send({
        error: 'Family FAQ generation failed.',
        detail: generated.message,
      })
    }
    // Scope defaults to the reserved global `all` token; the operator
    // narrows it to a concrete site before approving. The FBUS source key
    // (not the scope) is what enforces sanitized-mode at approval.
    const faqSet = await createSeoFaqSet(getPool(), {
      scope: 'all',
      sourceKey: generated.meta.sourceKey,
      items: generated.items,
      source: 'generated',
      generationMeta: generated.meta,
      userId: user.id,
    })
    return reply.status(201).send(SeoFaqSetDetailResponseSchema.parse({ faqSet }))
  })

  // Dry-run compliance check for the editor (no mutation). Lets the UI
  // surface the same problems the approve path would raise.
  server.post('/api/seo/faq-sets/check', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const body = SeoFaqSetCheckBodySchema.parse(request.body ?? {})
    const problems = checkFaqSetApprovable(body.items, { sourceKey: body.sourceKey ?? null })
    return reply.send({
      ok: problems.length === 0,
      problems: problems.map((p) =>
        p.itemIndex < 0 ? p.message : `Item ${p.itemIndex + 1} (${p.field}): ${p.message}`,
      ),
    })
  })
}
