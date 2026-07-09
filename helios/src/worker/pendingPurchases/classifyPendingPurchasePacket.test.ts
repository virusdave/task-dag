import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Queryable } from '../../server/db/pool.js'
import {
  classifyPendingPurchasePacketWithLlm,
  PendingPurchaseClassifierError,
  type ClassifierGlossaryEntry,
  type ClassifierHintFact,
  type ClassifierOperatorGuidance,
  type ClassifierRowInput,
  type ClassifyPendingPurchasePacketInput,
} from './classifyPendingPurchasePacket.js'

// Mutable env the mocked getWorkerEnv returns; reset before each test.
const mockEnv = {
  bedrockMantleBaseUrl: 'https://gateway.test/v1',
  bedrockMantleBearerToken: 'token-test' as string | null,
  llmRequestTimeoutMs: 120_000,
}

vi.mock('../config/env.js', () => ({
  getWorkerEnv: () => mockEnv,
}))

// A db stub that returns no app_settings row, so the classifier resolves the
// code-default model. (Override resolution itself is covered in the resolver
// test.)
const emptyDb = {
  query: async () => ({ rows: [] }),
} as unknown as Queryable

const VALID_CITED_ID = 'pphdoc_2026-06-21_000001_ab12cd#f1'
const VALID_GLOSSARY_CITED_ID = 'pphdoc_2026-06-21_000001_ab12cd#f2'

function hintFact(): ClassifierHintFact {
  return {
    citedId: VALID_CITED_ID,
    hintDocumentId: 'pphdoc_2026-06-21_000001_ab12cd',
    factId: 'f1',
    kind: 'distributor_menu',
    intent: 'canonical_sku_list',
    fact: { itemName: 'Pink Runtz 3.5g' },
  }
}

function glossaryEntry(): ClassifierGlossaryEntry {
  return {
    citedId: VALID_GLOSSARY_CITED_ID,
    hintDocumentId: 'pphdoc_2026-06-21_000001_ab12cd',
    factId: 'f2',
    term: 'PNK',
    expansion: 'Pink Runtz',
    note: null,
  }
}

function rowInput(overrides: Partial<ClassifierRowInput> = {}): ClassifierRowInput {
  return {
    rowKey: 'r1',
    distributorProductId: 'dp-1',
    distributorProductName: '1O-8F-R26-PNK',
    distributorNames: ['Stop 31 LLC'],
    quantity: 24,
    unitCost: 12.5,
    currentDistributorLinkProductId: null,
    sweedSuggestions: [],
    ...overrides,
  }
}

function buildInput(overrides: Partial<ClassifyPendingPurchasePacketInput> = {}): ClassifyPendingPurchasePacketInput {
  return {
    db: emptyDb,
    eventDescription: 'Bronx — Stop 31 LLC — PO 151113',
    rows: [rowInput()],
    catalogCandidates: [
      {
        productId: 7001,
        productName: 'Pink Runtz 3.5g Flower',
        brand: 'Runtz',
        category: 'Flower',
        subcategory: 'Packaged Eighth',
        groupName: 'Pink Runtz',
        variantTab: 'Flower',
        strain: 'Pink Runtz',
        size: '3.5g',
        packCount: 1,
      },
    ],
    hintFacts: [hintFact()],
    glossaryEntries: [],
    operatorGuidance: [],
    allowedTaxonomy: { categories: ['Flower'], subcategories: ['Packaged Eighth'] },
    ...overrides,
  }
}

function operatorGuidance(overrides: Partial<ClassifierOperatorGuidance> = {}): ClassifierOperatorGuidance {
  return {
    hintDocumentId: 'pphdoc_2026-07-09_000003_ff00aa',
    sourceLabel: 'operator note',
    // Deliberately uses brand text NOT present in the system prompt, so the
    // "verbatim text stays out of the system prompt" assertion is meaningful.
    text: 'ZX is Zephyr Labs, an existing brand. There should be no new brands created here.',
    ...overrides,
  }
}

// One model draft, with fields a happy classification would produce.
function modelDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rowKey: 'r1',
    distributorProductId: 'echoed-by-model',
    distributorProductName: 'echoed-by-model',
    targetBrand: 'Runtz',
    targetCategory: 'Flower',
    targetSubcategory: 'Packaged Eighth',
    targetGroupName: 'Pink Runtz',
    targetVariantName: 'Pink Runtz 3.5g',
    targetVariantTab: 'Flower',
    targetStrainName: 'Pink Runtz',
    targetSize: '3.5g',
    targetPackCount: 1,
    proposedAction: 'mapping-only',
    reuseProductIdCandidate: 7001,
    reuseEvidence: {
      source: 'live-catalog-search',
      rationale: 'Name and size match the live Pink Runtz eighth.',
      citedHintIds: [VALID_CITED_ID],
    },
    confidence: 90, // percentage — normalized to 0.9
    rationale: 'Decoded the distributor abbreviation to Pink Runtz 3.5g flower.',
    citedHintIds: [VALID_CITED_ID],
    warningFlags: [],
    ...overrides,
  }
}

