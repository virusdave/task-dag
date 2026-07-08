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

import { hasAtLeastRole } from '../auth/permissions.js'
import type { Role } from '../../shared/contracts/index.js'
import type { MigrationApplyEligibility } from '../db/migrationApplyEligibility.js'
import type { LivePendingMigration } from '../db/pendingMigrations.js'
import type { LatestMigrationApplyAttempt } from '../db/queries/migrationApplyAttemptsQueries.js'

const mockState = vi.hoisted(() => ({
  // The role of the "logged in" user for the next request.
  role: 'admin' as Role,
  pending: [] as LivePendingMigration[],
  attempts: new Map<string, LatestMigrationApplyAttempt>(),
  eligibilityById: new Map<string, MigrationApplyEligibility>(),
}))

vi.mock('../auth/requireSession.js', () => ({
  requireSessionUser: vi.fn(
    async (
      _request: unknown,
      reply: { status: (n: number) => { send: (b: unknown) => void } },
      minimumRole: Role = 'viewer',
    ) => {
      if (!hasAtLeastRole(mockState.role, minimumRole)) {
        reply.status(403).send({ error: 'You do not have permission to perform this action.' })
        return null
      }
      return { id: 1, role: mockState.role }
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
import { listPendingMigrationsLive } from '../db/pendingMigrations.js'
import { getLatestMigrationApplyAttemptsByMigrationIds } from '../db/queries/migrationApplyAttemptsQueries.js'
import { resolveMigrationApplyEligibility } from '../db/migrationApplyEligibility.js'

let server: FastifyInstance

beforeEach(async () => {
  mockState.role = 'admin'
  mockState.pending = []
  mockState.attempts = new Map()
  mockState.eligibilityById = new Map()
  server = Fastify()
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
