import type { FastifyRequest } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Role, SessionUser } from '../../shared/contracts/index.js'

const mocks = vi.hoisted(() => ({
  getPendingMigrations: vi.fn(),
  getUserById: vi.fn(),
  userId: null as number | null,
}))

vi.mock('../config/env.js', () => ({
  getServerEnv: () => ({ nodeEnv: 'production' }),
  isGoogleOAuthReady: () => true,
}))
vi.mock('../runtime/dependencyStatus.js', () => ({
  buildRuntimeDependencyStatuses: () => [],
}))
vi.mock('../db/pool.js', () => ({ getPool: () => ({}) }))
vi.mock('../db/pendingMigrations.js', () => ({
  getPendingMigrations: mocks.getPendingMigrations,
}))
vi.mock('../db/queries/authQueries.js', () => ({ getUserById: mocks.getUserById }))
vi.mock('./sessionCookie.js', () => ({ readSessionUserId: () => mocks.userId }))

import { buildSessionEnvelope } from './requireSession.js'

function user(role: Role, active = true): SessionUser {
  return {
    active,
    email: `${role}@example.com`,
    id: 1,
    metricGrants: [],
    name: `${role} user`,
    role,
  }
}

function request(agentReadonlyPrincipal: object | null = null): FastifyRequest {
  return { agentReadonlyPrincipal } as unknown as FastifyRequest
}

describe('buildSessionEnvelope pending migration visibility', () => {
  beforeEach(() => {
    mocks.userId = null
    mocks.getPendingMigrations.mockReset()
    mocks.getPendingMigrations.mockResolvedValue([
      { migrationId: '099', label: 'Operator-only migration' },
    ])
    mocks.getUserById.mockReset()
  })

  it('loads and returns pending migrations only for an active admin', async () => {
    mocks.userId = 1
    mocks.getUserById.mockResolvedValue(user('admin'))
    const envelope = await buildSessionEnvelope(request())
    expect(envelope.pendingMigrations).toEqual([
      { migrationId: '099', label: 'Operator-only migration' },
    ])
    expect(mocks.getPendingMigrations).toHaveBeenCalledOnce()
  })

  it.each(['viewer', 'editor', 'approver'] as const)(
    'does not query or expose pending migrations for an active %s',
    async (role) => {
      mocks.userId = 1
      mocks.getUserById.mockResolvedValue(user(role))
      const envelope = await buildSessionEnvelope(request())
      expect(envelope.pendingMigrations).toEqual([])
      expect(mocks.getPendingMigrations).not.toHaveBeenCalled()
    },
  )

  it('does not query for anonymous, inactive, or agent-readonly sessions', async () => {
    expect((await buildSessionEnvelope(request())).pendingMigrations).toEqual([])

    mocks.userId = 1
    mocks.getUserById.mockResolvedValue(user('admin', false))
    expect((await buildSessionEnvelope(request())).pendingMigrations).toEqual([])

    expect((await buildSessionEnvelope(request({ kind: 'agent_readonly' }))).pendingMigrations).toEqual([])
    expect(mocks.getPendingMigrations).not.toHaveBeenCalled()
  })
})
