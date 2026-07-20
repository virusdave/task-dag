import { afterAll, beforeAll, expect, it } from 'vitest'

import { closePool, getPool } from '../db/pool.js'
import { describeRequiresTestDb } from '../__tests__/requiresTestDb.js'
import {
  CAPABILITY_EMERGENCY_KEY,
  CAPABILITY_GRANT_KEY_PREFIX,
  CAPABILITY_NONCE_KEY,
  PostgresCapabilityStateStore,
} from './agentCapabilityState.js'

const GRANT_ID = '019f7f00-0000-7000-8000-000000000001'
const RESERVED_KEYS = [
  `${CAPABILITY_GRANT_KEY_PREFIX}${GRANT_ID}`,
  CAPABILITY_EMERGENCY_KEY,
  CAPABILITY_NONCE_KEY,
]
let isolatedDatabaseValidated = false

describeRequiresTestDb('Postgres capability state store', () => {
  beforeAll(async () => {
    requireIsolatedTestDatabase()
    isolatedDatabaseValidated = true
    await getPool().query('delete from app_settings where key = any($1::text[])', [RESERVED_KEYS])
  })

  afterAll(async () => {
    if (!isolatedDatabaseValidated) return
    await getPool().query('delete from app_settings where key = any($1::text[])', [RESERVED_KEYS])
    await closePool()
  })

  it('shares immutable grants, emergency state, and nonce admission across store instances', async () => {
    const first = new PostgresCapabilityStateStore()
    const second = new PostgresCapabilityStateStore()
    const envelope = { shape: { grant_id: GRANT_ID }, signed: true }

    await first.createGrantUnlessEnabledStateAllows(GRANT_ID, envelope)
    expect(await second.readAdmissionState(GRANT_ID)).toMatchObject({
      emergencyDisabled: false,
      grant: { present: true, oversized: false, value: envelope },
    })
    await expect(second.createGrantUnlessEnabledStateAllows(GRANT_ID, envelope))
      .rejects.toThrow('already exists')

    const consume = () => first.finalizeAndConsumeNonce({
      grantId: GRANT_ID,
      nonceHash: 'a'.repeat(64),
      now: () => 1_000,
      validate: (state) => {
        if (!state.grant.present || state.emergencyDisabled) throw new Error('not admissible')
      },
    })
    expect((await Promise.all([consume(), second.finalizeAndConsumeNonce({
      grantId: GRANT_ID,
      nonceHash: 'a'.repeat(64),
      now: () => 1_000,
      validate: () => undefined,
    })])).sort()).toEqual(['consumed', 'replay'])

    await second.setEmergencyDisabled(true)
    expect((await first.readAdmissionState(GRANT_ID)).emergencyDisabled).toBe(true)
    await expect(first.createGrantUnlessEnabledStateAllows(
      '019f7f00-0000-7000-8000-000000000002',
      envelope,
    )).rejects.toThrow('emergency-disabled')
    await second.setEmergencyDisabled(false)
    await first.revokeGrant(GRANT_ID)
    expect((await second.readAdmissionState(GRANT_ID)).grant.present).toBe(false)
  })
})

function requireIsolatedTestDatabase(): void {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Capability state DB tests require an explicit isolated DATABASE_URL.')
  const url = new URL(raw)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (!loopback || url.pathname !== '/helios_test' || url.search !== '') {
    throw new Error('Capability state DB tests refuse non-loopback, non-helios_test, or query-overridden databases.')
  }
}