function modelResponse(body: unknown, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(body) } }],
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 },
  )
}

function stubFetch(response: Response | (() => Response)) {
  // A Response body can only be read once. The classifier's repair loop may
  // fetch several times, so when given a single Response we snapshot its body
  // and hand out a FRESH equivalent Response per call (the function form is
  // simply re-invoked, so it is already fresh).
  let cachedText: string | null = null
  let cachedStatus = 200
  const fetchMock = vi.fn(async () => {
    if (typeof response === 'function') return response()
    if (cachedText === null) {
      cachedText = await response.text()
      cachedStatus = response.status
    }
    return new Response(cachedText, {
      headers: { 'content-type': 'application/json' },
      status: cachedStatus,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  mockEnv.bedrockMantleBearerToken = 'token-test'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('classifyPendingPurchasePacketWithLlm — happy path', () => {
  it('returns validated drafts with provenance and authoritative distributor identity', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft()] }))

    const result = await classifyPendingPurchasePacketWithLlm(buildInput())

    expect(result.schemaVersion).toBe(1)
    expect(result.model).toBe('google.gemma-3-27b-it')
    expect(result.promptVersion).toMatch(/operator-guidance/)
    expect(result.drafts).toHaveLength(1)
    const draft = result.drafts[0]!
    // Distributor identity comes from the INPUT, never the model echo.
    expect(draft.distributorProductId).toBe('dp-1')
    expect(draft.distributorProductName).toBe('1O-8F-R26-PNK')
    // Confidence given as a percentage is normalized to 0..1.
    expect(draft.confidence).toBeCloseTo(0.9)
    expect(draft.reuseProductIdCandidate).toBe(7001)
  })

  it('normalizes blank nullable target strings to null', async () => {
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            proposedAction: 'catalog-create',
            reuseProductIdCandidate: null,
            reuseEvidence: null,
            targetStrainName: '   ',
          }),
        ],
      }),
    )

    const result = await classifyPendingPurchasePacketWithLlm(buildInput())
    expect(result.drafts[0]!.targetStrainName).toBeNull()
  })
})

