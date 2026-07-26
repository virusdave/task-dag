// In-process route checks for the pending-purchase refinement REPL surface.
// These mock the DB/job/audit layers and exercise the REST contracts end to
// end with server.inject(): feedback submission, stale snapshot conflicts,
// accept/rollback, and server-side apply gating for non-current revisions.

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

import { hasAtLeastRole } from '../auth/permissions.js'
import type {
  PendingPurchasePacketSummary,
  PendingPurchasePacketRevisionSummary,
  PendingPurchasePacketRootSummary,
  PendingPurchaseRefinementTurnSummary,
  PendingPurchaseRevisionRowDiff,
  PendingPurchaseRowSnapshotRef,
  Role,
} from '../../shared/contracts/index.js'

const mockState = vi.hoisted(() => {
  class PendingPurchaseRefinementConflictError extends Error {}
  return {
    role: 'approver' as Role,
    authenticated: true,
    userId: 9,
    tx: { query: vi.fn() },
    pool: { query: vi.fn() },
    enqueuedJobId: 4242,
    auditEventId: 8080,
    schemaAvailable: true,
    storedFeedbackText: null as string | null,
    snapshot: null as null | {
      packetTitle: string
      root: PendingPurchasePacketRootSummary
      rowRefs: PendingPurchaseRowSnapshotRef[]
      rowSnapshot: Record<string, unknown>
      rowSnapshotSha256: string
      targetPacketId: number
      targetRevisionNumber: number
    },
    turn: null as null | PendingPurchaseRefinementTurnSummary,
    prepared: null as null | {
      feedbackText: string
      packetTitle: string
      rowRefs: PendingPurchaseRowSnapshotRef[]
      rowSnapshot: Record<string, unknown>
      rowSnapshotSha256: string
    },
    candidateRevision: null as PendingPurchasePacketRevisionSummary | null,
    history: null as null | {
      currentRevision: PendingPurchasePacketRevisionSummary | null
      revisions: PendingPurchasePacketRevisionSummary[]
      root: PendingPurchasePacketRootSummary | null
      rowDiffs: PendingPurchaseRevisionRowDiff[]
      turns: PendingPurchaseRefinementTurnSummary[]
    },
    applyGateError: null as null | Error,
    activePacket: null as PendingPurchasePacketSummary | null,
    overrideOptions: null as null | {
      brands: string[]
      categories: string[]
      subcategories: string[]
    },
    pendingPurchaseRows: [] as Array<{
      approval_status: string
      distributor_product_name: string
      id: number
      last_apply_status: string
      packet_id: number
      target_brand: string | null
      version: number
    }>,
    PendingPurchaseRefinementConflictError,
  }
})

vi.mock('../auth/requireSession.js', () => ({
  requireSessionUser: vi.fn(
    async (
      _request: unknown,
      reply: { status: (n: number) => { send: (b: unknown) => void } },
      minimumRole: Role = 'viewer',
    ) => {
      if (!mockState.authenticated) {
        reply.status(401).send({ error: 'Authentication required.' })
        return null
      }
      if (!hasAtLeastRole(mockState.role, minimumRole)) {
        reply.status(403).send({ error: 'You do not have permission to perform this action.' })
        return null
      }
      return { id: mockState.userId, role: mockState.role }
    },
  ),
}))

vi.mock('../db/pool.js', () => ({
  getPool: vi.fn(() => mockState.pool),
}))

vi.mock('../db/tx.js', () => ({
  withTransaction: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(mockState.tx)),
}))

vi.mock('../jobs/enqueueJob.js', () => ({
  JOB_PRIORITY_LIVE_REQUESTED: 100,
  enqueueJob: vi.fn(async () => mockState.enqueuedJobId),
}))

vi.mock('../audit/appendAuditEvent.js', () => ({
  appendAuditEvent: vi.fn(async () => mockState.auditEventId),
}))

vi.mock('../db/queries/jobQueries.js', () => ({
  getJobStatus: vi.fn(async () => null),
}))

vi.mock('../db/queries/catalogQueries.js', () => ({
  loadCatalogStructuredOverrideFacets: vi.fn(async () => mockState.overrideOptions),
  mergeCatalogBrandOptions: (catalogBrands: readonly string[], liveBrandNames: readonly string[]) => {
    const names = new Map<string, string>()
    for (const name of catalogBrands) names.set(name.toLowerCase(), name)
    for (const name of liveBrandNames) names.set(name.toLowerCase(), name)
    return [...names.values()].sort((left, right) => left.localeCompare(right))
  },
}))

