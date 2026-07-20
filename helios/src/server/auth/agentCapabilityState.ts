import { getPool, type Queryable } from '../db/pool.js'
import { withTransaction } from '../db/tx.js'

export const CAPABILITY_GRANT_KEY_PREFIX = 'signed_agent_capability_grant:'
export const CAPABILITY_EMERGENCY_KEY = 'signed_agent_capability_emergency_disabled'
export const CAPABILITY_NONCE_KEY = 'signed_agent_capability_nonce_registry'
export const CAPABILITY_ENVELOPE_MAX_BYTES = 16 * 1024
export const CAPABILITY_NONCE_LIMIT = 128
export const CAPABILITY_NONCE_TTL_MS = 3 * 60 * 1000
const LOCK_NAME = 'helios:signed-agent-capability-state:v1'

export interface StoredCapabilityValue {
  present: boolean
  oversized: boolean
  value?: unknown
}

export interface CapabilityAdmissionState {
  emergencyDisabled: boolean
  grant: StoredCapabilityValue
}

export interface CapabilityStateStore {
  readAdmissionState(grantId: string): Promise<CapabilityAdmissionState>
  createGrantUnlessEnabledStateAllows(grantId: string, envelope: unknown): Promise<void>
  revokeGrant(grantId: string): Promise<void>
  setEmergencyDisabled(disabled: boolean): Promise<void>
  finalizeAndConsumeNonce(input: {
    grantId: string
    nonceHash: string
    now: () => number
    validate: (state: CapabilityAdmissionState, nowMs: number) => void
  }): Promise<'consumed' | 'replay' | 'capacity' | 'malformed'>
}

interface ValueRow { present: boolean; oversized: boolean; value: unknown | null }

export class PostgresCapabilityStateStore implements CapabilityStateStore {
  async readAdmissionState(grantId: string): Promise<CapabilityAdmissionState> {
    return readAdmission(getPool(), grantId)
  }

  async createGrantUnlessEnabledStateAllows(grantId: string, envelope: unknown): Promise<void> {
    await withTransaction(async (client) => {
      await lock(client)
      if ((await readAdmission(client, grantId)).emergencyDisabled) throw new Error('Capability grants are emergency-disabled.')
      const result = await client.query(
        `insert into app_settings (key, value, updated_by) values ($1, $2::jsonb, 'signed-agent-capability') on conflict do nothing`,
        [grantKey(grantId), JSON.stringify(envelope)],
      )
      if (result.rowCount !== 1) throw new Error('Capability grant already exists.')
    })
  }

  async revokeGrant(grantId: string): Promise<void> {
    await withTransaction(async (client) => {
      await lock(client)
      const result = await client.query('delete from app_settings where key = $1', [grantKey(grantId)])
      if (result.rowCount !== 1) throw new Error('Capability grant does not exist.')
    })
  }

  async setEmergencyDisabled(disabled: boolean): Promise<void> {
    await withTransaction(async (client) => {
      await lock(client)
      if (disabled) {
        await client.query(`insert into app_settings (key, value, updated_by) values ($1, 'true'::jsonb, 'signed-agent-capability') on conflict (key) do nothing`, [CAPABILITY_EMERGENCY_KEY])
      } else {
        await client.query('delete from app_settings where key = $1', [CAPABILITY_EMERGENCY_KEY])
      }
    })
  }