describe('classifyPendingPurchasePacketWithLlm — fail-loud boundaries', () => {
  it('throws when the Bedrock token is unavailable', async () => {
    mockEnv.bedrockMantleBearerToken = null
    stubFetch(modelResponse({ drafts: [modelDraft()] }))
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toBeInstanceOf(
      PendingPurchaseClassifierError,
    )
  })

  it('throws on a truncated response (finish_reason=length)', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft()] }, 'length'))
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(/truncated/)
  })

  it('throws on non-JSON model content', async () => {
    stubFetch(
      new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] }),
        { status: 200 },
      ),
    )
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(/invalid JSON/)
  })

  it('throws on a schema violation (mapping-only without a candidate)', async () => {
    stubFetch(
      modelResponse({
        drafts: [modelDraft({ proposedAction: 'mapping-only', reuseProductIdCandidate: null, reuseEvidence: null })],
      }),
    )
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(/schema/)
  })

  it('rejects a live-catalog-search reuse id that is not among the catalog candidates', async () => {
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            reuseProductIdCandidate: 999999,
            reuseEvidence: { source: 'live-catalog-search', rationale: 'x', citedHintIds: [] },
          }),
        ],
      }),
    )
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(
      /not among the catalog candidates/,
    )
  })

  it("rejects row B reusing row A's Sweed suggestion (row-scoped candidate)", async () => {
    // Row A is offered Sweed suggestion 8001; row B is offered nothing. Row B
    // must not be allowed to reuse 8001.
    const input = buildInput({
      rows: [
        rowInput({ rowKey: 'r1', sweedSuggestions: [{ productId: 8001, productName: 'A', score: 0.9 }] }),
        rowInput({ rowKey: 'r2', distributorProductId: 'dp-2' }),
      ],
      catalogCandidates: [],
    })
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            rowKey: 'r1',
            proposedAction: 'catalog-create',
            reuseProductIdCandidate: null,
            reuseEvidence: null,
            targetCategory: null,
            targetSubcategory: null,
          }),
          modelDraft({
            rowKey: 'r2',
            targetCategory: null,
            targetSubcategory: null,
            reuseProductIdCandidate: 8001,
            reuseEvidence: { source: 'sweed-suggestion', rationale: 'x', citedHintIds: [] },
          }),
        ],
      }),
    )
    await expect(classifyPendingPurchasePacketWithLlm(input)).rejects.toThrow(
      /not one of this row's Sweed suggestions/,
    )
  })

  it('rejects a current-distributor-link source pointing at a catalog-only id', async () => {
    // Candidate 7001 exists only as a catalog candidate, not as the row's
    // current link, so claiming current-distributor-link is inconsistent.
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            reuseEvidence: { source: 'current-distributor-link', rationale: 'x', citedHintIds: [] },
          }),
        ],
      }),
    )
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(
      /not this row's current link/,
    )
  })

  it('rejects a sibling-po reuse with no cited hint fact', async () => {
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            citedHintIds: [],
            reuseEvidence: { source: 'sibling-po', rationale: 'x', citedHintIds: [] },
          }),
        ],
      }),
    )
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(
      /without citing a hint fact/,
    )
  })

  it('rejects oversized distributor identity on input (would break the output contract)', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft()] }))
    const input = buildInput({ rows: [rowInput({ distributorProductName: 'x'.repeat(501) })] })
    await expect(classifyPendingPurchasePacketWithLlm(input)).rejects.toThrow(/exceeds 500 chars/)
  })

  it('rejects a cited hint id that was not provided', async () => {
    const ghostId = 'pphdoc_2026-06-21_000099_ffffff#f7'
    stubFetch(
      modelResponse({
        drafts: [modelDraft({ citedHintIds: [ghostId], reuseEvidence: { source: 'model-inference', rationale: 'x', citedHintIds: [] } })],
      }),
    )
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(
      /was not provided/,
    )
  })

  it('rejects a target category outside the allowed taxonomy', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft({ targetCategory: 'Concentrates' })] }))
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(
      /not in the allowed taxonomy/,
    )
  })

  it('rejects a draft for an unknown rowKey', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft({ rowKey: 'ghost' })] }))
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(
      /unknown rowKey/,
    )
  })

  it('rejects when a draft for an expected row is missing', async () => {
    const input = buildInput({ rows: [rowInput({ rowKey: 'r1' }), rowInput({ rowKey: 'r2', distributorProductId: 'dp-2' })] })
    stubFetch(modelResponse({ drafts: [modelDraft({ rowKey: 'r1' })] }))
    await expect(classifyPendingPurchasePacketWithLlm(input)).rejects.toThrow(/omitted 1 expected/)
  })

  it('rejects duplicate drafts for the same rowKey', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft(), modelDraft()] }))
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(/duplicate drafts/)
  })
})

describe('classifyPendingPurchasePacketWithLlm — input guards', () => {
  it('throws when there are no rows', async () => {
    stubFetch(modelResponse({ drafts: [] }))
    await expect(classifyPendingPurchasePacketWithLlm(buildInput({ rows: [] }))).rejects.toThrow(
      /at least one row/,
    )
  })

  it('throws on a duplicate input rowKey', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft()] }))
    const input = buildInput({ rows: [rowInput({ rowKey: 'dup' }), rowInput({ rowKey: 'dup', distributorProductId: 'dp-2' })] })
    await expect(classifyPendingPurchasePacketWithLlm(input)).rejects.toThrow(/Duplicate input rowKey/)
  })
})

