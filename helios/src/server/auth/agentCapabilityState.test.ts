import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_EMERGENCY_KEY,
  CAPABILITY_GRANT_KEY_PREFIX,
  CAPABILITY_NONCE_KEY,
  InMemoryCapabilityStateStore,
} from './agentCapabilityState.js'

describe('capability state store', () => {
  it('shares grants and emergency ordering across independent users', async () => {
    const store = new InMemoryCapabilityStateStore()
    const first = store
    const second = store
    await first.createGrantUnlessEnabledStateAllows('grant', { signed: true })
    expect(await second.readAdmissionState('grant')).toMatchObject({ grant: { present: true, value: { signed: true } } })
    await second.setEmergencyDisabled(true)
    await expect(first.createGrantUnlessEnabledStateAllows('later', {})).rejects.toThrow('emergency-disabled')
    expect((await first.readAdmissionState('grant')).emergencyDisabled).toBe(true)
  })

  it('linearizes revoke and nonce finalization and consumes one nonce once', async () => {
    const store = new InMemoryCapabilityStateStore()
    await store.createGrantUnlessEnabledStateAllows('grant', {})
    const consume = () => store.finalizeAndConsumeNonce({
      grantId: 'grant', nonceHash: 'a'.repeat(64), now: () => 1_000,
      validate: (state) => { if (!state.grant.present) throw new Error('revoked') },
    })
    expect((await Promise.all([consume(), consume()])).sort()).toEqual(['consumed', 'replay'])
    await store.revokeGrant('grant')
    await expect(consume()).rejects.toThrow('revoked')
  })

  it('denies malformed and oversized stored state without resetting it', async () => {
    const store = new InMemoryCapabilityStateStore()
    store.seed(`${CAPABILITY_GRANT_KEY_PREFIX}large`, { padding: 'x'.repeat(17 * 1024) })
    expect((await store.readAdmissionState('large')).grant).toMatchObject({ present: true, oversized: true })
    store.seed(CAPABILITY_NONCE_KEY, { raw_nonce: 123 })
    store.seed(`${CAPABILITY_GRANT_KEY_PREFIX}grant`, {})
    const result = await store.finalizeAndConsumeNonce({
      grantId: 'grant', nonceHash: 'b'.repeat(64), now: () => 1,
      validate: () => undefined,
    })
    expect(result).toBe('malformed')
    store.seed(CAPABILITY_EMERGENCY_KEY, { malformed: true })
    expect((await store.readAdmissionState('grant')).emergencyDisabled).toBe(true)
  })
})
