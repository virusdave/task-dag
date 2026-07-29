import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { runCatalogPendingPurchasesRefineJob } from './refinePendingPurchasePacketJob.js'

const mocks = vi.hoisted(() => ({
  callSweedRpc: vi.fn(),
  createCandidate: vi.fn(),
  markFailed: vi.fn(),
  pool: { query: vi.fn() },
  prepare: vi.fn(),
  refine: vi.fn(),
  transaction: {},
}))

vi.mock('../../server/db/pool.js', () => ({ getPool: () => mocks.pool }))
vi.mock('../../server/db/queries/pendingPurchaseRefinementQueries.js', () => ({
  createPendingPurchaseCandidateRevision: mocks.createCandidate,
  markPendingPurchaseRefinementTurnFailed: mocks.markFailed,
  preparePendingPurchaseRefinement: mocks.prepare,
}))
vi.mock('../../server/db/tx.js', () => ({
  withTransaction: (run: (db: object) => Promise<unknown>) => run(mocks.transaction),
}))
vi.mock('../config/env.js', () => ({ getWorkerEnv: () => ({ sweedStateDealerId: 17 }) }))
vi.mock('../pendingPurchases/refinePendingPurchasePacket.js', () => ({
  refinePendingPurchasePacketWithLlm: mocks.refine,
}))
vi.mock('../sweed/rpc.js', () => ({ callSweedRpc: mocks.callSweedRpc }))

const context = {
  id: 44,
  jobType: 'catalog.pending_purchases.refine',
  module: 'catalog',
  payload: { refinementTurnId: 9001, scopeRowLineageIds: ['pprline_501'] },
  scope: null,
} as JobHandlerContext

const prepared = {
  feedbackText: 'Use the offered Pink Runtz product.',
  packetTitle: 'Bronx packet r1',
  rowRefs: [{
    lineageRevisionNumber: 1,
    rowId: 501,
    rowLineageId: 'pprline_501',
    rowSnapshotSha256: 'a'.repeat(64),
    version: 3,
  }],
  rowSnapshot: {
    packetId: 100,
    revisionNumber: 1,
    rows: [{
      distributorProductId: 'dist-1',
      distributorProductName: 'Pink Runtz 3.5g',
      editedStructuredFields: null,
      expectedCategory: 'Flower',
      expectedSubcategory: 'Packaged Eighth',
      rawProvenance: {
        reuseProductId: 7001,
        suggestionCandidates: [
          { productId: 7001, productName: 'Pink Runtz', score: 0.98 },
          { productId: 7002, productName: 'Pink Runtz Reserve', score: 0.92 },
        ],
        validatedReuseSnapshot: { productId: 7001, productName: 'Pink Runtz' },
      },
      rowId: 501,
      rowLineageId: 'pprline_501',
    }],
  },
  rowSnapshotSha256: 'b'.repeat(64),
}

const refinement = {
  degradedProviders: [],
  decisions: [{
    citedContextIds: ['catalog:pprline_501:7001'],
    disposition: 'changed' as const,
    fields: { targetBrand: 'Pink Runtz' },
    rationale: 'Matches the offered product.',
    rowLineageId: 'pprline_501',
    basePacketSnapshotSha256: 'b'.repeat(64),
  }],
  model: 'test-model',
  patches: [{
    basePacketSnapshotSha256: 'b'.repeat(64),
    citedContextIds: ['catalog:pprline_501:7001'],
    fields: { targetReuseProductId: 7001 },
    rationale: 'Matches the offered product.',
    rowLineageId: 'pprline_501',
  }],
  promptVersion: 'test-prompt-v1',
  schemaVersion: 2,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.callSweedRpc.mockResolvedValue([{
    enabled: true,
    name: 'Flower',
    subcategories: [
      { enabled: true, name: 'Packaged Eighth' },
      { enabled: false, name: 'Retired Eighth' },
    ],
  }, {
    enabled: false,
    name: 'Retired Category',
    subcategories: [{ enabled: true, name: 'Retired Product' }],
  }])
  mocks.prepare.mockResolvedValue(prepared)
  mocks.refine.mockResolvedValue(refinement)
  mocks.createCandidate.mockResolvedValue({ candidatePacketId: 101, revisionNumber: 2 })
  mocks.pool.query.mockImplementation(async (text: string) => {
    if (/update job_queue/i.test(text)) return { rows: [] }
    if (/from catalog_group_products/i.test(text)) return { rows: [{ product_id: 7001 }, { product_id: 7002 }] }
    throw new Error(`Unexpected test query: ${text}`)
  })
})