describe('classifyPendingPurchasePacketWithLlm — glossary evidence (issue #69)', () => {
  it('accepts a draft that cites a glossary entry to decode an abbreviated name', async () => {
    // The model decodes "…-PNK" via the glossary "PNK -> Pink Runtz" and cites
    // the glossary id; reuse still rests on a live-catalog candidate.
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            citedHintIds: [VALID_GLOSSARY_CITED_ID],
            reuseEvidence: {
              source: 'live-catalog-search',
              rationale: 'Glossary expands PNK to Pink Runtz, matching the live eighth.',
              citedHintIds: [VALID_GLOSSARY_CITED_ID],
            },
          }),
        ],
      }),
    )

    const result = await classifyPendingPurchasePacketWithLlm(
      buildInput({ hintFacts: [], glossaryEntries: [glossaryEntry()] }),
    )
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]!.citedHintIds).toContain(VALID_GLOSSARY_CITED_ID)
  })

  it('puts glossaryEntries into the user data payload (not the system prompt)', async () => {
    const fetchMock = stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            citedHintIds: [VALID_GLOSSARY_CITED_ID],
            reuseEvidence: {
              source: 'live-catalog-search',
              rationale: 'x',
              citedHintIds: [VALID_GLOSSARY_CITED_ID],
            },
          }),
        ],
      }),
    )
    await classifyPendingPurchasePacketWithLlm(
      buildInput({ hintFacts: [], glossaryEntries: [glossaryEntry()] }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)
    const [system, user] = body.messages as Array<{ role: string; content: string }>
    // The system prompt describes glossaryEntries but never contains the
    // untrusted expansion text; that travels only in the user data turn.
    expect(system.content).toMatch(/glossaryEntries/)
    expect(system.content).not.toContain('Pink Runtz')
    const payload = JSON.parse(user.content)
    expect(payload.glossaryEntries).toEqual([
      { citedId: VALID_GLOSSARY_CITED_ID, term: 'PNK', expansion: 'Pink Runtz', note: null },
    ])
  })

  it('puts operatorGuidance verbatim in the user data payload (not the system prompt)', async () => {
    const fetchMock = stubFetch(modelResponse({ drafts: [modelDraft()] }))
    await classifyPendingPurchasePacketWithLlm(buildInput({ operatorGuidance: [operatorGuidance()] }))
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)
    const [system, user] = body.messages as Array<{ role: string; content: string }>
    // The system prompt DESCRIBES operatorGuidance and its trust role, but the
    // verbatim operator text travels only in the user data turn.
    expect(system.content).toMatch(/operatorGuidance/)
    expect(system.content).not.toContain('Zephyr Labs')
    const payload = JSON.parse(user.content)
    expect(payload.operatorGuidance).toEqual([
      {
        hintDocumentId: 'pphdoc_2026-07-09_000003_ff00aa',
        sourceLabel: 'operator note',
        text: 'ZX is Zephyr Labs, an existing brand. There should be no new brands created here.',
      },
    ])
  })

  it('system prompt marks operatorGuidance TRUSTED but hintFacts/glossary UNTRUSTED', async () => {
    const fetchMock = stubFetch(modelResponse({ drafts: [modelDraft()] }))
    await classifyPendingPurchasePacketWithLlm(buildInput({ operatorGuidance: [operatorGuidance()] }))
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)
    const [system] = body.messages as Array<{ role: string; content: string }>
    expect(system.content).toMatch(/operatorGuidance.*trusted/i)
    expect(system.content).toMatch(/hintFacts.*UNTRUSTED|UNTRUSTED DATA/)
    // The existing-but-no-candidate guard steering the model to needs-review.
    expect(system.content).toMatch(/needs-review/)
  })

  it('rejects operator guidance that exceeds the total-char budget (fail loud, no truncation)', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft()] }))
    const huge = operatorGuidance({ text: 'x'.repeat(40_001) })
    await expect(
      classifyPendingPurchasePacketWithLlm(buildInput({ operatorGuidance: [huge] })),
    ).rejects.toThrow(/operator guidance is \d+ chars/)
  })

  it('rejects too many operator notes', async () => {
    stubFetch(modelResponse({ drafts: [modelDraft()] }))
    const many = Array.from({ length: 51 }, (_unused, i) =>
      operatorGuidance({ hintDocumentId: `pphdoc_2026-07-09_0000${String(i).padStart(2, '0')}_ff00aa`, text: 'ok' }),
    )
    await expect(
      classifyPendingPurchasePacketWithLlm(buildInput({ operatorGuidance: many })),
    ).rejects.toThrow(/operator notes \(limit/)
  })

  it('rejects a fabricated glossary cited id', async () => {
    const ghostGlossaryId = 'pphdoc_2026-06-21_000001_ab12cd#f9'
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            citedHintIds: [ghostGlossaryId],
            reuseEvidence: { source: 'model-inference', rationale: 'x', citedHintIds: [] },
          }),
        ],
      }),
    )
    await expect(
      classifyPendingPurchasePacketWithLlm(
        buildInput({ hintFacts: [], glossaryEntries: [glossaryEntry()] }),
      ),
    ).rejects.toThrow(/was not provided/)
  })

  it('does NOT let a glossary-only citation prop up a sibling-po reuse claim', async () => {
    // Candidate 7001 is a live-catalog candidate. Claiming sibling-po while
    // citing ONLY glossary evidence must fail: a glossary explains a name, it
    // does not attest the product appeared on a prior PO.
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            citedHintIds: [VALID_GLOSSARY_CITED_ID],
            reuseEvidence: {
              source: 'sibling-po',
              rationale: 'x',
              citedHintIds: [VALID_GLOSSARY_CITED_ID],
            },
          }),
        ],
      }),
    )
    await expect(
      classifyPendingPurchasePacketWithLlm(
        buildInput({ hintFacts: [], glossaryEntries: [glossaryEntry()] }),
      ),
    ).rejects.toThrow(/only glossary evidence/)
  })

  it('does not widen reuse eligibility: a glossary cannot introduce a non-offered candidate', async () => {
    // 999999 is neither a catalog candidate, the current link, nor a Sweed
    // suggestion. A cited glossary entry must not make it reusable.
    stubFetch(
      modelResponse({
        drafts: [
          modelDraft({
            reuseProductIdCandidate: 999999,
            citedHintIds: [VALID_GLOSSARY_CITED_ID],
            reuseEvidence: {
              source: 'model-inference',
              rationale: 'x',
              citedHintIds: [VALID_GLOSSARY_CITED_ID],
            },
          }),
        ],
      }),
    )
    await expect(
      classifyPendingPurchasePacketWithLlm(
        buildInput({ hintFacts: [], glossaryEntries: [glossaryEntry()] }),
      ),
    ).rejects.toThrow(/not offered as a candidate/)
  })

  it('rejects a glossary citedId that collides with a hint-fact citedId', async () => {
    // Same "<doc>#<factId>" would resolve to two different pieces of evidence.
    const colliding: ClassifierGlossaryEntry = { ...glossaryEntry(), citedId: VALID_CITED_ID, factId: 'f1' }
    stubFetch(modelResponse({ drafts: [modelDraft()] }))
    await expect(
      classifyPendingPurchasePacketWithLlm(buildInput({ glossaryEntries: [colliding] })),
    ).rejects.toThrow(/Duplicate hint citedId/)
  })
})

