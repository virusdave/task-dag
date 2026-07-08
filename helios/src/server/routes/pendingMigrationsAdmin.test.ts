// In-process route checks for GET /api/admin/pending-migrations via a bare
// Fastify instance (server.inject) — no DB, no full buildServer() boot.
//
// The route is the server-side admin gate for the pending-migrations page
// (automation#62, leaf 5). We mock requireSessionUser with the REAL role
// hierarchy (hasAtLeastRole) so we exercise the actual gate semantics —
// viewer / editor / approver rejected, admin allowed — and mock the data
// layer (live pending set, eligibility resolver, latest attempts) so the test
// is deterministic and never touches the DB or the filesystem artifact closure.

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

import { hasAtLeastRole } from '../auth/permissions.js'
import type { Role } from '../../shared/contracts/index.js'
import type { MigrationApplyEligibility } from '../db/migrationApplyEligibility.js'
import type { LivePendingMigration } from '../db/pendingMigrations.js'
import type { LatestMigrationApplyAttempt } from '../db/queries/migrationApplyAttemptsQueries.js'

const mockState = vi.hoisted(() => ({
  // The role of the "logged in" user for the next request. `authenticated:
  // false` simulates no session at all (a flat 401 before role checks).
  role: 'admin' as Role,
  authenticated: true,
  userId: 1,
  pending: [] as LivePendingMigration[],
  attempts: new Map<string, LatestMigrationApplyAttempt>(),
  eligibilityById: new Map<string, MigrationApplyEligibility>(),
  // POST-apply mocks (leaf 6).
  appliedLiveById: new Map<string, boolean>(),
  enqueuedJobId: 4242,
}))

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
  // The route passes this straight into the mocked data functions, which
  // ignore it, so a bare sentinel is enough (no real Postgres connection).
  getPool: vi.fn(() => ({}) as unknown),
}))

vi.mock('../db/pendingMigrations.js', () => ({
  listPendingMigrationsLive: vi.fn(async () => mockState.pending),
  isMigrationAppliedLive: vi.fn(
    async (_db: unknown, migrationId: string) => mockState.appliedLiveById.get(migrationId) ?? false,
  ),
}))

vi.mock('../jobs/enqueueJob.js', () => ({
  enqueueJob: vi.fn(async () => mockState.enqueuedJobId),
  JOB_PRIORITY_URGENT: 1000,
}))

vi.mock('../db/queries/migrationApplyAttemptsQueries.js', () => ({
  getLatestMigrationApplyAttemptsByMigrationIds: vi.fn(async () => mockState.attempts),
}))

vi.mock('../db/migrationApplyEligibility.js', () => ({
  resolveMigrationApplyEligibility: vi.fn((migrationId: string) => {
    const found = mockState.eligibilityById.get(migrationId)
    if (found) {
      return found
    }
    return {
      eligible: false,
      migrationId,
      reason: 'not-blessed',
      detail: `Migration ${migrationId} has no Oracle blessing in the registry.`,
      blessing: null,
      artifact: null,
    } satisfies MigrationApplyEligibility
  }),
}))

import { registerPendingMigrationsAdminRoutes } from './pendingMigrationsAdmin.js'
import { isMigrationAppliedLive, listPendingMigrationsLive } from '../db/pendingMigrations.js'
import { getLatestMigrationApplyAttemptsByMigrationIds } from '../db/queries/migrationApplyAttemptsQueries.js'
import { resolveMigrationApplyEligibility } from '../db/migrationApplyEligibility.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

let server: FastifyInstance

beforeEach(async () => {
  mockState.role = 'admin'
  mockState.authenticated = true
  mockState.userId = 1
  mockState.pending = []
  mockState.attempts = new Map()
  mockState.eligibilityById = new Map()
  mockState.appliedLiveById = new Map()
  mockState.enqueuedJobId = 4242
  server = Fastify()
  // Mirror buildServer.ts's global ZodError -> 400 handler so a malformed body
  // is rejected exactly as it is in production (a bare Fastify would 500).
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed.', issues: error.issues })
    }
    const message = error instanceof Error ? error.message : 'Unknown server error.'
    return reply.status(500).send({ error: message })
  })
  await registerPendingMigrationsAdminRoutes(server)
  await server.ready()
})

