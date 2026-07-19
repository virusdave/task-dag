import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PendingPurchaseHintExtractedFactsSchema } from '../../shared/contracts/index.js'
import type { Queryable } from '../../server/db/pool.js'
import { extractPendingPurchaseHintFacts } from '../pendingPurchases/hintFactExtraction.js'
import {
  classifyPendingPurchasePacketWithLlm,
  PendingPurchaseClassifierError,
  type ClassifyPendingPurchasePacketInput,
} from '../pendingPurchases/classifyPendingPurchasePacket.js'
import { buildClassifierHintFacts } from './generatePendingPurchasePacketJob.js'

// End-to-end coverage for the issue #69 glossary/acronym pipeline. The
// individual layers are unit-tested elsewhere (hintFactExtraction.test.ts for
// C3, pendingPurchaseHintQueries.test.ts for the loaders, hintRace.test.ts for
// buildClassifierHintFacts, classifyPendingPurchasePacket.test.ts for C4). What
// no single one of those proves is that the SAME extracted-facts blob C3 writes
// survives verbatim through the loader contract into a C4 payload the classifier
// accepts — a contract that spans four modules and could silently drift.
//
// This test wires the REAL functions across the whole seam, stubbing only the
// two external edges (the LLM transport for C3 and C4, and the DB read):
//
//   real C3 extractPendingPurchaseHintFacts  (LLM stubbed)
//     -> its `extractedFacts` blob persisted VERBATIM as `extracted_facts`
//     -> real loader + buildClassifierHintFacts               (DB stubbed)
//     -> real C4 classifyPendingPurchasePacketWithLlm         (LLM stubbed)
//
// The exact #69 shape — a glossary-only hint that expands "METRC" — must reach
// an accepted draft that cites the flattened glossary id; a fabricated cited id
// from the same chain must be rejected.

const mockEnv = {
  bedrockMantleBaseUrl: 'https://gateway.test/v1',
  bedrockMantleBearerToken: 'token-test' as string | null,
  llmRequestTimeoutMs: 120_000,
}

vi.mock('../config/env.js', () => ({
  getWorkerEnv: () => mockEnv,
}))

const BUNDLE_ID = 'pphint_2026-07-08_201800_a1b2c3'
const HINT_DOCUMENT_ID = 'pphdoc_2026-07-08_201830_d4e5f6'
const METRC_EXPANSION = 'Marijuana Enforcement Tracking Reporting Compliance'

// A db stub with no app_settings row so C4 resolves the code-default model.
const emptyClassifierDb = {
  query: async () => ({ rows: [] }),
} as unknown as Queryable

// Route C3's two LLM calls (intent classify, then fact/glossary extraction) to
// canned responses by the user-payload shape, exactly as the C3 unit test does.
function stubExtractionFetch(extractionBody: unknown, intent = 'free_text_description') {
  const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
    const request = JSON.parse(init.body) as { messages: Array<{ content: string }> }
    const userPayload = JSON.parse(request.messages[1]?.content ?? '{}') as Record<string, unknown>
    const responseBody = 'numberedLines' in userPayload ? extractionBody : { intent }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(responseBody) } }] }),
      { headers: { 'content-type': 'application/json' }, status: 200 },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// A C4 fetch stub returning one canned drafts body per call (fresh each time so
// the classifier's repair loop can re-read it).
function stubClassifierFetch(body: unknown, finishReason = 'stop') {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(body) } }],
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// The stubDb buildClassifierHintFacts reads: status roll-up (count(*) filter),
// operator-note pointer select (kind = 'operator_note'), else the facts/glossary
// select. This glossary doc is a distributor_menu, so the operator-note select
// returns nothing and we isolate the glossary path.
function glossaryStubDb(extractedFacts: unknown): Queryable {
  const progressRow = { total: 1, pending: 0, extracted: 1, failed: 0, skipped: 0 }
  const factsRow = {
    hint_document_id: HINT_DOCUMENT_ID,
    bundle_public_id: BUNDLE_ID,
    kind: 'distributor_menu',
    source_label: 'distributor menu legend',
    content_sha256: 'e'.repeat(64),
    // Persisted VERBATIM: exactly the blob C3 produced above.
    extracted_facts: extractedFacts,
  }
  return {
    query: (sql: string) => {
      const rows = /count\(\*\) filter/.test(sql)
        ? [progressRow]
        : /kind = 'operator_note'/.test(sql)
          ? []
          : [factsRow]
      return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] })
    },
  } as unknown as Queryable
}

// A METRC-abbreviated distributor row the classifier must decode using the
// glossary expansion, then map onto the live candidate.
function classifierInput(
  overrides: Partial<ClassifyPendingPurchasePacketInput>,
): ClassifyPendingPurchasePacketInput {
  return {
    db: emptyClassifierDb,
    eventDescription: 'Midtown — METRC delivery — PO 65',
    rows: [
      {
        rowKey: 'r1',
        distributorProductId: 'dp-metrc-1',
        distributorProductName: 'METRC 1A4-FL-BD-3.5',
        distributorNames: ['Midtown Distributor'],
        quantity: 12,
        unitCost: 18,
        currentDistributorLinkProductId: null,
        sweedSuggestions: [],
        vendorEvidence: {
          status: 'unknown',
          vendorId: null,
          vendorName: null,
          confidence: 'none',
          allowedBrandNames: [],
          allowedCatalogProductIds: [],
          evidence: [],
        },
      },
    ],
    catalogCandidates: [
      {
        productId: 8100,
        productName: 'Blue Dream 3.5g Flower',
        brand: 'House',
        category: 'Flower',
        subcategory: 'Packaged Eighth',
        groupName: 'Blue Dream',
        variantTab: 'Flower',
        strain: 'Blue Dream',
        size: '3.5g',
        packCount: 1,
      },
    ],
    hintFacts: [],
    glossaryEntries: [],
    operatorGuidance: [],
    allowedTaxonomy: { categories: ['Flower'], subcategories: ['Packaged Eighth'] },
    ...overrides,
  }
}

