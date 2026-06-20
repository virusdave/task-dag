import { describe, expect, it } from 'vitest'

import { shapeL3Section } from './gadsEnrichment.js'
import type { L3ArtifactSummary } from '../ads/l3Artifacts.js'

// ---------------------------------------------------------------------------
// Access-redaction tests for the P6 enrichment route. L3 is GLOBAL
// loop-level meta-analysis whose free text can quote cross-site
// campaigns/families, so a per-site grant (bronx/midtown) must see ONLY
// non-identifying metadata; only the cross-site gads-all grant sees the
// bounded free text (proposal rationale + addenda bullets). This is the
// single access invariant the route enforces beyond the grant gate itself.
// ---------------------------------------------------------------------------

const rawWithFreeText: L3ArtifactSummary = {
  available: true,
  evaluationsIndexed: 2,
  evaluationParseErrors: 0,
  latest: {
    evaluationId: 'eval-7',
    generatedAt: '2026-06-10T00:00:00.000Z',
    l2RunsAnalyzedCount: 3,
    trialsAnalyzed: 0,
    promptUpdateCount: 4,
    ruleUpdateCount: 1,
    requiresHumanApproval: true,
    topProposals: [
      {
        updateType: 'prompt',
        component: 'bronx-campaign-X',
        rationale: 'Bronx campaign keeps grinding; switch to repair.',
        expectedImpact: 'fewer pauses',
        confidence: 0.9,
      },
    ],
    topProposalsTruncated: true,
  },
  addenda: {
    exists: true,
    sha256: 'a'.repeat(64),
    bytes: 1234,
    modifiedAt: '2026-06-10T04:00:00.000Z',
    generatedAt: '2026-06-10T04:00:00.000Z',
    generatedByEvaluationId: 'eval-7',
    l2RunsReferencedCount: 3,
    topBullets: ['Midtown family Y had 80% no_change — try a different approach.'],
  },
  consumption: {
    status: 'likely_consumed',
    basis: 'addenda_header_generated_at',
    newestL2RunId: 'run-9',
    newestL2RunAt: '2026-06-11T04:00:00.000Z',
  },
}

describe('shapeL3Section — per-site redaction', () => {
  it('REDACTS free text for a per-site (bronx) grant but keeps metadata', () => {
    const section = shapeL3Section(rawWithFreeText, 'bronx')
    expect(section.scope).toBe('global')
    expect(section.visibility).toBe('redacted')
    // Metadata preserved.
    expect(section.available).toBe(true)
    expect(section.evaluationsIndexed).toBe(2)
    expect(section.latest?.evaluationId).toBe('eval-7')
    expect(section.latest?.promptUpdateCount).toBe(4)
    expect(section.latest?.requiresHumanApproval).toBe(true)
    expect(section.addenda.sha256).toBe('a'.repeat(64))
    expect(section.addenda.generatedByEvaluationId).toBe('eval-7')
    expect(section.consumption.status).toBe('likely_consumed')
    // Free text REDACTED.
    expect(section.latest?.topProposals).toEqual([])
    expect(section.latest?.topProposalsTruncated).toBe(false)
    expect(section.addenda.topBullets).toEqual([])
  })

  it('redacts free text for midtown too', () => {
    const section = shapeL3Section(rawWithFreeText, 'midtown')
    expect(section.visibility).toBe('redacted')
    expect(section.latest?.topProposals).toEqual([])
    expect(section.addenda.topBullets).toEqual([])
  })

  it('includes full bounded free text for the gads-all grant', () => {
    const section = shapeL3Section(rawWithFreeText, 'all')
    expect(section.visibility).toBe('full')
    expect(section.latest?.topProposals.length).toBe(1)
    expect(section.latest?.topProposals[0].rationale).toMatch(/Bronx campaign/)
    expect(section.latest?.topProposalsTruncated).toBe(true)
    expect(section.addenda.topBullets.length).toBe(1)
  })

  it('handles a null latest evaluation under every scope', () => {
    const empty: L3ArtifactSummary = {
      available: false,
      evaluationsIndexed: 0,
      evaluationParseErrors: 0,
      latest: null,
      addenda: {
        exists: false,
        sha256: null,
        bytes: null,
        modifiedAt: null,
        generatedAt: null,
        generatedByEvaluationId: null,
        l2RunsReferencedCount: null,
        topBullets: [],
      },
      consumption: { status: 'unknown', basis: 'none', newestL2RunId: null, newestL2RunAt: null },
    }
    for (const scope of ['bronx', 'midtown', 'all'] as const) {
      const section = shapeL3Section(empty, scope)
      expect(section.available).toBe(false)
      expect(section.latest).toBeNull()
      expect(section.addenda.exists).toBe(false)
    }
  })
})