afterEach(async () => {
  await server.close()
  vi.clearAllMocks()
})

describe('GET /api/admin/pending-migrations auth gate', () => {
  for (const role of ['viewer', 'editor', 'approver'] as const) {
    it(`rejects a ${role} with 403`, async () => {
      mockState.role = role
      mockState.pending = [{ migrationId: '097_x', label: 'x' }]
      const res = await server.inject({ method: 'GET', url: '/api/admin/pending-migrations' })
      expect(res.statusCode).toBe(403)
      // Fail closed: no protected data is read before the gate rejects.
      expect(listPendingMigrationsLive).not.toHaveBeenCalled()
      expect(getLatestMigrationApplyAttemptsByMigrationIds).not.toHaveBeenCalled()
      expect(resolveMigrationApplyEligibility).not.toHaveBeenCalled()
    })
  }

  it('allows an admin with 200', async () => {
    mockState.role = 'admin'
    const res = await server.inject({ method: 'GET', url: '/api/admin/pending-migrations' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ migrations: [] })
  })
})

describe('GET /api/admin/pending-migrations body', () => {
  it('surfaces a blessed+eligible migration with its blessing and matched digest', async () => {
    mockState.pending = [
      { migrationId: '097_litalerts_parse_feedback', label: 'litalerts parse feedback' },
    ]
    // The route never reads `artifact`, so a stubbed digest-only object cast to
    // the eligibility type keeps the fixture focused on the surfaced fields.
    mockState.eligibilityById.set('097_litalerts_parse_feedback', {
      eligible: true,
      migrationId: '097_litalerts_parse_feedback',
      blessing: {
        ref: 'https://ampcode.com/threads/T-abc',
        reviewedSha: 'deadbeef',
        artifactSha256: 'a'.repeat(64),
        transactionMode: 'transactional',
        note: 'wraps its own begin/commit',
      },
      artifact: { sha256: 'a'.repeat(64) },
    } as unknown as MigrationApplyEligibility)
    mockState.attempts.set('097_litalerts_parse_feedback', {
      migrationId: '097_litalerts_parse_feedback',
      jobId: 42,
      state: 'failed',
      error: 'psql exited 3',
      startedAt: '2026-07-08T01:00:00.000Z',
      finishedAt: '2026-07-08T01:00:05.000Z',
      requestedBy: 7,
    })

    const res = await server.inject({ method: 'GET', url: '/api/admin/pending-migrations' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.migrations).toHaveLength(1)
    expect(body.migrations[0]).toEqual({
      migrationId: '097_litalerts_parse_feedback',
      label: 'litalerts parse feedback',
      sentinelState: 'pending',
      eligible: true,
      ineligibleReason: null,
      blessing: {
        ref: 'https://ampcode.com/threads/T-abc',
        note: 'wraps its own begin/commit',
        transactionMode: 'transactional',
      },
      artifactDigestMatch: true,
      lastAttempt: {
        jobId: 42,
        state: 'failed',
        error: 'psql exited 3',
        startedAt: '2026-07-08T01:00:00.000Z',
        finishedAt: '2026-07-08T01:00:05.000Z',
        requestedBy: 7,
      },
    })
  })

  it('reports an unblessed migration as ineligible with no blessing and no digest match', async () => {
    mockState.pending = [{ migrationId: '099_migration_apply_attempts', label: 'attempts table' }]
    // No eligibility override => the mock default returns not-blessed.

    const res = await server.inject({ method: 'GET', url: '/api/admin/pending-migrations' })
    expect(res.statusCode).toBe(200)
    const row = res.json().migrations[0]
    expect(row.eligible).toBe(false)
    expect(row.blessing).toBeNull()
    expect(row.artifactDigestMatch).toBe(false)
    expect(row.ineligibleReason).toContain('no Oracle blessing')
    expect(row.lastAttempt).toBeNull()
  })

  it('reports a digest-mismatch migration as ineligible but still surfaces the blessing', async () => {
    mockState.pending = [{ migrationId: '097_x', label: 'x' }]
    mockState.eligibilityById.set('097_x', {
      eligible: false,
      migrationId: '097_x',
      reason: 'digest-mismatch',
      detail: 'Deployed artifact digest bbb does not match the blessing digest aaa.',
      blessing: {
        ref: 'ref-1',
        reviewedSha: 'sha-1',
        artifactSha256: 'a'.repeat(64),
        transactionMode: 'nontransactional-cic',
      },
      artifact: { sha256: 'b'.repeat(64) },
    } as unknown as MigrationApplyEligibility)

    const res = await server.inject({ method: 'GET', url: '/api/admin/pending-migrations' })
    expect(res.statusCode).toBe(200)
    const row = res.json().migrations[0]
    expect(row.eligible).toBe(false)
    expect(row.artifactDigestMatch).toBe(false)
    expect(row.blessing).toEqual({
      ref: 'ref-1',
      note: null,
      transactionMode: 'nontransactional-cic',
    })
    expect(row.ineligibleReason).toContain('does not match')
  })

  it('sorts rows by migrationId', async () => {
    mockState.pending = [
      { migrationId: '099_z', label: 'z' },
      { migrationId: '043_a', label: 'a' },
      { migrationId: '060_m', label: 'm' },
    ]
    const res = await server.inject({ method: 'GET', url: '/api/admin/pending-migrations' })
    expect(res.statusCode).toBe(200)
    expect(res.json().migrations.map((m: { migrationId: string }) => m.migrationId)).toEqual([
      '043_a',
      '060_m',
      '099_z',
    ])
  })
})

// Helper: register an eligible (blessed + digest-matched) migration in the
// eligibility mock, so the POST path can reach the enqueue step.
function setEligible(migrationId: string, artifactSha256 = 'a'.repeat(64)): void {
  mockState.eligibilityById.set(migrationId, {
    eligible: true,
    migrationId,
    blessing: {
      ref: 'https://ampcode.com/threads/T-abc',
      reviewedSha: 'deadbeef',
      artifactSha256,
      transactionMode: 'transactional',
      note: 'wraps its own begin/commit',
    },
    artifact: { sha256: artifactSha256 },
  } as unknown as MigrationApplyEligibility)
}

const APPLY_URL = (id: string) => `/api/admin/pending-migrations/${id}/apply`

describe('POST /api/admin/pending-migrations/:id/apply auth gate', () => {
  for (const role of ['viewer', 'editor', 'approver'] as const) {
    it(`rejects a ${role} with 403 and never enqueues`, async () => {
      mockState.role = role
      setEligible('097_x')
      const res = await server.inject({
        method: 'POST',
        url: APPLY_URL('097_x'),
        payload: { confirmMigrationId: '097_x' },
      })
      expect(res.statusCode).toBe(403)
      // Fail closed: no eligibility read, no live sentinel, no enqueue.
      expect(resolveMigrationApplyEligibility).not.toHaveBeenCalled()
      expect(isMigrationAppliedLive).not.toHaveBeenCalled()
      expect(enqueueJob).not.toHaveBeenCalled()
    })
  }

  it('rejects an unauthenticated request with 401 and never enqueues', async () => {
    mockState.authenticated = false
    setEligible('097_x')
    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('097_x'),
      payload: { confirmMigrationId: '097_x' },
    })
    expect(res.statusCode).toBe(401)
    expect(resolveMigrationApplyEligibility).not.toHaveBeenCalled()
    expect(isMigrationAppliedLive).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('allows an admin and enqueues an URGENT deduped job', async () => {
    mockState.role = 'admin'
    mockState.userId = 7
    mockState.enqueuedJobId = 555
    setEligible('097_litalerts_parse_feedback')

    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('097_litalerts_parse_feedback'),
      payload: { confirmMigrationId: '097_litalerts_parse_feedback' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ jobId: 555 })
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    const [, input] = (enqueueJob as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(input).toMatchObject({
      jobType: 'db.migration.apply',
      module: 'config',
      priority: 1000,
      dedupeKey: 'migration-apply:097_litalerts_parse_feedback',
      concurrencyKey: 'migration-apply',
      requestedByUserId: 7,
      payload: {
        migrationId: '097_litalerts_parse_feedback',
        requestedByUserId: 7,
        confirmMigrationId: '097_litalerts_parse_feedback',
        blessingArtifactSha256: 'a'.repeat(64),
      },
    })
  })
})

describe('POST /api/admin/pending-migrations/:id/apply validation', () => {
  it('rejects a confirmMigrationId mismatch with 400 and never enqueues', async () => {
    setEligible('097_x')
    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('097_x'),
      payload: { confirmMigrationId: '097_WRONG' },
    })
    expect(res.statusCode).toBe(400)
    // Mismatch is checked before any eligibility / enqueue work.
    expect(resolveMigrationApplyEligibility).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('rejects a malformed body (missing confirmMigrationId) with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('097_x'),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    // Body is parsed before any eligibility / live-sentinel / enqueue work.
    expect(resolveMigrationApplyEligibility).not.toHaveBeenCalled()
    expect(isMigrationAppliedLive).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown migration id', async () => {
    // No eligibility override => the mock default returns not-blessed, but we
    // override with the unknown-migration-id reason for this id.
    mockState.eligibilityById.set('999_nope', {
      eligible: false,
      migrationId: '999_nope',
      reason: 'unknown-migration-id',
      detail: 'migrationId is not in the migration registry: 999_nope',
      blessing: null,
      artifact: null,
    } as unknown as MigrationApplyEligibility)

    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('999_nope'),
      payload: { confirmMigrationId: '999_nope' },
    })
    expect(res.statusCode).toBe(404)
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('returns 409 for an unblessed (ineligible) migration', async () => {
    // Default mock eligibility is not-blessed.
    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('099_migration_apply_attempts'),
      payload: { confirmMigrationId: '099_migration_apply_attempts' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('no Oracle blessing')
    expect(isMigrationAppliedLive).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('returns 409 for an artifact-unresolvable migration', async () => {
    mockState.eligibilityById.set('097_x', {
      eligible: false,
      migrationId: '097_x',
      reason: 'artifact-unresolvable',
      detail: '[ARTIFACT_NOT_FOUND] migration file is missing from the deployed dist root.',
      blessing: {
        ref: 'ref-1',
        reviewedSha: 'sha-1',
        artifactSha256: 'a'.repeat(64),
        transactionMode: 'transactional',
      },
      artifact: null,
    } as unknown as MigrationApplyEligibility)

    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('097_x'),
      payload: { confirmMigrationId: '097_x' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('ARTIFACT_NOT_FOUND')
    expect(isMigrationAppliedLive).not.toHaveBeenCalled()
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('returns 409 for a digest-mismatch migration', async () => {
    mockState.eligibilityById.set('097_x', {
      eligible: false,
      migrationId: '097_x',
      reason: 'digest-mismatch',
      detail: 'Deployed artifact digest bbb does not match the blessing digest aaa.',
      blessing: {
        ref: 'ref-1',
        reviewedSha: 'sha-1',
        artifactSha256: 'a'.repeat(64),
        transactionMode: 'transactional',
      },
      artifact: { sha256: 'b'.repeat(64) },
    } as unknown as MigrationApplyEligibility)

    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('097_x'),
      payload: { confirmMigrationId: '097_x' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('does not match')
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('returns 409 when the migration is already applied (live sentinel)', async () => {
    setEligible('097_x')
    mockState.appliedLiveById.set('097_x', true)

    const res = await server.inject({
      method: 'POST',
      url: APPLY_URL('097_x'),
      payload: { confirmMigrationId: '097_x' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('already applied')
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})