describe('pending-purchase glossary seam (C3 -> loader -> C4) — issue #69', () => {
  beforeEach(() => {
    mockEnv.bedrockMantleBearerToken = 'token-test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('carries a glossary-only METRC hint into an accepted draft that cites the flattened glossary id', async () => {
    // ── C3: real extraction of a glossary-only document (0 product facts) ──
    stubExtractionFetch({
      facts: [],
      glossary: [{ term: 'METRC', expansion: METRC_EXPANSION, note: null, lineStart: 1, lineEnd: 1 }],
      warnings: [],
    })
    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: HINT_DOCUMENT_ID,
      kind: 'distributor_menu',
      rawText: `METRC = ${METRC_EXPANSION}`,
    })
    expect(outcome.extractionStatus).toBe('extracted')
    const extractedFacts = outcome.extractedFacts!
    expect(extractedFacts.facts).toHaveLength(0)
    expect(extractedFacts.glossaryEntries).toHaveLength(1)
    // The persisted blob round-trips through the contract the loader re-validates.
    expect(() => PendingPurchaseHintExtractedFactsSchema.parse(extractedFacts)).not.toThrow()
    const glossaryFactId = extractedFacts.glossaryEntries[0]!.factId

    // ── loader + buildClassifierHintFacts: flatten the SAME blob verbatim ──
    const evidence = await buildClassifierHintFacts(glossaryStubDb(extractedFacts), BUNDLE_ID)
    expect(evidence.hintFacts).toEqual([])
    expect(evidence.operatorGuidance).toEqual([])
    expect(evidence.glossaryEntries).toHaveLength(1)
    const glossary = evidence.glossaryEntries[0]!
    const expectedCitedId = `${HINT_DOCUMENT_ID}#${glossaryFactId}`
    expect(glossary.citedId).toBe(expectedCitedId)
    expect(glossary.term).toBe('METRC')
    expect(glossary.expansion).toBe(METRC_EXPANSION)

    // ── C4: real classifier accepts a draft that decodes via + cites the glossary ──
    stubClassifierFetch({
      drafts: [
        {
          rowKey: 'r1',
          distributorProductId: 'echoed',
          distributorProductName: 'echoed',
          targetBrand: 'House',
          targetCategory: 'Flower',
          targetSubcategory: 'Packaged Eighth',
          targetGroupName: 'Blue Dream',
          targetVariantName: 'Blue Dream 3.5g',
          targetVariantTab: 'Flower',
          targetStrainName: 'Blue Dream',
          targetSize: '3.5g',
          targetPackCount: 1,
          proposedAction: 'mapping-only',
          reuseProductIdCandidate: 8100,
          reuseEvidence: {
            source: 'live-catalog-search',
            rationale: 'Decoded the METRC line to a Blue Dream eighth via the glossary.',
            citedHintIds: [expectedCitedId],
          },
          confidence: 0.82,
          rationale: 'Expanded METRC and matched the live Blue Dream 3.5g flower.',
          citedHintIds: [expectedCitedId],
          warningFlags: [],
        },
      ],
    })
    const result = await classifyPendingPurchasePacketWithLlm(
      classifierInput({ glossaryEntries: evidence.glossaryEntries }),
    )
    expect(result.drafts).toHaveLength(1)
    const draft = result.drafts[0]!
    expect(draft.reuseProductIdCandidate).toBe(8100)
    expect(draft.citedHintIds).toContain(expectedCitedId)
    // Distributor identity is authoritative from the input, never the model echo.
    expect(draft.distributorProductId).toBe('dp-metrc-1')
    expect(draft.distributorProductName).toBe('METRC 1A4-FL-BD-3.5')
  })

  it('rejects a draft that cites a fabricated glossary id from the same chain', async () => {
    stubExtractionFetch({
      facts: [],
      glossary: [{ term: 'METRC', expansion: METRC_EXPANSION, note: null, lineStart: 1, lineEnd: 1 }],
      warnings: [],
    })
    const outcome = await extractPendingPurchaseHintFacts({
      hintDocumentId: HINT_DOCUMENT_ID,
      kind: 'distributor_menu',
      rawText: `METRC = ${METRC_EXPANSION}`,
    })
    const evidence = await buildClassifierHintFacts(glossaryStubDb(outcome.extractedFacts!), BUNDLE_ID)

    // The model cites an id we never provided (#f99). Fail loud rather than
    // let a hallucinated citation flow to C5.
    const fabricatedCitedId = `${HINT_DOCUMENT_ID}#f99`
    stubClassifierFetch({
      drafts: [
        {
          rowKey: 'r1',
          distributorProductId: 'echoed',
          distributorProductName: 'echoed',
          targetBrand: null,
          targetCategory: 'Flower',
          targetSubcategory: 'Packaged Eighth',
          targetGroupName: null,
          targetVariantName: null,
          targetVariantTab: null,
          targetStrainName: null,
          targetSize: null,
          targetPackCount: null,
          proposedAction: 'needs-review',
          reuseProductIdCandidate: null,
          reuseEvidence: null,
          confidence: 0.4,
          rationale: 'Cited a glossary id that was never provided.',
          citedHintIds: [fabricatedCitedId],
          warningFlags: [],
        },
      ],
    })
    await expect(
      classifyPendingPurchasePacketWithLlm(classifierInput({ glossaryEntries: evidence.glossaryEntries })),
    ).rejects.toBeInstanceOf(PendingPurchaseClassifierError)
  })
})