describe('runCatalogPendingPurchasesRefineJob', () => {
  it('calls the strict model with offered candidates, then materializes its validated patches', async () => {
    mocks.refine.mockImplementation(async (input: { onProgress?: (message: string) => Promise<void> }) => {
      await input.onProgress?.('Starting primary analyst test step.')
      await input.onProgress?.('Primary analyst test step finished in 12ms with 1 decision.')
      return refinement
    })
    await runCatalogPendingPurchasesRefineJob(context, { refinementTurnId: 9001, scopeRowLineageIds: ['pprline_501'] })

    expect(mocks.refine).toHaveBeenCalledWith(expect.objectContaining({
      allowedTaxonomy: { categories: ['Flower'], subcategories: ['Packaged Eighth'] },
      contextItems: [{
        contextId: 'catalog:pprline_501:7001',
        data: { productId: 7001, productName: 'Pink Runtz', score: 0.98 },
        priority: 0,
        source: 'catalog',
        targetRowLineageId: 'pprline_501',
      }, {
        contextId: 'catalog:pprline_501:7002',
        data: { productId: 7002, productName: 'Pink Runtz Reserve', score: 0.92 },
        priority: 2,
        source: 'catalog',
        targetRowLineageId: 'pprline_501',
      }],
      db: mocks.pool,
      feedbackText: prepared.feedbackText,
      packetDescription: prepared.packetTitle,
      rows: [expect.objectContaining({
        productIdCandidates: [7001, 7002],
        rowLineageId: 'pprline_501',
      })],
      rowSnapshotSha256: prepared.rowSnapshotSha256,
    }))
    expect(mocks.createCandidate).toHaveBeenCalledWith(mocks.transaction, 9001, refinement)
    expect(mocks.markFailed).not.toHaveBeenCalled()
    const catalogQuery = mocks.pool.query.mock.calls.find(([text]) => /from catalog_group_products/i.test(text))?.[0]
    expect(catalogQuery).toContain("lower(live_product ->> 'enabled') = 'true'")
    expect(catalogQuery).toContain("lower(catalog_group.live_state_json ->> 'enabled') = 'true'")
    expect(catalogQuery).toContain("coalesce(catalog_group.brand_name, '')")
    expect(mocks.callSweedRpc).toHaveBeenCalledWith(17, 'store.product.category.list', {})
    const progressMessages = mocks.pool.query.mock.calls
      .filter(([text]) => /update job_queue/i.test(text))
      .map(([, parameters]) => JSON.parse((parameters as string[])[2]!).message)
    expect(progressMessages).toEqual([
      'Preparing the packet snapshot and refinement scope.',
      expect.stringMatching(/^Preparation finished in .+ with 1 snapshotted row\(s\)\.$/),
      'Loading taxonomy, aliases, and bounded row evidence.',
      expect.stringMatching(/^Scope loading finished in .+ with 1 row\(s\), 2 current catalog item\(s\), 1 categories, and 1 subcategories\.$/),
      'Starting primary analyst test step.',
      'Primary analyst test step finished in 12ms with 1 decision.',
      'Persisting the reviewed candidate and turn provenance.',
      expect.stringMatching(/^Candidate persistence finished in .+; refinement job completed in .+ with 1 changed row\(s\)\.$/),
    ])
    const progressSql = mocks.pool.query.mock.calls.find(([text]) => /update job_queue/i.test(text))?.[0]
    expect(progressSql).toContain('- 99')
  })

  it('preserves the turn as failed when model refinement errors', async () => {
    mocks.refine.mockRejectedValue(new Error('Model output failed strict validation.'))

    await expect(runCatalogPendingPurchasesRefineJob(context, {
      refinementTurnId: 9001,
      scopeRowLineageIds: ['pprline_501'],
    })).rejects.toThrow(
      'The analyst could not produce a safe candidate.',
    )

    expect(mocks.createCandidate).not.toHaveBeenCalled()
    expect(mocks.markFailed).toHaveBeenCalledWith(
      mocks.transaction,
      9001,
      expect.stringContaining('The analyst could not produce a safe candidate.'),
      'unsafe_candidate',
      null,
    )
  })

  it('returns idempotently when another worker already created the candidate', async () => {
    mocks.prepare.mockResolvedValue(null)

    await runCatalogPendingPurchasesRefineJob(context, { refinementTurnId: 9001, scopeRowLineageIds: ['pprline_501'] })

    expect(mocks.pool.query).toHaveBeenCalledTimes(2)
    expect(mocks.refine).not.toHaveBeenCalled()
    expect(mocks.createCandidate).not.toHaveBeenCalled()
  })

  it('preserves a reviewer reuse override while live catalog validation remains authoritative', async () => {
    const sourceRow = prepared.rowSnapshot.rows[0]
    mocks.prepare.mockResolvedValue({
      ...prepared,
      rowSnapshot: {
        ...prepared.rowSnapshot,
        rows: [{
          ...sourceRow,
          editedStructuredFields: { targetReuseProductId: 7001 },
          rawProvenance: {
            ...sourceRow.rawProvenance,
            validatedReuseSnapshot: null,
          },
        }],
      },
    })

    await runCatalogPendingPurchasesRefineJob(context, { refinementTurnId: 9001, scopeRowLineageIds: ['pprline_501'] })

    expect(mocks.refine).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({ productIdCandidates: [7001, 7002] })],
    }))
  })

  it('fails closed when the selected scope is absent from the immutable snapshot', async () => {
    await expect(runCatalogPendingPurchasesRefineJob(context, {
      refinementTurnId: 9001,
      scopeRowLineageIds: ['pprline_missing'],
    })).rejects.toThrow(/packet changed before refinement could finish/i)

    expect(mocks.refine).not.toHaveBeenCalled()
    expect(mocks.markFailed).toHaveBeenCalledWith(
      mocks.transaction,
      9001,
      expect.stringContaining('choose the scope again'),
      'stale_scope',
      null,
    )
  })

  it('classifies missing model configuration without suggesting a smaller scope', async () => {
    mocks.refine.mockRejectedValue(new Error('Bedrock Mantle token unavailable; cannot refine.'))

    await expect(runCatalogPendingPurchasesRefineJob(context, {
      refinementTurnId: 9001,
      scopeRowLineageIds: ['pprline_501'],
    })).rejects.toThrow(/configuration is unavailable/)
    expect(mocks.markFailed).toHaveBeenCalledWith(
      mocks.transaction,
      9001,
      expect.stringContaining('configuration is unavailable'),
      'configuration_unavailable',
      null,
    )
  })

  it('persists bounded attempt provenance when emergency compaction is exhausted', async () => {
    const failure = Object.assign(new Error('The analyst still needs less context. Choose one row and retry.'), {
      attemptProvenance: {
        compactionLevel: 'emergency',
        contextItemCount: 15,
        degradedProviders: ['litalerts-market'],
        estimatedInputTokens: 47_900,
        omittedContextItemCount: 42,
        overflowRetryCount: 1,
      },
    })
    mocks.refine.mockRejectedValue(failure)

    await expect(runCatalogPendingPurchasesRefineJob(context, {
      refinementTurnId: 9001,
      scopeRowLineageIds: ['pprline_501'],
    })).rejects.toThrow(/smaller request/i)
    expect(mocks.markFailed).toHaveBeenCalledWith(
      mocks.transaction,
      9001,
      expect.stringContaining('smaller request'),
      'smaller_scope',
      failure.attemptProvenance,
    )
  })
})
