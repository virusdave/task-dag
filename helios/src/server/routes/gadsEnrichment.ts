import type { FastifyInstance } from 'fastify'

import {
  GadsEnrichmentRequestSchema,
  GadsEnrichmentResponseSchema,
  type GadsEnrichmentResponse,
  type GadsL3Section,
} from '../../shared/contracts/index.js'
import {
  isGadsScope,
  requiredGadsGrants,
  type GadsScope,
} from '../../shared/domain/gadsSites.js'
import { requireConfidentialMetricsGrant } from '../auth/requireSession.js'
import { readL3Artifacts, type L3ArtifactSummary } from '../ads/l3Artifacts.js'
import { getGadsLpOutcomes } from '../db/queries/gadsLpOutcomesQueries.js'
import { sitesForScope } from '../db/queries/gadsAttemptScope.js'

/**
 * Shape the (un-redacted) L3 artifact summary into the contract's L3
 * section, REDACTING free text for a per-site grant.
 *
 * L3 is GLOBAL loop-level meta-analysis, not site-attributable. Its free
 * text (addenda bullets, proposal rationale/expected-impact) can quote
 * cross-site campaigns/families, so a per-site VIEW (scope bronx/midtown)
 * sees only non-identifying metadata: counts, freshness, hash,
 * approval/confidence flags. The free text is included ONLY on the
 * cross-site `all` view (which requires the gads-all grant). Keying the
 * redaction off the validated route scope means it holds even for a
 * gads-all user who opens a specific site's page. (Oracle P6 access
 * review.)
 */
export function shapeL3Section(raw: L3ArtifactSummary, scope: GadsScope): GadsL3Section {
  const full = scope === 'all'
  const latest = raw.latest
    ? {
        evaluationId: raw.latest.evaluationId,
        generatedAt: raw.latest.generatedAt,
        l2RunsAnalyzedCount: raw.latest.l2RunsAnalyzedCount,
        trialsAnalyzed: raw.latest.trialsAnalyzed,
        promptUpdateCount: raw.latest.promptUpdateCount,
        ruleUpdateCount: raw.latest.ruleUpdateCount,
        requiresHumanApproval: raw.latest.requiresHumanApproval,
        topProposals: full ? raw.latest.topProposals : [],
        // Truncation only meaningful when free text is included.
        topProposalsTruncated: full ? raw.latest.topProposalsTruncated : false,
      }
    : null
  return {
    scope: 'global',
    visibility: full ? 'full' : 'redacted',
    available: raw.available,
    evaluationsIndexed: raw.evaluationsIndexed,
    evaluationParseErrors: raw.evaluationParseErrors,
    latest,
    addenda: {
      exists: raw.addenda.exists,
      sha256: raw.addenda.sha256,
      bytes: raw.addenda.bytes,
      modifiedAt: raw.addenda.modifiedAt,
      generatedAt: raw.addenda.generatedAt,
      generatedByEvaluationId: raw.addenda.generatedByEvaluationId,
      l2RunsReferencedCount: raw.addenda.l2RunsReferencedCount,
      topBullets: full ? raw.addenda.topBullets : [],
    },
    consumption: raw.consumption,
  }
}

export async function registerGadsEnrichmentRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/gads/enrichment?site=
  //
  // L3 + LP enrichment for the per-site /metrics/gads-<site>/evolution page
  // (parent epic virusdave/top-level#24, child automation#51 P6). Two
  // panels' data:
  //   * L3 feedback-adoption — GLOBAL loop-level meta-analysis read from
  //     on-disk L3 artifacts (bounded, degrades to honest empty state).
  //     Free text is redacted for per-site grants; only gads-all sees it.
  //   * LP-evolver reaction — bounded landingpage_ad_outcomes summary,
  //     SITE-SCOPED via the server-derived appendGadsSitePredicate.
  //
  // Access: gated per-scope via requiredGadsGrants() — site=bronx needs
  // gads-bronx OR gads-all; site=all needs gads-all. The SAME validated
  // scope drives the grant gate, the LP site predicate, AND the L3
  // redaction (no client-supplied widening / no client-supplied file
  // name). Marked no-store (confidential evolution-engine internals).
  server.get('/api/gads/enrichment', async (request, reply) => {
    const parsed = GadsEnrichmentRequestSchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid GAds enrichment query.' })
    }
    const { site } = parsed.data

    // Defensive revalidation before deriving grants / the predicate so an
    // unknown scope can never collapse to an empty/over-broad grant list.
    if (!isGadsScope(site)) {
      return reply.status(400).send({ error: `Unknown GAds site scope: ${site}.` })
    }

    const grants = requiredGadsGrants(site)
    const user = await requireConfidentialMetricsGrant(request, reply, grants)
    if (!user) return

    const [l3Raw, lp] = await Promise.all([
      readL3Artifacts(),
      getGadsLpOutcomes({ scope: site }),
    ])

    const result: GadsEnrichmentResponse = {
      scope: site,
      generatedAt: new Date().toISOString(),
      sites: sitesForScope(site),
      l3: shapeL3Section(l3Raw, site),
      lp,
    }

    reply.header('Cache-Control', 'no-store')
    return reply.send(GadsEnrichmentResponseSchema.parse(result))
  })
}
