import { randomUUID } from 'node:crypto'

import type { PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import type { ResolvedMigrationArtifact } from '../../server/db/migrationArtifacts.js'
import type { MigrationApplyEligibility } from '../../server/db/migrationApplyEligibility.js'
import type { MigrationBlessing } from '../../server/db/pendingMigrations.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import {
  applyMigrationAttempt,
  buildPgEnvFromDatabaseUrl,
  spawnPsql,
  type ApplyMigrationDeps,
  type ApplyMigrationParams,
  type PsqlRunResult,
} from './dbMigrationApplyJob.js'

// ============================================================================
// Fake-psql / fake-DB harness for the worker apply engine (automation#62,
// leaf 4). Everything that would touch prod — the pool client, psql, the live
// sentinel, eligibility, the pending-migrations cache — is injected, so these
// tests exercise the advisory lock, the running-before-psql record, the live
// sentinel before/after, single-attempt/non-retryable post-psql behaviour, the
// crash-recovery guard, and cache invalidation WITHOUT a database or psql.
// ============================================================================

const DIGEST = 'a'.repeat(64)
const MIGRATION_ID = '097_litalerts_parse_feedback'

interface FakeAttemptRow {
  id: string
  migration_id: string
  job_id: number | null
  state: string
  sentinel_before: boolean | null
  sentinel_after: boolean | null
  error_message: string | null
  advisory_lock_acquired: boolean | null
  psql_exit_code: number | null
  psql_signal: string | null
  finished_at: string | null
}

/**
 * In-memory stand-in for a PoolClient scoped to the migration_apply_attempts
 * table + advisory lock. Dispatches on SQL substrings; the audit / sentinel /
 * eligibility paths are injected separately, so the only SQL it must handle is
 * the advisory lock and the attempt-record CRUD.
 */