vi.mock('../db/queries/pendingPurchaseQueries.js', () => ({
  getLatestPendingPurchaseApplyRequest: vi.fn(async () => null),
  getPendingPurchasePacketSummary: vi.fn(async () => mockState.activePacket),
  listPendingPurchaseEtlComparisonRows: vi.fn(async () => []),
  listPendingPurchasePacketListPage: vi.fn(async () => ({ items: [], totalCount: 0 })),
  listPendingPurchaseRows: vi.fn(async () => []),
  readPendingPurchaseLiveBrandNames: (summary: unknown) => {
    if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return []
    const classifier = (summary as { classifier?: unknown }).classifier
    if (classifier === null || typeof classifier !== 'object' || Array.isArray(classifier)) return []
    const names = (classifier as { liveBrandNames?: unknown }).liveBrandNames
    return Array.isArray(names) && names.every((name) => typeof name === 'string') ? names : []
  },
}))

vi.mock('../db/queries/pendingPurchaseRefinementQueries.js', () => ({
  PendingPurchaseRefinementConflictError: mockState.PendingPurchaseRefinementConflictError,
  assertBaseRowsMatchSnapshot: vi.fn(() => undefined),
  assertPendingPurchasePacketApplyable: vi.fn(async (_db: unknown, packetId: number) => {
    if (mockState.applyGateError) throw mockState.applyGateError
    const revision = mockState.history?.revisions.find((item) => item.packetId === packetId)
    if (
      !revision ||
      mockState.history?.root?.currentPacketId !== packetId ||
      revision.revisionStatus !== 'current' ||
      !revision.isApplyable
    ) {
      throw new mockState.PendingPurchaseRefinementConflictError(
        'Only the current applyable packet revision can be applied.',
      )
    }
  }),
  lockPendingPurchasePacketRootForApply: vi.fn(async () => undefined),
  attachJobToPendingPurchaseRefinementTurn: vi.fn(async (_db: unknown, turnId: number, jobId: number) => {
    if (mockState.turn?.turnId === turnId) mockState.turn = { ...mockState.turn, jobId }
  }),
  createPendingPurchaseCandidateRevision: vi.fn(async (
    _db: unknown,
    turnId: number,
    refinement: { model: string; patches: Array<{ fields: Record<string, unknown>; rowLineageId: string }>; promptVersion: string },
  ) => {
    if (!mockState.turn || mockState.turn.turnId !== turnId || !mockState.candidateRevision || !mockState.history) {
      throw new Error('In-process refinement test state is incomplete.')
    }
    const baseRow = mockState.pendingPurchaseRows.find((row) => row.packet_id === mockState.turn?.targetPacketId)
    const patch = refinement.patches.find((item) => item.rowLineageId === 'pprline_501')
    if (!baseRow || !patch) throw new Error('In-process refinement patch did not target the stored row.')
    const candidateRow = {
      ...baseRow,
      approval_status: 'pending',
      id: 601,
      last_apply_status: 'not_requested',
      packet_id: mockState.candidateRevision.packetId,
      target_brand: typeof patch.fields.targetBrand === 'string' ? patch.fields.targetBrand : baseRow.target_brand,
      version: 1,
    }
    mockState.pendingPurchaseRows.push(candidateRow)
    mockState.turn = {
      ...mockState.turn,
      candidatePacketId: mockState.candidateRevision.packetId,
      finishedAt: '2026-07-09T15:06:00.000Z',
      model: refinement.model,
      promptVersion: refinement.promptVersion,
      startedAt: '2026-07-09T15:02:00.000Z',
      status: 'candidate_created',
      updatedAt: '2026-07-09T15:06:00.000Z',
    }
    mockState.history.revisions.push(mockState.candidateRevision)
    mockState.history.turns = [mockState.turn]
    mockState.history.rowDiffs = baseRow.target_brand === candidateRow.target_brand ? [] : [{
        after: candidateRow.target_brand,
        before: baseRow.target_brand,
        candidateRowId: 601,
        field: 'targetBrand',
        parentRowId: 501,
        rowLineageId: 'pprline_501',
      }]
    return { candidatePacketId: mockState.candidateRevision.packetId, revisionNumber: 2 }
  }),
  createPendingPurchaseRefinementTurn: vi.fn(async (_db: unknown, input: {
    expectedRootVersion: number
    feedbackText: string
    packetId: number
    packetRootId: number
    rowSnapshot: Record<string, unknown>
    rowSnapshotSha256: string
    targetRevisionNumber: number
  }) => {
    if (!mockState.turn || !mockState.snapshot) throw new Error('Expected the refinement submission fixture.')
    mockState.storedFeedbackText = input.feedbackText
    mockState.turn = {
      ...mockState.turn,
      packetRootId: input.packetRootId,
      rowSnapshotSha256: input.rowSnapshotSha256,
      targetPacketId: input.packetId,
      targetRevisionNumber: input.targetRevisionNumber,
      targetRootVersion: input.expectedRootVersion,
    }
    mockState.prepared = {
      feedbackText: input.feedbackText,
      packetTitle: mockState.snapshot.packetTitle,
      rowRefs: mockState.snapshot.rowRefs,
      rowSnapshot: input.rowSnapshot,
      rowSnapshotSha256: input.rowSnapshotSha256,
    }
    if (mockState.history) mockState.history.turns = [mockState.turn]
    return mockState.turn
  }),
  isPendingPurchaseRefinementSchemaAvailable: vi.fn(async () => mockState.schemaAvailable),
  listPendingPurchaseRefinementHistory: vi.fn(async () => mockState.history ?? ({
    currentRevision: null, revisions: [], root: null, rowDiffs: [], turns: [],
  })),
  loadPendingPurchaseRefinementSnapshot: vi.fn(async () => mockState.snapshot),
  markPendingPurchaseRefinementTurnFailed: vi.fn(async (_db: unknown, turnId: number, errorMessage: string) => {
    if (mockState.turn?.turnId === turnId) {
      mockState.turn = {
        ...mockState.turn,
        errorMessage,
        finishedAt: '2026-07-09T15:06:00.000Z',
        status: 'failed',
        updatedAt: '2026-07-09T15:06:00.000Z',
      }
      if (mockState.history) mockState.history.turns = [mockState.turn]
    }
  }),
  preparePendingPurchaseRefinement: vi.fn(async () => {
    if (!mockState.turn || !mockState.history?.root || !mockState.prepared) {
      throw new Error('In-process refinement test state is incomplete.')
    }
    if (mockState.turn.targetRootVersion !== mockState.history.root.version) {
      throw new mockState.PendingPurchaseRefinementConflictError(
        'Target packet snapshot is stale. Submit feedback against the current revision.',
      )
    }
    return mockState.prepared
  }),
  switchPendingPurchaseCurrentRevision: vi.fn(async (
    _db: unknown,
    input: { expectedRootVersion: number; selectedPacketId: number; userId: number },
  ) => {
    const history = mockState.history
    const root = history?.root
    const selected = history?.revisions.find((revision) => revision.packetId === input.selectedPacketId)
    if (!history || !root || !selected || root.version !== input.expectedRootVersion) {
      throw new mockState.PendingPurchaseRefinementConflictError('This packet revision changed. Refresh and try again.')
    }
    const previousCurrentRevision = history.currentRevision
    history.revisions = history.revisions.map((revision) => revision.packetId === selected.packetId
      ? {
          ...revision,
          acceptedAt: '2026-07-09T15:10:00.000Z',
          acceptedByUser: 'Operator',
          isApplyable: true,
          revisionStatus: 'current' as const,
        }
      : revision.revisionStatus === 'current'
        ? { ...revision, isApplyable: false, revisionStatus: 'superseded' as const }
        : revision)
    history.root = {
      ...root,
      currentPacketId: selected.packetId,
      currentRevisionNumber: selected.revisionNumber,
      version: root.version + 1,
    }
    history.currentRevision = history.revisions.find((revision) => revision.packetId === selected.packetId) ?? null
    return { previousCurrentRevision, root: history.root, selectedRevision: history.currentRevision }
  }),
}))

