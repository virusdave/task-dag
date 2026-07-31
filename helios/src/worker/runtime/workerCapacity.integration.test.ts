import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_WORKER_CAPACITY_CONFIG,
  schedulingCancellationError,
  WORKER_CAPACITY_SETTINGS_KEY,
} from '../../shared/contracts/index.js'
import {
  markJobDeadLetter,
  markJobDeferred,
  markJobFailed,
  markJobForRetry,
  markJobSucceeded,
} from './jobRegistry.js'
import {
  __resetExpiredLeaseSweepGateForTests,
  EXPIRED_LEASE_SWEEP_SQL,
  leaseJobs,
} from './leaseJobs.js'

describe('worker priority capacity integration', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'helios-worker-capacity-'))
  const dataDir = resolve(root, 'data')
  const socketDir = resolve(root, 'socket')
  let postgres: ChildProcess
  let pool: Pool

  beforeAll(async () => {
    execFileSync('mkdir', ['-p', socketDir])
    const initdb = realpathSync(execFileSync('which', ['initdb'], { encoding: 'utf8' }).trim())
    const binDir = dirname(initdb)
    execFileSync(initdb, ['-A', 'trust', '-U', 'postgres', '-D', dataDir], { stdio: 'ignore' })
    postgres = spawn(resolve(binDir, 'postgres'), ['-D', dataDir, '-k', socketDir, '-h', '', '-F'], { stdio: 'ignore' })
    pool = new Pool({ host: socketDir, user: 'postgres', database: 'postgres', max: 8 })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await pool.query('select 1')
        break
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      }
    }
    await pool.query(`
      create table app_settings (
        key text primary key,
        value jsonb not null,
        updated_by text not null,
        updated_at timestamptz not null default now()
      );
      create table job_queue (
        id bigserial primary key,
        job_type text not null,
        module_code text not null,
        scope_entity_type text,
        scope_entity_id text,
        payload_json jsonb not null default '{}'::jsonb,
        status text not null,
        priority integer not null,
        concurrency_key text,
        run_at timestamptz not null default now(),
        lease_token text,
        leased_until timestamptz,
        started_at timestamptz,
        finished_at timestamptz,
        attempt_count integer not null default 0,
        last_error text,
        updated_at timestamptz not null default now()
      );
      create index job_queue_status_run_at_idx on job_queue (status, run_at);
    `)
  }, 15_000)

  beforeEach(async () => {
    __resetExpiredLeaseSweepGateForTests()
    await pool.query('truncate job_queue restart identity; truncate app_settings')
    await setCapacity(DEFAULT_WORKER_CAPACITY_CONFIG)
  })

  afterAll(async () => {
    await pool?.end()
    if (postgres) {
      postgres.kill('SIGTERM')
      if (postgres.exitCode === null) {
        await new Promise<void>((resolveWait) => postgres.once('exit', () => resolveWait()))
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('serializes concurrent leasing and enforces cumulative borrowing ceilings', async () => {
    await insertJobs(2, 0)
    await insertJobs(3, 500)

    const [first, second] = await Promise.all([
      leaseJobs({}, { pool }),
      leaseJobs({}, { pool }),
    ])

    const leasedIds = [...first, ...second].map((job) => job.id)
    expect(leasedIds).toHaveLength(3)
    expect(new Set(leasedIds).size).toBe(leasedIds.length)
    expect(await runningPriorities()).toEqual([500, 500, 500])

    await pool.query('truncate job_queue restart identity')
    await insertJobs(2, 0)
    expect(await leaseJobs({}, { pool })).toHaveLength(1)
    expect(await runningPriorities()).toEqual([0])

    await pool.query('truncate job_queue restart identity')
    await insertJobs(4, 1000)
    expect(await leaseJobs({}, { pool })).toHaveLength(4)
    expect(await runningPriorities()).toEqual([1000, 1000, 1000, 1000])
  })

  it('does not interrupt running jobs when an operator lowers capacity', async () => {
    await insertJobs(4, 1000)
    await insertJobs(1, 1000)
    await leaseJobs({}, { pool })
    await setCapacity({ version: 1, generalSlots: 1, liveRequestedReservedSlots: 0, urgentReservedSlots: 0 })

    expect(await leaseJobs({}, { pool })).toHaveLength(0)
    expect(await runningPriorities()).toEqual([1000, 1000, 1000, 1000])
  })

  it('keeps running cancellation inside the global quota until settlement', async () => {
    await insertJobs(3, 1000)
    expect(await leaseJobs({}, { pool })).toHaveLength(3)
    const cancelledId = await insertRunningCancellation('cancelled-running')
    await insertJobs(1, 1000)

    expect(await leaseJobs({}, { pool })).toHaveLength(0)
    await markJobSucceeded(cancelledId, 'cancelled-running', pool)
    expect(await jobState(cancelledId)).toMatchObject({
      status: 'failed',
      last_error: schedulingCancellationError('Cancelled by operator.'),
    })
    expect(await leaseJobs({}, { pool })).toHaveLength(1)
  })

  it('makes cancellation dominate every settlement and expired-lease recovery', async () => {
    const settlements = [
      (id: number, token: string) => markJobSucceeded(id, token, pool),
      (id: number, token: string) => markJobFailed(id, token, 'handler failed', pool),
      (id: number, token: string) => markJobForRetry(id, token, 'retry', new Date(), pool),
      (id: number, token: string) => markJobDeferred(id, token, 'defer', new Date(), pool),
      (id: number, token: string) => markJobDeadLetter(id, token, 'dead', pool),
    ]
    for (const [index, settle] of settlements.entries()) {
      const token = `lease-${index}`
      const id = await insertRunningCancellation(token)
      await settle(id, token)
      expect(await jobState(id)).toMatchObject({
        status: 'failed',
        last_error: schedulingCancellationError('Cancelled by operator.'),
        lease_token: null,
      })
    }

    const expiredId = await insertRunningCancellation('expired', true)
    const released = await pool.query(EXPIRED_LEASE_SWEEP_SQL)
    expect(released.rows).toHaveLength(1)
    expect(await jobState(expiredId)).toMatchObject({
      status: 'failed',
      last_error: schedulingCancellationError('Cancelled by operator.'),
      lease_token: null,
    })
    expect((await pool.query(EXPIRED_LEASE_SWEEP_SQL)).rows).toHaveLength(0)
  })

  async function setCapacity(config: typeof DEFAULT_WORKER_CAPACITY_CONFIG): Promise<void> {
    await pool.query(
      `insert into app_settings (key, value, updated_by) values ($1, $2::jsonb, 'test')
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by`,
      [WORKER_CAPACITY_SETTINGS_KEY, JSON.stringify(config)],
    )
  }

  async function insertJobs(count: number, priority: number): Promise<void> {
    await pool.query(
      `insert into job_queue (job_type, module_code, status, priority)
       select 'llm.debug.rerun', 'config', 'queued', $2 from generate_series(1, $1)`,
      [count, priority],
    )
  }

  async function runningPriorities(): Promise<number[]> {
    const result = await pool.query<{ priority: number }>(
      `select priority from job_queue where status = 'running' order by priority, id`,
    )
    return result.rows.map((row) => row.priority)
  }

  async function insertRunningCancellation(token: string, expired = false): Promise<number> {
    const result = await pool.query<{ id: string }>(
      `insert into job_queue (
         job_type, module_code, status, priority, lease_token, leased_until,
         started_at, last_error
       ) values (
         'scheduling.extract_constraints', 'scheduling', 'running', 100,
         $1, now() + ($2 * interval '1 minute'), now(), $3
       ) returning id`,
      [token, expired ? -1 : 5, schedulingCancellationError('Cancelled by operator.')],
    )
    return Number(result.rows[0]!.id)
  }

  async function jobState(id: number): Promise<{ last_error: string | null; lease_token: string | null; status: string }> {
    const result = await pool.query<{ last_error: string | null; lease_token: string | null; status: string }>(
      'select status, lease_token, last_error from job_queue where id = $1',
      [id],
    )
    return result.rows[0]!
  }
})