describe('classifyPendingPurchasePacketWithLlm — schema-repair retry', () => {
  // Return a FRESH Response per call (factories, since a body reads once) so we
  // can simulate a bad first reply followed by a corrected one. The last
  // factory is reused if more calls happen than factories provided.
  function stubFetchSequence(responseFactories: Array<() => Response>) {
    let call = 0
    const fetchMock = vi.fn(async () => {
      const factory = responseFactories[Math.min(call, responseFactories.length - 1)]!
      call += 1
      return factory()
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  // fetch is called as fetch(url, { body, ... }); pull the messages array out
  // of the JSON request body for a given call.
  function messagesOf(
    fetchMock: ReturnType<typeof vi.fn>,
    callIndex: number,
  ): Array<{ role: string; content: string }> {
    const options = fetchMock.mock.calls[callIndex]![1] as { body: string }
    return JSON.parse(options.body).messages
  }

  it('recovers from the exact prod failure (invalid source + null rationale) via one repair round-trip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // First reply reproduces prod job 614752: reuseEvidence.source is not in the
    // enum and rationale is null. Second reply is corrected.
    const fetchMock = stubFetchSequence([
      () =>
        modelResponse({
          drafts: [
            modelDraft({
              proposedAction: 'mapping-only',
              reuseProductIdCandidate: 7001,
              reuseEvidence: { source: 'catalog-search', rationale: null, citedHintIds: [] },
            }),
          ],
        }),
      () => modelResponse({ drafts: [modelDraft()] }),
    ])

    const result = await classifyPendingPurchasePacketWithLlm(buildInput())

    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]!.reuseEvidence?.source).toBe('live-catalog-search')
    // Exactly two model calls: the failed one and the repaired one.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The repair turn carries the model's rejected reply + a corrective user
    // message that quotes the validation error.
    const repairMessages = messagesOf(fetchMock, 1)
    expect(repairMessages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(repairMessages[3]!.content).toMatch(/FAILED strict validation/)
    expect(repairMessages[3]!.content).toMatch(/reuseEvidence/)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('fails loud after exhausting the repair budget (initial + 2 repairs = 3 calls)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const badReply = () =>
      modelResponse({
        drafts: [
          modelDraft({
            proposedAction: 'mapping-only',
            reuseProductIdCandidate: 7001,
            reuseEvidence: { source: 'catalog-search', rationale: null, citedHintIds: [] },
          }),
        ],
      })
    const fetchMock = stubFetchSequence([badReply])

    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(
      /after 2 repair attempt\(s\)/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does NOT repair-retry a truncated response (not a fixable near-miss)', async () => {
    const fetchMock = stubFetchSequence([
      () => modelResponse({ drafts: [modelDraft()] }, 'length'),
      () => modelResponse({ drafts: [modelDraft()] }),
    ])
    await expect(classifyPendingPurchasePacketWithLlm(buildInput())).rejects.toThrow(/truncated/)
    // Truncation is fatal on the first call — no repair round-trip.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