vi.mock('../../worker/pendingPurchases/refinePendingPurchasePacket.js', () => ({
  refinePendingPurchasePacketWithLlm: vi.fn(),
}))

vi.mock('../db/queries/pendingPurchaseHintQueries.js', () => {
  class HintBundleMutationError extends Error {
    code: 'bundle_archived' | 'bundle_not_found'
    constructor(code: 'bundle_archived' | 'bundle_not_found', message: string) {
      super(message)
      this.code = code
    }
  }
  return {
    HintBundleMutationError,
    addPendingPurchaseHintDocument: vi.fn(),
    createPendingPurchaseHintBundle: vi.fn(),
    deletePendingPurchaseHintDocument: vi.fn(),
    getPendingPurchaseHintBundle: vi.fn(async () => null),
    getPendingPurchaseHintBundleDetail: vi.fn(async () => null),
    getPendingPurchaseHintDocumentPointer: vi.fn(async () => null),
    listPendingPurchaseHintBundles: vi.fn(async () => []),
    updatePendingPurchaseHintBundle: vi.fn(async () => null),
  }
})

vi.mock('../pendingPurchases/hintContent.js', () => ({
  normalizeHintText: vi.fn((text: string) => text.trim()),
}))

vi.mock('../pendingPurchases/pendingPurchaseHintStore.js', () => ({
  HINT_BLOB_CONTENT_TYPE: 'text/plain',
  getHintDocumentStore: vi.fn(() => ({ put: vi.fn() })),
}))

