import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { runCatalogPendingPurchasesRefineJob } from './refinePendingPurchasePacketJob.js'

const mocks = vi.hoisted(() => ({
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
vi.mock('../pendingPurchases/refinePendingPurchasePacket.js', () => ({
  refinePendingPurchasePacketWithLlm: mocks.refine,
}))

const context = {
  id: 44,
  jobType: 'catalog.pending_purchases.refine',
  module: 'catalog',
  payload: { refinementTurnId: 9001 },
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
        suggestionCandidates: [{ productId: 7001, productName: 'Pink Runtz', score: 0.98 }],
        validatedReuseSnapshot: { productId: 7001, productName: 'Pink Runtz' },
      },
      rowId: 501,
      rowLineageId: 'pprline_501',
    }],
  },
  rowSnapshotSha256: 'b'.repeat(64),
}

const refinement = {
  model: 'test-model',
  patches: [{
    basePacketSnapshotSha256: 'b'.repeat(64),
    citedContextIds: ['catalog:pprline_501:7001'],
    fields: { targetReuseProductId: 7001 },
    rationale: 'Matches the offered product.',
    rowLineageId: 'pprline_501',
  }],
  promptVersion: 'test-prompt-v1',
  schemaVersion: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prepare.mockResolvedValue(prepared)
  mocks.refine.mockResolvedValue(refinement)
  mocks.createCandidate.mockResolvedValue({ candidatePacketId: 101, revisionNumber: 2 })
  mocks.pool.query.mockImplementation(async (text: string) => {
    if (/select distinct category_name/i.test(text)) return { rows: [{ value: 'Flower' }] }
    if (/select distinct subcategory_name/i.test(text)) return { rows: [{ value: 'Packaged Eighth' }] }
    if (/from catalog_group_products/i.test(text)) return { rows: [{ product_id: 7001 }] }
    throw new Error(`Unexpected test query: ${text}`)
  })
})

describe('runCatalogPendingPurchasesRefineJob', () => {
  it('calls the strict model with offered candidates, then materializes its validated patches', async () => {
    await runCatalogPendingPurchasesRefineJob(context, { refinementTurnId: 9001 })

    expect(mocks.refine).toHaveBeenCalledWith(expect.objectContaining({
      allowedTaxonomy: { categories: ['Flower'], subcategories: ['Packaged Eighth'] },
      contextItems: [{
        contextId: 'catalog:pprline_501:7001',
        data: { productId: 7001, productName: 'Pink Runtz', score: 0.98 },
        source: 'catalog',
      }],
      db: mocks.pool,
      feedbackText: prepared.feedbackText,
      packetDescription: prepared.packetTitle,
      rows: [expect.objectContaining({
        productIdCandidates: [7001],
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
    const taxonomyQuery = mocks.pool.query.mock.calls.find(([text]) => /select distinct category_name/i.test(text))?.[0]
    expect(taxonomyQuery).toContain("lower(live_state_json ->> 'enabled') = 'true'")
    expect(taxonomyQuery).toContain("coalesce(group_name, '')")
    expect(taxonomyQuery).toContain("coalesce(brand_name, '')")
  })

  it('preserves the turn as failed when model refinement errors', async () => {
    mocks.refine.mockRejectedValue(new Error('Model output failed strict validation.'))

    await expect(runCatalogPendingPurchasesRefineJob(context, { refinementTurnId: 9001 })).rejects.toThrow(
      'Model output failed strict validation.',
    )

    expect(mocks.createCandidate).not.toHaveBeenCalled()
    expect(mocks.markFailed).toHaveBeenCalledWith(mocks.transaction, 9001, 'Model output failed strict validation.')
  })

  it('returns idempotently when another worker already created the candidate', async () => {
    mocks.prepare.mockResolvedValue(null)

    await runCatalogPendingPurchasesRefineJob(context, { refinementTurnId: 9001 })

    expect(mocks.pool.query).not.toHaveBeenCalled()
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

    await runCatalogPendingPurchasesRefineJob(context, { refinementTurnId: 9001 })

    expect(mocks.refine).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({ productIdCandidates: [7001] })],
    }))
  })
})