class FakeClient {
  readonly rows = new Map<string, FakeAttemptRow>()
  lockAvailable = true
  lockCalls = 0
  unlockCalls = 0
  released = false

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (text.includes('pg_try_advisory_lock')) {
      this.lockCalls += 1
      return { rows: [{ locked: this.lockAvailable } as unknown as T], rowCount: 1 }
    }
    if (text.includes('pg_advisory_unlock')) {
      this.unlockCalls += 1
      return { rows: [{} as unknown as T], rowCount: 1 }
    }
    if (text.includes('insert into migration_apply_attempts')) {
      const id = randomUUID()
      const finished = values[20] === true
      const row: FakeAttemptRow = {
        id,
        migration_id: String(values[0]),
        job_id: values[1] as number | null,
        sentinel_before: (values[12] ?? null) as boolean | null,
        sentinel_after: (values[13] ?? null) as boolean | null,
        psql_exit_code: (values[14] ?? null) as number | null,
        psql_signal: (values[15] ?? null) as string | null,
        error_message: (values[18] ?? null) as string | null,
        advisory_lock_acquired: (values[11] ?? null) as boolean | null,
        state: String(values[19]),
        finished_at: finished ? 'now' : null,
      }
      this.rows.set(id, row)
      return { rows: [{ id } as unknown as T], rowCount: 1 }
    }
    if (text.includes('from migration_apply_attempts') && text.includes('where job_id') && text.includes('select id, state')) {
      const jobId = values[0] as number
      const matched = [...this.rows.values()]
        .filter((row) => row.job_id === jobId)
        .map((row) => ({
          id: row.id,
          state: row.state,
          psql_exit_code: row.psql_exit_code,
          psql_signal: row.psql_signal,
        }))
      return { rows: matched as unknown as T[], rowCount: matched.length }
    }
    if (text.includes("set state = 'abandoned'")) {
      const jobId = values[0] as number
      let n = 0
      for (const row of this.rows.values()) {
        if (row.job_id === jobId && row.state === 'running') {
          row.state = 'abandoned'
          row.finished_at = 'now'
          n += 1
        }
      }
      return { rows: [], rowCount: n }
    }
    if (text.includes('update migration_apply_attempts set')) {
      const id = values[values.length - 1] as string
      const row = this.rows.get(id)
      if (row) {
        const setPart = text.split(/\bwhere\b/i)[0]
        const assignRe = /(\w+)\s*=\s*\$(\d+)/g
        let match: RegExpExecArray | null
        while ((match = assignRe.exec(setPart)) !== null) {
          const column = match[1]
          const paramIdx = Number.parseInt(match[2], 10) - 1
          this.applyColumn(row, column, values[paramIdx])
        }
        if (/finished_at\s*=\s*now\(\)/.test(setPart)) {
          row.finished_at = 'now'
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    throw new Error(`FakeClient: unhandled query: ${text}`)
  }

  private applyColumn(row: FakeAttemptRow, column: string, value: unknown): void {
    switch (column) {
      case 'state':
        row.state = String(value)
        break
      case 'sentinel_before':
        row.sentinel_before = value as boolean | null
        break
      case 'sentinel_after':
        row.sentinel_after = value as boolean | null
        break
      case 'error_message':
        row.error_message = value as string | null
        break
      case 'psql_exit_code':
        row.psql_exit_code = value as number | null
        break
      case 'psql_signal':
        row.psql_signal = value as string | null
        break
      default:
        break
    }
  }

  release(): void {
    this.released = true
  }

  only(): FakeAttemptRow {
    const all = [...this.rows.values()]
    if (all.length !== 1) {
      throw new Error(`expected exactly 1 attempt row, found ${all.length}`)
    }
    return all[0]
  }
}

function blessing(): MigrationBlessing {
  return {
    ref: 'https://ampcode.com/threads/T-oracle-blessing',
    reviewedSha: 'deadbeef',
    artifactSha256: DIGEST,
    transactionMode: 'transactional',
    note: 'test blessing',
  }
}

function artifact(): ResolvedMigrationArtifact {
  return {
    migrationId: MIGRATION_ID,
    main: { absPath: `/dist/server/db/migrations/${MIGRATION_ID}.sql`, relPath: `migrations/${MIGRATION_ID}.sql` },
    includes: [],
    sha256: DIGEST,
    migrationsRoot: '/dist/server/db/migrations',
    schemaRoot: '/dist/server/db/schema',
  }
}

function eligibleResult(): MigrationApplyEligibility {
  return { eligible: true, migrationId: MIGRATION_ID, blessing: blessing(), artifact: artifact() }
}

interface HarnessOptions {
  eligibility?: MigrationApplyEligibility
  lockAvailable?: boolean
  psqlBin?: string | null
  sentinelSequence?: boolean[]
  psqlResult?: PsqlRunResult
  seedClient?: (client: FakeClient) => void
}

interface Harness {
  deps: ApplyMigrationDeps
  client: FakeClient
  runPsql: ReturnType<typeof vi.fn>
  invalidate: ReturnType<typeof vi.fn>
  audit: ReturnType<typeof vi.fn>
  auditEventTypes: () => string[]
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const client = new FakeClient()
  client.lockAvailable = options.lockAvailable ?? true
  options.seedClient?.(client)

  const sentinelSequence = [...(options.sentinelSequence ?? [])]
  const isMigrationAppliedLive = vi.fn(async () => {
    return sentinelSequence.length > 0 ? sentinelSequence.shift()! : false
  })
  const runPsql = vi.fn(
    async (): Promise<PsqlRunResult> =>
      options.psqlResult ?? { exitCode: 0, signal: null, stdoutTail: 'ok', stderrTail: '', spawnError: null },
  )
  const invalidate = vi.fn()
  const audit = vi.fn(async () => 1)

  const deps: ApplyMigrationDeps = {
    connect: async () => client as unknown as PoolClient,
    resolveEligibility: () => options.eligibility ?? eligibleResult(),
    isMigrationAppliedLive,
    invalidatePendingMigrationsCache: invalidate,
    appendAuditEvent: audit as unknown as ApplyMigrationDeps['appendAuditEvent'],
    resolvePsqlBin: () => (options.psqlBin === undefined ? '/nix/store/psql/bin/psql' : options.psqlBin),
    getPsqlVersion: async () => 'psql (PostgreSQL) 17.0',
    buildPgEnv: () => ({ env: { PGHOST: 'db', PGPASSWORD: 'secret' }, redactValues: ['secret'] }),
    runPsql,
    deployedBuildId: () => 'build-123',
  }

  return {
    deps,
    client,
    runPsql,
    invalidate,
    audit,
    auditEventTypes: () =>
      audit.mock.calls.map((call) => (call[1] as { eventType: string }).eventType),
  }
}

function params(overrides: Partial<ApplyMigrationParams> = {}): ApplyMigrationParams {
  return {
    jobId: 42,
    migrationId: MIGRATION_ID,
    requestedByUserId: 7,
    confirmMigrationId: MIGRATION_ID,
    blessingArtifactSha256: DIGEST,
    ...overrides,
  }
}

describe('applyMigrationAttempt — happy path', () => {
  it('applies a pending migration: running → psql → live sentinel flips → succeeded', async () => {
    const h = makeHarness({ sentinelSequence: [false, true] })
    await applyMigrationAttempt(h.deps, params())

    expect(h.runPsql).toHaveBeenCalledTimes(1)
    const row = h.client.only()
    expect(row.state).toBe('succeeded')
    expect(row.sentinel_before).toBe(false)
    expect(row.sentinel_after).toBe(true)
    expect(row.advisory_lock_acquired).toBe(true)
    expect(row.psql_exit_code).toBe(0)
    expect(h.client.lockCalls).toBe(1)
    expect(h.client.unlockCalls).toBe(1)
    expect(h.client.released).toBe(true)
    expect(h.invalidate).toHaveBeenCalledTimes(1)
    expect(h.auditEventTypes()).toEqual([
      'db.migration.apply.started',
      'db.migration.apply.succeeded',
    ])
  })
})

describe('applyMigrationAttempt — already applied', () => {
  it('records already_applied and never runs psql when the live sentinel is already true', async () => {
    const h = makeHarness({ sentinelSequence: [true] })
    await applyMigrationAttempt(h.deps, params())

    expect(h.runPsql).not.toHaveBeenCalled()
    const row = h.client.only()
    expect(row.state).toBe('already_applied')
    expect(row.sentinel_after).toBe(true)
    expect(h.client.unlockCalls).toBe(1)
    expect(h.invalidate).toHaveBeenCalledTimes(1)
    expect(h.auditEventTypes()).toEqual([
      'db.migration.apply.started',
      'db.migration.apply.succeeded',
    ])
  })
})

describe('applyMigrationAttempt — psql failure is terminal', () => {
  it('throws a non-retryable error and marks failed on a nonzero psql exit', async () => {
    const h = makeHarness({
      sentinelSequence: [false, false],
      psqlResult: { exitCode: 1, signal: null, stdoutTail: '', stderrTail: 'boom', spawnError: null },
    })
    await expect(applyMigrationAttempt(h.deps, params())).rejects.toThrow(/terminal/i)
    await expect(applyMigrationAttempt(makeHarness({
      sentinelSequence: [false, false],
      psqlResult: { exitCode: 1, signal: null, stdoutTail: '', stderrTail: 'boom', spawnError: null },
    }).deps, params())).rejects.not.toBeInstanceOf(RetryableWorkerError)

    const row = h.client.only()
    expect(row.state).toBe('failed')
    expect(row.psql_exit_code).toBe(1)
    expect(h.client.unlockCalls).toBe(1)
    expect(h.invalidate).toHaveBeenCalledTimes(1)
    expect(h.auditEventTypes()).toEqual(['db.migration.apply.started', 'db.migration.apply.failed'])
  })
})

describe('applyMigrationAttempt — sentinel mismatch is terminal', () => {
  it('fails when psql exits 0 but the live sentinel does not flip to applied', async () => {
    const h = makeHarness({ sentinelSequence: [false, false] })
    await expect(applyMigrationAttempt(h.deps, params())).rejects.toThrow(/sentinel/i)

    const row = h.client.only()
    expect(row.state).toBe('failed')
    expect(row.sentinel_after).toBe(false)
    expect(h.auditEventTypes()).toContain('db.migration.apply.failed')
  })
})

describe('applyMigrationAttempt — advisory lock contention is retryable', () => {
  it('records blocked_lock and throws RetryableWorkerError without running psql', async () => {
    const h = makeHarness({ lockAvailable: false })
    await expect(applyMigrationAttempt(h.deps, params())).rejects.toBeInstanceOf(RetryableWorkerError)

    expect(h.runPsql).not.toHaveBeenCalled()
    const row = h.client.only()
    expect(row.state).toBe('blocked_lock')
    expect(row.advisory_lock_acquired).toBe(false)
    // Lock was never acquired, so nothing to unlock.
    expect(h.client.unlockCalls).toBe(0)
    expect(h.invalidate).toHaveBeenCalledTimes(1)
  })
})

describe('applyMigrationAttempt — ineligibility is terminal', () => {
  it('refuses an unblessed migration without running psql', async () => {
    const ineligible: MigrationApplyEligibility = {
      eligible: false,
      migrationId: MIGRATION_ID,
      reason: 'not-blessed',
      detail: 'no blessing',
      blessing: null,
      artifact: null,
    }
    const h = makeHarness({ eligibility: ineligible })
    await expect(applyMigrationAttempt(h.deps, params())).rejects.not.toBeInstanceOf(RetryableWorkerError)

    expect(h.runPsql).not.toHaveBeenCalled()
    expect(h.client.only().state).toBe('failed')
    expect(h.auditEventTypes()).toEqual(['db.migration.apply.failed'])
  })

  it('refuses when the payload digest does not match the deployed artifact', async () => {
    const h = makeHarness()
    await expect(
      applyMigrationAttempt(h.deps, params({ blessingArtifactSha256: 'b'.repeat(64) })),
    ).rejects.toThrow(/digest/i)
    expect(h.runPsql).not.toHaveBeenCalled()
    expect(h.client.only().state).toBe('failed')
  })

  it('refuses when confirmMigrationId does not match', async () => {
    const h = makeHarness()
    await expect(
      applyMigrationAttempt(h.deps, params({ confirmMigrationId: 'wrong' })),
    ).rejects.toThrow(/confirm/i)
    expect(h.runPsql).not.toHaveBeenCalled()
    expect(h.client.only().state).toBe('failed')
  })
})

describe('applyMigrationAttempt — psql binary missing is retryable', () => {
  it('defers (retryable) and never falls back to an ambient psql', async () => {
    const h = makeHarness({ psqlBin: null })
    await expect(applyMigrationAttempt(h.deps, params())).rejects.toBeInstanceOf(RetryableWorkerError)
    expect(h.runPsql).not.toHaveBeenCalled()
    expect(h.client.only().state).toBe('failed')
  })

  it('refuses a relative psql path (no PATH lookup)', async () => {
    const h = makeHarness({ psqlBin: 'psql' })
    await expect(applyMigrationAttempt(h.deps, params())).rejects.toBeInstanceOf(RetryableWorkerError)
    expect(h.runPsql).not.toHaveBeenCalled()
  })
})

describe('applyMigrationAttempt — crash-recovery guard', () => {
  it('refuses to re-run when a prior running attempt for the job survives and it is still not applied', async () => {
    const h = makeHarness({
      sentinelSequence: [false],
      seedClient: (client) => {
        const id = randomUUID()
        client.rows.set(id, {
          id,
          migration_id: MIGRATION_ID,
          job_id: 42,
          state: 'running',
          sentinel_before: null,
          sentinel_after: null,
          error_message: null,
          advisory_lock_acquired: true,
          psql_exit_code: null,
          psql_signal: null,
          finished_at: null,
        })
      },
    })
    await expect(applyMigrationAttempt(h.deps, params())).rejects.toThrow(/re-run/i)
    expect(h.runPsql).not.toHaveBeenCalled()
    // The prior running row was abandoned; a fresh terminal 'failed' row added.
    const states = [...h.client.rows.values()].map((r) => r.state).sort()
    expect(states).toEqual(['abandoned', 'failed'])
  })

  it('refuses re-run when a prior FAILED attempt recorded a psql exit (psql ran; lease was stolen)', async () => {
    const h = makeHarness({
      sentinelSequence: [false],
      seedClient: (client) => {
        const id = randomUUID()
        client.rows.set(id, {
          id,
          migration_id: MIGRATION_ID,
          job_id: 42,
          state: 'failed',
          sentinel_before: false,
          sentinel_after: false,
          error_message: 'psql exited with code=1',
          advisory_lock_acquired: true,
          psql_exit_code: 1,
          psql_signal: null,
          finished_at: 'now',
        })
      },
    })
    await expect(applyMigrationAttempt(h.deps, params())).rejects.toThrow(/re-run/i)
    expect(h.runPsql).not.toHaveBeenCalled()
  })

  it('does NOT trip the guard for a prior pre-psql failed attempt (no exit/signal recorded)', async () => {
    const h = makeHarness({
      sentinelSequence: [false, true],
      seedClient: (client) => {
        const id = randomUUID()
        client.rows.set(id, {
          id,
          migration_id: MIGRATION_ID,
          job_id: 42,
          state: 'failed',
          sentinel_before: null,
          sentinel_after: null,
          error_message: 'HELIOS_PSQL_BIN not configured',
          advisory_lock_acquired: null,
          psql_exit_code: null,
          psql_signal: null,
          finished_at: 'now',
        })
      },
    })
    await applyMigrationAttempt(h.deps, params())
    expect(h.runPsql).toHaveBeenCalledTimes(1)
    const succeeded = [...h.client.rows.values()].filter((r) => r.state === 'succeeded')
    expect(succeeded).toHaveLength(1)
  })

  it('converges to already_applied success if the migration became applied after a crash', async () => {
    const h = makeHarness({
      sentinelSequence: [true],
      seedClient: (client) => {
        const id = randomUUID()
        client.rows.set(id, {
          id,
          migration_id: MIGRATION_ID,
          job_id: 42,
          state: 'running',
          sentinel_before: null,
          sentinel_after: null,
          error_message: null,
          advisory_lock_acquired: true,
          psql_exit_code: null,
          psql_signal: null,
          finished_at: null,
        })
      },
    })
    await applyMigrationAttempt(h.deps, params())
    expect(h.runPsql).not.toHaveBeenCalled()
    const states = [...h.client.rows.values()].map((r) => r.state).sort()
    expect(states).toEqual(['abandoned', 'already_applied'])
    expect(h.auditEventTypes()).toEqual(['db.migration.apply.succeeded'])
  })
})

describe('applyMigrationAttempt — pool checkout failure is retryable', () => {
  it('throws RetryableWorkerError and invalidates the cache when connect() rejects', async () => {
    const h = makeHarness()
    const invalidate = vi.fn()
    const deps: ApplyMigrationDeps = {
      ...h.deps,
      connect: async () => {
        throw new Error('pool exhausted')
      },
      invalidatePendingMigrationsCache: invalidate,
    }
    await expect(applyMigrationAttempt(deps, params())).rejects.toBeInstanceOf(RetryableWorkerError)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(h.runPsql).not.toHaveBeenCalled()
  })
})

describe('buildPgEnvFromDatabaseUrl', () => {
  it('maps a DATABASE_URL to PG* env with no URL and redacts the password', () => {
    const { env, redactValues } = buildPgEnvFromDatabaseUrl(
      'postgres://tsdbadmin:s3cr3t@db.example.tsdb.cloud.timescale.com:30667/tsdb?sslmode=require',
    )
    expect(env.PGHOST).toBe('db.example.tsdb.cloud.timescale.com')
    expect(env.PGPORT).toBe('30667')
    expect(env.PGDATABASE).toBe('tsdb')
    expect(env.PGUSER).toBe('tsdbadmin')
    expect(env.PGPASSWORD).toBe('s3cr3t')
    expect(env.PGSSLMODE).toBe('require')
    expect(redactValues).toContain('s3cr3t')
  })
})

describe('spawnPsql', () => {
  it('reports spawnError when the binary does not exist (no throw)', async () => {
    const result = await spawnPsql({
      psqlBin: '/nonexistent/definitely/not/psql',
      mainFileAbsPath: '/tmp/x.sql',
      cwd: '/tmp',
      applicationName: 'test',
      pgEnv: {},
      redactValues: [],
      outputTailBytes: 1024,
    })
    expect(result.spawnError).not.toBeNull()
    expect(result.exitCode).toBeNull()
  })
})