vi.mock('../db/queries/pendingPurchaseParserQueries.js', () => ({
  insertPendingPurchaseParseObservation: vi.fn(async () => undefined),
  normalizePendingPurchaseParserText: vi.fn((text: string) => text.trim().toLowerCase()),
  updatePendingPurchaseParseRuleFeedback: vi.fn(async () => undefined),
}))

vi.mock('../jobs/concurrency.js', () => ({
  getOptionalSweedSessionConcurrencyKey: vi.fn(() => 'sweed-session'),
}))

vi.mock('../../worker/sweed/rpc.js', () => ({
  callSweedRpc: vi.fn(),
}))

vi.mock('../../worker/sweed/session.js', () => ({
  withSweedSession: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

import { registerPendingPurchaseRoutes } from './pendingPurchases.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { enqueueJob } from '../jobs/enqueueJob.js'
import { listPendingPurchaseRows } from '../db/queries/pendingPurchaseQueries.js'
import {
  assertBaseRowsMatchSnapshot,
  assertPendingPurchasePacketApplyable,
  attachJobToPendingPurchaseRefinementTurn,
  createPendingPurchaseCandidateRevision,
  createPendingPurchaseRefinementTurn,
  lockPendingPurchasePacketRootForApply,
  markPendingPurchaseRefinementTurnFailed,
  preparePendingPurchaseRefinement,
  switchPendingPurchaseCurrentRevision,
} from '../db/queries/pendingPurchaseRefinementQueries.js'
import { runCatalogPendingPurchasesRefineJob } from '../../worker/jobs/refinePendingPurchasePacketJob.js'
import { refinePendingPurchasePacketWithLlm } from '../../worker/pendingPurchases/refinePendingPurchasePacket.js'

let server: FastifyInstance

const baseRows: PendingPurchaseRowSnapshotRef[] = [{
  lineageRevisionNumber: 1,
  rowId: 501,
  rowLineageId: 'pprline_501',
  rowSnapshotSha256: 'a'.repeat(64),
  version: 3,
}]

const refinementRowSnapshot = {
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
}

const root: PendingPurchasePacketRootSummary = {
  currentPacketId: 100,
  currentRevisionNumber: 1,
  packetRootId: 77,
  rootKey: 'pprroot_100',
  rootStatus: 'active',
  updatedAt: '2026-07-09T15:00:00.000Z',
  version: 4,
}

const currentRevision: PendingPurchasePacketRevisionSummary = {
  acceptedAt: '2026-07-09T15:00:00.000Z',
  acceptedByUser: 'Operator',
  createdAt: '2026-07-09T14:00:00.000Z',
  isApplyable: true,
  packetId: 100,
  packetRootId: 77,
  packetTitle: 'Bronx packet r1',
  parentPacketId: null,
  revisionCreatedReason: null,
  revisionNumber: 1,
  revisionStatus: 'current',
  sourceRefinementTurnId: null,
  updatedAt: '2026-07-09T15:00:00.000Z',
}

const candidateRevision: PendingPurchasePacketRevisionSummary = {
  ...currentRevision,
  acceptedAt: null,
  acceptedByUser: null,
  createdAt: '2026-07-09T15:05:00.000Z',
  isApplyable: false,
  packetId: 101,
  packetTitle: 'Bronx packet r2',
  parentPacketId: 100,
  revisionNumber: 2,
  revisionStatus: 'candidate',
  sourceRefinementTurnId: 9001,
}

function capturedRefinementJobPayload(): { refinementTurnId: number } {
  const refineEnqueue = vi.mocked(enqueueJob).mock.calls.find(([, input]) =>
    input.jobType === 'catalog.pending_purchases.refine',
  )
  if (!refineEnqueue) throw new Error('Expected a queued pending-purchase refinement job.')
  return refineEnqueue[1].payload as { refinementTurnId: number }
}

beforeEach(async () => {
  mockState.role = 'approver'
  mockState.authenticated = true
  mockState.userId = 9
  mockState.enqueuedJobId = 4242
  mockState.auditEventId = 8080
  mockState.schemaAvailable = true
  mockState.applyGateError = null
  mockState.activePacket = null
  mockState.overrideOptions = null
  mockState.storedFeedbackText = null
  mockState.pool.query.mockReset()
  mockState.tx.query.mockReset()
  mockState.tx.query.mockImplementation(async (text: string, values?: readonly unknown[]) => {
    if (/from pending_purchase_rows/i.test(text)) {
      const requestedId = typeof values?.[0] === 'number' && /where id = \$1/i.test(text) ? values[0] : null
      const requestedPacketId = typeof values?.[0] === 'number' && /where packet_id = \$1/i.test(text) ? values[0] : null
      const rows = mockState.pendingPurchaseRows.filter((row) =>
        (requestedId === null || row.id === requestedId) &&
        (requestedPacketId === null || row.packet_id === requestedPacketId),
      )
      return { command: 'SELECT', fields: [], oid: 0, rowCount: rows.length, rows }
    }
    if (/insert into pending_purchase_apply_requests/i.test(text)) {
      return { command: 'INSERT', fields: [], oid: 0, rowCount: 1, rows: [{ id: 7001 }] }
    }
    if (/set approval_status = \$2/i.test(text) && typeof values?.[0] === 'number') {
      const row = mockState.pendingPurchaseRows.find((item) => item.id === values[0])
      if (row && typeof values[1] === 'string' && typeof values[3] === 'number') {
        row.approval_status = values[1]
        row.version = values[3]
      }
    }
    return { command: 'UPDATE', fields: [], oid: 0, rowCount: 1, rows: [] }
  })
  mockState.pendingPurchaseRows = [{
    approval_status: 'approved',
    distributor_product_name: 'Pink Runtz 3.5g',
    id: 501,
    last_apply_status: 'not_requested',
    packet_id: 100,
    target_brand: 'Wrong Brand',
    version: 3,
  }]
  mockState.snapshot = {
    packetTitle: 'Bronx packet r1',
    root,
    rowRefs: baseRows,
    rowSnapshot: refinementRowSnapshot,
    rowSnapshotSha256: 'b'.repeat(64),
    targetPacketId: 100,
    targetRevisionNumber: 1,
  }
  mockState.turn = {
    candidatePacketId: null,
    createdAt: '2026-07-09T15:01:00.000Z',
    errorMessage: null,
    feedbackSha256: 'c'.repeat(64),
    finishedAt: null,
    jobId: null,
    model: null,
    packetRootId: 77,
    promptVersion: null,
    requestedByUser: 'Operator',
    rowSnapshotSha256: 'b'.repeat(64),
    startedAt: null,
    status: 'queued',
    targetPacketId: 100,
    targetRevisionNumber: 1,
    targetRootVersion: 4,
    turnId: 9001,
    updatedAt: '2026-07-09T15:01:00.000Z',
  }
  mockState.prepared = {
    feedbackText: 'All Pink Runtz rows should map to the existing 3.5g flower product.',
    packetTitle: 'Bronx packet r1',
    rowRefs: baseRows,
    rowSnapshot: refinementRowSnapshot,
    rowSnapshotSha256: 'b'.repeat(64),
  }
  mockState.candidateRevision = candidateRevision
  mockState.history = {
    currentRevision,
    revisions: [currentRevision],
    root,
    rowDiffs: [],
    turns: [],
  }
  vi.clearAllMocks()
  mockState.pool.query.mockImplementation(async (text: string) => {
    if (/from job_queue jq/i.test(text)) return { rows: [] }
    if (/select distinct category_name/i.test(text)) return { rows: [{ value: 'Flower' }] }
    if (/select distinct subcategory_name/i.test(text)) return { rows: [{ value: 'Packaged Eighth' }] }
    if (/from catalog_group_products/i.test(text)) return { rows: [{ product_id: 7001 }] }
    throw new Error(`Unexpected in-process test query: ${text}`)
  })
  vi.mocked(refinePendingPurchasePacketWithLlm).mockResolvedValue({
    model: 'test-model',
    patches: [{
      basePacketSnapshotSha256: 'b'.repeat(64),
      citedContextIds: ['catalog:pprline_501:7001'],
      fields: { targetBrand: 'Runtz' },
      rationale: 'The feedback and offered catalog product identify Pink Runtz.',
      rowLineageId: 'pprline_501',
    }],
    promptVersion: 'test-prompt-v1',
    schemaVersion: 1,
  })
  server = Fastify()
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed.', issues: error.issues })
    }
    const message = error instanceof Error ? error.message : 'Unknown server error.'
    return reply.status(500).send({ error: message })
  })
  await registerPendingPurchaseRoutes(server)
  await server.ready()
})

