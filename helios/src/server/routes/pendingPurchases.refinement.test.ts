// In-process route checks for the pending-purchase refinement REPL surface.
// These mock the DB/job/audit layers and exercise the REST contracts end to
// end with server.inject(): feedback submission, stale snapshot conflicts,
// accept/rollback, and server-side apply gating for non-current revisions.

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

import { hasAtLeastRole } from '../auth/permissions.js'
import type {
  PendingPurchasePacketRevisionSummary,
  PendingPurchasePacketRootSummary,
  PendingPurchaseRefinementTurnSummary,
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
    switched: null as null | {
      previousCurrentRevision: PendingPurchasePacketRevisionSummary | null
      root: PendingPurchasePacketRootSummary
      selectedRevision: PendingPurchasePacketRevisionSummary
    },
    applyGateError: null as null | Error,
    pendingPurchaseRows: [] as Array<{ id: number; packet_id: number; distributor_product_name: string; approval_status: string; last_apply_status: string }>,
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
  loadCatalogStructuredOverrideFacets: vi.fn(async () => null),
}))

vi.mock('../db/queries/pendingPurchaseQueries.js', () => ({
  getLatestPendingPurchaseApplyRequest: vi.fn(async () => null),
  getPendingPurchasePacketSummary: vi.fn(async () => null),
  listPendingPurchaseEtlComparisonRows: vi.fn(async () => []),
  listPendingPurchasePacketListPage: vi.fn(async () => ({ items: [], totalCount: 0 })),
  listPendingPurchaseRows: vi.fn(async () => []),
}))

vi.mock('../db/queries/pendingPurchaseRefinementQueries.js', () => ({
  PendingPurchaseRefinementConflictError: mockState.PendingPurchaseRefinementConflictError,
  assertBaseRowsMatchSnapshot: vi.fn(() => undefined),
  assertPendingPurchasePacketApplyable: vi.fn(async () => {
    if (mockState.applyGateError) throw mockState.applyGateError
  }),
  attachJobToPendingPurchaseRefinementTurn: vi.fn(async () => undefined),
  createPendingPurchaseRefinementTurn: vi.fn(async () => mockState.turn),
  isPendingPurchaseRefinementSchemaAvailable: vi.fn(async () => mockState.schemaAvailable),
  listPendingPurchaseRefinementHistory: vi.fn(async () => ({
    currentRevision: null,
    revisions: [],
    root: null,
    rowDiffs: [],
    turns: [],
  })),
  loadPendingPurchaseRefinementSnapshot: vi.fn(async () => mockState.snapshot),
  switchPendingPurchaseCurrentRevision: vi.fn(async () => mockState.switched),
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
import {
  assertBaseRowsMatchSnapshot,
  assertPendingPurchasePacketApplyable,
  attachJobToPendingPurchaseRefinementTurn,
  createPendingPurchaseRefinementTurn,
  switchPendingPurchaseCurrentRevision,
} from '../db/queries/pendingPurchaseRefinementQueries.js'

let server: FastifyInstance

const baseRows: PendingPurchaseRowSnapshotRef[] = [{
  lineageRevisionNumber: 1,
  rowId: 501,
  rowLineageId: 'pprline_501',
  rowSnapshotSha256: 'a'.repeat(64),
  version: 3,
}]

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

beforeEach(async () => {
  mockState.role = 'approver'
  mockState.authenticated = true
  mockState.userId = 9
  mockState.enqueuedJobId = 4242
  mockState.auditEventId = 8080
  mockState.schemaAvailable = true
  mockState.applyGateError = null
  mockState.pool.query.mockReset()
  mockState.tx.query.mockReset()
  mockState.tx.query.mockImplementation(async (text: string) => {
    if (/from pending_purchase_rows/i.test(text)) {
      return { command: 'SELECT', fields: [], oid: 0, rowCount: mockState.pendingPurchaseRows.length, rows: mockState.pendingPurchaseRows }
    }
    if (/insert into pending_purchase_apply_requests/i.test(text)) {
      return { command: 'INSERT', fields: [], oid: 0, rowCount: 1, rows: [{ id: 7001 }] }
    }
    return { command: 'UPDATE', fields: [], oid: 0, rowCount: 1, rows: [] }
  })
  mockState.pendingPurchaseRows = [{
    approval_status: 'approved',
    distributor_product_name: 'Pink Runtz 3.5g',
    id: 501,
    last_apply_status: 'not_requested',
    packet_id: 100,
  }]
  mockState.snapshot = {
    packetTitle: 'Bronx packet r1',
    root,
    rowRefs: baseRows,
    rowSnapshot: { rows: [{ rowId: 501 }] },
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
  mockState.switched = {
    previousCurrentRevision: currentRevision,
    root: { ...root, currentPacketId: 101, currentRevisionNumber: 2, version: 5 },
    selectedRevision: { ...candidateRevision, acceptedAt: '2026-07-09T15:10:00.000Z', acceptedByUser: 'Operator', isApplyable: true, revisionStatus: 'current' },
  }
  vi.clearAllMocks()
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

describe('pending-purchase refinement feedback route', () => {
  it('queues a refinement turn from feedback, snapshots rows, attaches the job, and audits the submission', async () => {
    const res = await server.inject({
      method: 'POST',
      payload: {
        baseRows,
        expectedRootVersion: 4,
        feedbackText: 'All Pink Runtz rows should map to the existing 3.5g flower product.',
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
      payload: { refinementTurnId: 9001, requestedByUserId: 9 },
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
      },
      url: '/api/catalog/pending-purchases/100/refinements',
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('changed since the refinement form loaded')
    expect(createPendingPurchaseRefinementTurn).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})

describe('pending-purchase revision switching and apply gating routes', () => {
  it('accepts a candidate revision transactionally through the revision switch helper', async () => {
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
    mockState.switched = {
      previousCurrentRevision: candidateRevision,
      root: { ...root, currentPacketId: 100, currentRevisionNumber: 1, version: 6 },
      selectedRevision: currentRevision,
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
    expect(mockState.tx.query).not.toHaveBeenCalledWith(expect.stringMatching(/from pending_purchase_rows/i), expect.anything())
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})