  async finalizeAndConsumeNonce(input: Parameters<CapabilityStateStore['finalizeAndConsumeNonce']>[0]): Promise<'consumed' | 'replay' | 'capacity' | 'malformed'> {
    return withTransaction(async (client) => {
      await lock(client)
      const nowMs = input.now()
      const state = await readAdmission(client, input.grantId)
      input.validate(state, nowMs)
      const row = await readValue(client, CAPABILITY_NONCE_KEY)
      let registry: Record<string, number> = {}
      if (row.present) {
        if (row.oversized || !isNonceRegistry(row.value)) return 'malformed'
        registry = row.value
      }
      const live = Object.fromEntries(Object.entries(registry).filter(([, expiry]) => expiry > nowMs))
      if (live[input.nonceHash] !== undefined) return 'replay'
      if (Object.keys(live).length >= CAPABILITY_NONCE_LIMIT) return 'capacity'
      live[input.nonceHash] = nowMs + CAPABILITY_NONCE_TTL_MS
      await client.query(
        `insert into app_settings (key, value, updated_by) values ($1, $2::jsonb, 'signed-agent-capability')
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [CAPABILITY_NONCE_KEY, JSON.stringify(live)],
      )
      return 'consumed'
    })
  }
}

export class InMemoryCapabilityStateStore implements CapabilityStateStore {
  private readonly values = new Map<string, unknown>()
  private queue: Promise<void> = Promise.resolve()

  seed(key: string, value: unknown): void { this.values.set(key, value) }
  async readAdmissionState(grantId: string): Promise<CapabilityAdmissionState> { return this.admission(grantId) }
  createGrantUnlessEnabledStateAllows(grantId: string, envelope: unknown): Promise<void> { return this.serial(() => {
    if (this.values.has(CAPABILITY_EMERGENCY_KEY)) throw new Error('Capability grants are emergency-disabled.')
    const key = grantKey(grantId); if (this.values.has(key)) throw new Error('Capability grant already exists.')
    this.values.set(key, envelope)
  }) }
  revokeGrant(grantId: string): Promise<void> { return this.serial(() => {
    if (!this.values.delete(grantKey(grantId))) throw new Error('Capability grant does not exist.')
  }) }
  setEmergencyDisabled(disabled: boolean): Promise<void> { return this.serial(() => {
    if (disabled) this.values.set(CAPABILITY_EMERGENCY_KEY, true); else this.values.delete(CAPABILITY_EMERGENCY_KEY)
  }) }
  finalizeAndConsumeNonce(input: Parameters<CapabilityStateStore['finalizeAndConsumeNonce']>[0]): Promise<'consumed' | 'replay' | 'capacity' | 'malformed'> {
    return this.serial(() => {
      const nowMs = input.now()
      input.validate(this.admission(input.grantId), nowMs)
      const raw = this.values.get(CAPABILITY_NONCE_KEY)
      if (raw !== undefined && !isNonceRegistry(raw)) return 'malformed'
      const live = Object.fromEntries(Object.entries(raw ?? {}).filter(([, expiry]) => expiry > nowMs))
      if (live[input.nonceHash] !== undefined) return 'replay'
      if (Object.keys(live).length >= CAPABILITY_NONCE_LIMIT) return 'capacity'
      live[input.nonceHash] = nowMs + CAPABILITY_NONCE_TTL_MS; this.values.set(CAPABILITY_NONCE_KEY, live); return 'consumed'
    })
  }
  private admission(grantId: string): CapabilityAdmissionState {
    const key = grantKey(grantId); const value = this.values.get(key)
    const oversized = value !== undefined && Buffer.byteLength(JSON.stringify(value), 'utf8') > CAPABILITY_ENVELOPE_MAX_BYTES
    return { emergencyDisabled: this.values.has(CAPABILITY_EMERGENCY_KEY), grant: { present: value !== undefined, oversized, ...(oversized ? {} : { value }) } }
  }
  private serial<T>(run: () => T): Promise<T> {
    const result = this.queue.then(run, run); this.queue = result.then(() => undefined, () => undefined); return result
  }
}

function grantKey(grantId: string): string { return `${CAPABILITY_GRANT_KEY_PREFIX}${grantId}` }
async function lock(db: Queryable): Promise<void> {
  // One transaction-scoped lock linearizes every mutation/finalization across hot mirrors.
  await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [LOCK_NAME])
}
async function readAdmission(db: Queryable, grantId: string): Promise<CapabilityAdmissionState> {
  const emergency = await readValue(db, CAPABILITY_EMERGENCY_KEY)
  const grant = await readValue(db, grantKey(grantId))
  return { emergencyDisabled: emergency.present, grant }
}
async function readValue(db: Queryable, key: string): Promise<StoredCapabilityValue> {
  const result = await db.query<ValueRow>(
    `select true as present, pg_column_size(value) > $2 or octet_length(value::text) > $2 as oversized,
            case when pg_column_size(value) <= $2 and octet_length(value::text) <= $2 then value else null end as value
       from app_settings where key = $1`, [key, CAPABILITY_ENVELOPE_MAX_BYTES],
  )
  const row = result.rows[0]
  return row ? { present: true, oversized: row.oversized, ...(row.oversized ? {} : { value: row.value }) } : { present: false, oversized: false }
}
function isNonceRegistry(value: unknown): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.entries(value).every(([key, expiry]) => /^[0-9a-f]{64}$/.test(key) && typeof expiry === 'number' && Number.isSafeInteger(expiry) && expiry > 0)
}