afterEach(async () => {
  await server.close()
})

describe('pending-purchase rows route live brand options', () => {
  const packet = (summary: PendingPurchasePacketSummary['summary']): PendingPurchasePacketSummary => ({
    createdAt: '2026-07-25T14:14:01.421Z',
    generatedAt: '2026-07-25T14:14:01.421Z',
    hasEtlDetails: true,
    hintBundleId: null,
    importFileName: null,
    operatorNoteDocuments: [],
    packetId: 77,
    packetTitle: 'Pending purchase packet 77',
    rowCount: 0,
    siteKeys: ['midtown'],
    siteLabels: ['Midtown'],
    source: 'generated',
    sourcePath: null,
    stateContext: {},
    status: 'ready',
    summary,
    updatedAt: '2026-07-25T14:14:01.421Z',
  })

  it('adds the requested packet live brand shells to override options', async () => {
    mockState.activePacket = packet({ classifier: { liveBrandNames: ['Dabbar', 'Slappz'] } })
    mockState.overrideOptions = {
      brands: ['DABBAR', 'Hashtag Honey'],
      categories: ['Vapes'],
      subcategories: ['All In One / Disposable'],
    }
    const response = await server.inject({
      method: 'GET',
      url: '/api/catalog/pending-purchases?mode=rows&packetId=77',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().overrideOptions.brands).toEqual(['Dabbar', 'Hashtag Honey', 'Slappz'])
    expect(listPendingPurchaseRows).toHaveBeenCalledWith(mockState.pool, 77, ['Dabbar', 'Slappz'])
  })

  it('leaves legacy packet options catalog-only', async () => {
    mockState.activePacket = packet({ classifier: {} })
    mockState.overrideOptions = {
      brands: ['Hashtag Honey'],
      categories: ['Edibles'],
      subcategories: [],
    }
    const response = await server.inject({
      method: 'GET',
      url: '/api/catalog/pending-purchases?mode=rows&packetId=77',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().overrideOptions.brands).toEqual(['Hashtag Honey'])
    expect(listPendingPurchaseRows).toHaveBeenCalledWith(mockState.pool, 77, [])
  })
})

describe('pending-purchase refinement feedback route', () => {
  it('queues a refinement turn from feedback, snapshots rows, attaches the job, and audits the submission', async () => {
    const res = await server.inject({
      method: 'POST',
      payload: {
        baseRows,
        expectedRootVersion: 4,
        feedbackText: 'All Pink Runtz rows should map to the existing 3.5g flower product.',
        scopeRowLineageIds: ['pprline_501'],
      },
      url: '/api/catalog/pending-purchases/100/refinements',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().turn).toMatchObject({ jobId: 4242, status: 'queued', turnId: 9001 })
    expect(assertBaseRowsMatchSnapshot).toHaveBeenCalledWith(baseRows, baseRows)
    expect(createPendingPurchaseRefinementTurn).toHaveBeenCalledWith(mockState.tx, expect.objectContaining({
      expectedRootVersion: 4,
      feedbackText: 'All Pink Runtz rows should map to the existing 3.5g flower product.',
      packetId: 100,
      packetRootId: 77,
      rowSnapshotSha256: 'b'.repeat(64),
      targetRevisionNumber: 1,
    }))
    expect(enqueueJob).toHaveBeenCalledWith(mockState.tx, expect.objectContaining({
      concurrencyKey: 'catalog.pending_purchases.refine:77',
      dedupeKey: 'catalog.pending_purchases.refine:9001',
      jobType: 'catalog.pending_purchases.refine',
      payload: { refinementTurnId: 9001, requestedByUserId: 9, scopeRowLineageIds: ['pprline_501'] },
    }))
    expect(attachJobToPendingPurchaseRefinementTurn).toHaveBeenCalledWith(mockState.tx, 9001, 4242)
    expect(appendAuditEvent).toHaveBeenCalledWith(mockState.tx, expect.objectContaining({
      entityId: '9001',
      entityType: 'pending_purchase_refinement_turn',
      eventType: 'pending_purchase.refinement.submitted',
    }))
  })

  it('rejects stale feedback snapshots before creating a turn or job', async () => {
    mockState.snapshot = mockState.snapshot && {
      ...mockState.snapshot,
      root: { ...mockState.snapshot.root, version: 5 },
    }

    const res = await server.inject({
      method: 'POST',
      payload: {
        baseRows,
        expectedRootVersion: 4,
        feedbackText: 'This feedback was typed on an old packet view.',
        scopeRowLineageIds: ['pprline_501'],
      },
      url: '/api/catalog/pending-purchases/100/refinements',
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('changed since the refinement form loaded')
    expect(createPendingPurchaseRefinementTurn).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})

describe('pending-purchase refinement REPL in-process integration', () => {
  it('runs feedback through the worker, exposes candidate history and diff, then gates apply until acceptance', async () => {
    const feedbackText = 'All Pink Runtz rows should map to the existing 3.5g flower product.'
    const submitted = await server.inject({
      method: 'POST',
      payload: { baseRows, expectedRootVersion: 4, feedbackText, scopeRowLineageIds: ['pprline_501'] },
      url: '/api/catalog/pending-purchases/100/refinements',
    })

    expect(submitted.statusCode).toBe(200)
    expect(submitted.json().turn).toMatchObject({ jobId: 4242, status: 'queued', turnId: 9001 })

    const queuedPayload = capturedRefinementJobPayload()
    await runCatalogPendingPurchasesRefineJob(
      {
        id: 4242,
        jobType: 'catalog.pending_purchases.refine',
        module: 'catalog',
        payload: queuedPayload,
        scope: null,
      },
      queuedPayload,
    )

    expect(preparePendingPurchaseRefinement).toHaveBeenCalledWith(mockState.tx, 9001)
    expect(refinePendingPurchasePacketWithLlm).toHaveBeenCalledWith(expect.objectContaining({
      feedbackText,
      rowSnapshotSha256: 'b'.repeat(64),
      rows: [expect.objectContaining({ rowLineageId: 'pprline_501' })],
    }))
    expect(createPendingPurchaseCandidateRevision).toHaveBeenCalledWith(
      mockState.tx,
      9001,
      expect.objectContaining({ model: 'test-model' }),
    )

    const history = await server.inject({
      method: 'GET',
      url: '/api/catalog/pending-purchases/101/refinement-history',
    })
    expect(history.statusCode).toBe(200)
    expect(history.json()).toMatchObject({
      currentRevision: { packetId: 100 },
      revisions: [{ packetId: 100 }, { isApplyable: false, packetId: 101, revisionStatus: 'candidate' }],
      rowDiffs: [{ after: 'Runtz', before: 'Wrong Brand', field: 'targetBrand', rowLineageId: 'pprline_501' }],
      turns: [{ candidatePacketId: 101, status: 'candidate_created', turnId: 9001 }],
    })

    const candidateApply = await server.inject({
      method: 'POST',
      payload: { packetId: 101, rowIds: [601], reason: 'candidate apply attempt' },
      url: '/api/catalog/pending-purchases/apply',
    })
    expect(candidateApply.statusCode).toBe(409)
    expect(enqueueJob).toHaveBeenCalledTimes(1)

    const accepted = await server.inject({
      method: 'POST',
      payload: { expectedRootVersion: 4, reason: 'candidate reviewed' },
      url: '/api/catalog/pending-purchases/100/revisions/101/accept',
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({
      root: { currentPacketId: 101, version: 5 },
      selectedRevision: { isApplyable: true, packetId: 101, revisionStatus: 'current' },
    })

    const approved = await server.inject({
      method: 'POST',
      payload: { approvalStatus: 'approved', expectedVersion: 1 },
      url: '/api/catalog/pending-purchases/601/approval',
    })
    expect(approved.statusCode).toBe(200)
    expect(mockState.pendingPurchaseRows.find((row) => row.id === 601)).toMatchObject({
      approval_status: 'approved',
      version: 2,
    })
    const acceptedApply = await server.inject({
      method: 'POST',
      payload: { packetId: 101, rowIds: [601], reason: 'accepted candidate apply' },
      url: '/api/catalog/pending-purchases/apply',
    })
    expect(acceptedApply.statusCode).toBe(200)
    expect(acceptedApply.json()).toMatchObject({ jobId: 4242 })
  })

  it('marks a stale worker turn failed without calling the model or changing the current packet', async () => {
    const feedbackText = 'Keep this exact feedback available after the stale turn fails.'
    const submitted = await server.inject({
      method: 'POST',
      payload: { baseRows, expectedRootVersion: 4, feedbackText, scopeRowLineageIds: ['pprline_501'] },
      url: '/api/catalog/pending-purchases/100/refinements',
    })
    expect(submitted.statusCode).toBe(200)

    if (!mockState.history?.root) throw new Error('Expected the refinement root fixture.')
    mockState.history.root = { ...mockState.history.root, version: 5 }
    const queuedPayload = capturedRefinementJobPayload()
    await expect(runCatalogPendingPurchasesRefineJob(
      {
        id: 4242,
        jobType: 'catalog.pending_purchases.refine',
        module: 'catalog',
        payload: queuedPayload,
        scope: null,
      },
      queuedPayload,
    )).rejects.toThrow(/packet changed before refinement could finish/)

    expect(refinePendingPurchasePacketWithLlm).not.toHaveBeenCalled()
    expect(markPendingPurchaseRefinementTurnFailed).toHaveBeenCalledWith(
      mockState.tx,
      9001,
      expect.stringMatching(/packet changed before refinement could finish/),
      'stale_scope',
      null,
    )
    expect(mockState.storedFeedbackText).toBe(feedbackText)
    expect(mockState.history).toMatchObject({
      currentRevision: { packetId: 100 },
      revisions: [{ packetId: 100 }],
      turns: [{ candidatePacketId: null, status: 'failed' }],
    })
    const history = await server.inject({
      method: 'GET',
      url: '/api/catalog/pending-purchases/100/refinement-history',
    })
    expect(history.json()).toMatchObject({
      currentRevision: { packetId: 100 },
      revisions: [{ packetId: 100 }],
      turns: [{ candidatePacketId: null, status: 'failed' }],
    })
  })

  it('preserves failed-model feedback and history without creating a candidate', async () => {
    const feedbackText = 'Retry this feedback after the model recovers.'
    const submitted = await server.inject({
      method: 'POST',
      payload: { baseRows, expectedRootVersion: 4, feedbackText, scopeRowLineageIds: ['pprline_501'] },
      url: '/api/catalog/pending-purchases/100/refinements',
    })
    expect(submitted.statusCode).toBe(200)
    vi.mocked(refinePendingPurchasePacketWithLlm).mockRejectedValueOnce(
      new Error('Model output failed strict validation.'),
    )

    const queuedPayload = capturedRefinementJobPayload()
    await expect(runCatalogPendingPurchasesRefineJob(
      {
        id: 4242,
        jobType: 'catalog.pending_purchases.refine',
        module: 'catalog',
        payload: queuedPayload,
        scope: null,
      },
      queuedPayload,
    )).rejects.toThrow('The analyst could not produce a safe candidate.')

    expect(createPendingPurchaseCandidateRevision).not.toHaveBeenCalled()
    expect(mockState.storedFeedbackText).toBe(feedbackText)
    expect(mockState.history).toMatchObject({
      currentRevision: { packetId: 100 },
      revisions: [{ packetId: 100 }],
      turns: [{ candidatePacketId: null, errorMessage: expect.stringContaining('safe candidate'), status: 'failed' }],
    })
    const history = await server.inject({
      method: 'GET',
      url: '/api/catalog/pending-purchases/100/refinement-history',
    })
    expect(history.json()).toMatchObject({
      currentRevision: { packetId: 100 },
      revisions: [{ packetId: 100 }],
      turns: [{ errorMessage: expect.stringContaining('safe candidate'), status: 'failed' }],
    })
  })
})

describe('pending-purchase revision switching and apply gating routes', () => {
  it('accepts a candidate revision transactionally through the revision switch helper', async () => {
    if (!mockState.history) throw new Error('Expected the refinement history fixture.')
    mockState.history.revisions.push(candidateRevision)

    const res = await server.inject({
      method: 'POST',
      payload: { expectedRootVersion: 4, reason: 'candidate looked right' },
      url: '/api/catalog/pending-purchases/100/revisions/101/accept',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().selectedRevision.packetId).toBe(101)
    expect(switchPendingPurchaseCurrentRevision).toHaveBeenCalledWith(mockState.tx, {
      expectedRootVersion: 4,
      packetId: 100,
      reason: 'candidate looked right',
      selectedPacketId: 101,
      userId: 9,
    })
    expect(appendAuditEvent).toHaveBeenCalledWith(mockState.tx, expect.objectContaining({
      eventType: 'pending_purchase.revision.accepted',
      entityId: '101',
    }))
  })

  it('rolls back by switching current to an earlier safe revision', async () => {
    mockState.history = {
      currentRevision: { ...candidateRevision, isApplyable: true, revisionStatus: 'current' },
      revisions: [
        { ...currentRevision, isApplyable: false, revisionStatus: 'superseded' },
        { ...candidateRevision, isApplyable: true, revisionStatus: 'current' },
      ],
      root: { ...root, currentPacketId: 101, currentRevisionNumber: 2, version: 5 },
      rowDiffs: [],
      turns: [],
    }

    const res = await server.inject({
      method: 'POST',
      payload: { expectedRootVersion: 5, reason: 'rollback after review' },
      url: '/api/catalog/pending-purchases/101/revisions/100/rollback',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().selectedRevision.packetId).toBe(100)
    expect(switchPendingPurchaseCurrentRevision).toHaveBeenCalledWith(mockState.tx, expect.objectContaining({
      expectedRootVersion: 5,
      packetId: 101,
      selectedPacketId: 100,
    }))
    expect(appendAuditEvent).toHaveBeenCalledWith(mockState.tx, expect.objectContaining({
      eventType: 'pending_purchase.revision.rolled_back',
      entityId: '100',
    }))
  })

  it('rejects apply for non-current or candidate revisions before row locks/jobs', async () => {
    mockState.applyGateError = new mockState.PendingPurchaseRefinementConflictError(
      'Only the current applyable packet revision can be applied.',
    )

    const res = await server.inject({
      method: 'POST',
      payload: { packetId: 101, rowIds: [501], reason: 'candidate apply attempt' },
      url: '/api/catalog/pending-purchases/apply',
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('Only the current applyable packet revision')
    expect(assertPendingPurchasePacketApplyable).toHaveBeenCalledWith(mockState.tx, 101)
    expect(vi.mocked(lockPendingPurchasePacketRootForApply).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(assertPendingPurchasePacketApplyable).mock.invocationCallOrder[0]!,
    )
    expect(mockState.tx.query).not.toHaveBeenCalledWith(expect.stringMatching(/from pending_purchase_rows/i), expect.anything())
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})
