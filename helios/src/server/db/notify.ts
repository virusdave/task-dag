/**
 * Postgres LISTEN / NOTIFY plumbing for the job-queue wake-up
 * signal (Helios DB-cost epic, phase B4 — virusdave/top-level#11).
 *
 * The worker's lease loops were polling TigerData every
 * `pollIntervalMs` (3 s in the main loop, 10 s in the fast-lane
 * loop). Phase B3 introduced a polynomial idle backoff up to 15 s,
 * and this module raises the cap further while preserving
 * sub-second wake-up latency on a real enqueue by using
 * Postgres's LISTEN / NOTIFY:
 *
 *   - `enqueueJob` / `enqueueJobs` issue `NOTIFY helios_job_queue`
 *     from inside the caller's transaction. The notification is
 *     delivered to listeners on commit.
 *   - This module opens (lazily, idempotently) a dedicated
 *     LONG-LIVED LISTEN connection on a separate pool client.
 *   - `waitForJobQueueWakeup(abortSignal)` returns a promise that
 *     resolves on the next inbound notification, or when the
 *     supplied AbortSignal fires (so the caller can race the
 *     wakeup against a `delay()` timeout without leaking
 *     listeners).
 *
 * Why a dedicated client: pg client connections are stateful when
 * LISTENing, and sharing one with the lease CTE would entangle
 * connection-state errors with the lease loop. A single dedicated
 * client per worker process is cheap and keeps the failure modes
 * cleanly separated.
 *
 * Why no payload: the worker doesn't need to know WHICH row was
 * enqueued, only that one was. The lease CTE re-scans the queue
 * on wake-up anyway. Keeping the NOTIFY payload empty avoids any
 * concerns about NOTIFY payload size limits.
 */
import { EventEmitter } from 'node:events'

import type { Notification, PoolClient } from 'pg'

import { attachPoolClientErrorLogger, getPool, type Queryable } from './pool.js'

const CHANNEL = 'helios_job_queue'
const RECONNECT_BACKOFF_MS = 5_000

const emitter = new EventEmitter()
// Multiple lease loops (main + fastlane) plus opportunistic
// wakeups can subscribe simultaneously. Default cap of 10 would
// trigger spurious warnings under steady-state.
emitter.setMaxListeners(0)

let listenerClient: PoolClient | null = null
let listenerStarting: Promise<void> | null = null
let removeListenerErrorLogger: (() => void) | null = null

/**
 * Lazily open the dedicated LISTEN connection and start routing
 * inbound notifications through the in-process emitter. Safe to
 * call multiple times — only the first call sets up the
 * connection; subsequent calls await the same initialization
 * promise.
 *
 * On connection error the listener is reset and a reconnect is
 * scheduled after `RECONNECT_BACKOFF_MS`. The worker loops keep
 * polling on the idle-cap cadence during the gap, so a downed
 * NOTIFY connection only costs latency, not correctness.
 */
export function startJobQueueNotifyListener(): Promise<void> {
  if (listenerClient !== null) return Promise.resolve()
  if (listenerStarting !== null) return listenerStarting

  listenerStarting = (async () => {
    try {
      const client = await getPool().connect()
      removeListenerErrorLogger = attachPoolClientErrorLogger(
        client,
        'jobQueueNotifyListener',
      )
      client.on('notification', (msg: Notification) => {
        if (msg.channel === CHANNEL) {
          emitter.emit('wakeup')
        }
      })
      client.on('error', (error) => {
        // eslint-disable-next-line no-console
        console.error(
          '[notify] LISTEN connection error; will reconnect:',
          error instanceof Error ? error.message : error,
        )
        teardownListenerClient()
        setTimeout(() => {
          void startJobQueueNotifyListener()
        }, RECONNECT_BACKOFF_MS)
      })
      await client.query(`listen ${CHANNEL}`)
      listenerClient = client
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '[notify] failed to open LISTEN connection; will retry:',
        error instanceof Error ? error.message : error,
      )
      teardownListenerClient()
      setTimeout(() => {
        void startJobQueueNotifyListener()
      }, RECONNECT_BACKOFF_MS)
    } finally {
      listenerStarting = null
    }
  })()
  return listenerStarting
}

function teardownListenerClient(): void {
  if (removeListenerErrorLogger) {
    removeListenerErrorLogger()
    removeListenerErrorLogger = null
  }
  const client = listenerClient
  listenerClient = null
  if (client) {
    try {
      client.release(true)
    } catch {
      // Releasing an already-broken client can throw; the pool will
      // drop the connection either way.
    }
  }
}

/**
 * Wait for the next job-queue NOTIFY. Resolves on the next
 * inbound notification, OR when `abortSignal` fires (in which
 * case the listener is cleaned up so we don't leak handlers).
 *
 * Calls before `startJobQueueNotifyListener()` is called won't
 * receive any wakeups; that's by design — the worker entrypoint
 * starts the listener at boot, and code that wants wakeups must
 * be in a worker process.
 */
export function waitForJobQueueWakeup(abortSignal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (abortSignal?.aborted) {
      resolve()
      return
    }
    const onWakeup = (): void => {
      cleanup()
      resolve()
    }
    const onAbort = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      emitter.removeListener('wakeup', onWakeup)
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort)
      }
    }
    emitter.once('wakeup', onWakeup)
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Emit `NOTIFY helios_job_queue` from inside the caller's
 * transaction. The notification is delivered on commit; a
 * rolled-back transaction silently drops the wakeup, which is
 * acceptable (the lease loop still polls on its idle cadence).
 *
 * Callers pass the transactional `Queryable` they're already
 * using (i.e. the connection inside their `withTransaction`
 * block, NOT a fresh pool client) so the NOTIFY is part of the
 * same commit boundary as the row insert that triggered it.
 *
 * No payload — the worker only needs to know that SOMETHING was
 * enqueued, not what.
 */
export async function notifyJobQueueEnqueued(db: Queryable): Promise<void> {
  await db.query(`notify ${CHANNEL}`)
}

/**
 * Test-only helper: emit a wakeup as if a NOTIFY arrived from
 * Postgres. Not exported via the package entrypoint.
 */
export function __emitWakeupForTests(): void {
  emitter.emit('wakeup')
}
