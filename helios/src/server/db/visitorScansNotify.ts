/**
 * Postgres LISTEN / NOTIFY plumbing for the visitor-scans live feed
 * (Helios DB-cost epic, phase E1 — virusdave/top-level#11).
 *
 * The operator-facing /visitors/scans page used to poll
 * `/api/visitors/scans` unconditionally every 20 s to stay "live
 * behind the counter". That is the one page the epic's hard
 * constraint forbids throttling — so instead of slowing it down we
 * swap the mechanism: the server pushes a Server-Sent-Events stream
 * driven by this LISTEN/NOTIFY channel, and the browser only
 * re-queries when a scan (or its CRM enrichment) actually lands.
 *
 *   - The VeriScan webhook handler issues
 *     `pg_notify('visitor_scans_changed', '{"scanId":…}')` inside
 *     the same transaction as the row insert (delivered on commit).
 *   - The CRM-link worker job issues the same NOTIFY after it writes
 *     a terminal link status, so the "New/Returning"/CRM pill
 *     flips live too.
 *   - This module (running in the SERVER process, unlike the
 *     job-queue listener in notify.ts which runs in the worker)
 *     opens ONE dedicated long-lived LISTEN connection and fans the
 *     notifications out to every connected SSE client via an
 *     in-process EventEmitter.
 *
 * Why a single shared listener: one LISTEN connection per SSE
 * client would burn a pool connection per open browser tab. One
 * dedicated client per server process + in-process fan-out keeps the
 * DB-connection cost flat regardless of how many operators have the
 * page open.
 *
 * Resync semantics: a NOTIFY is not a durable queue. If the LISTEN
 * connection drops and reconnects, notifications emitted during the
 * gap are lost. On every RE-connection we emit a 'resync' event so
 * the SSE route can tell its clients to do a full refetch and close
 * the gap. (The client also keeps a slow safety refetch as a final
 * backstop.)
 */
import { EventEmitter } from 'node:events'

import type { Notification, PoolClient } from 'pg'

import { attachPoolClientErrorLogger, getPool, type Queryable } from './pool.js'

const CHANNEL = 'visitor_scans_changed'
const RECONNECT_BACKOFF_MS = 5_000

export interface VisitorScanChangedPayload {
  scanId: number
  kind: 'inserted' | 'link_updated'
}

const emitter = new EventEmitter()
// One listener pair per open SSE client; a busy shift could have
// several operator tabs. Default cap of 10 would warn spuriously.
emitter.setMaxListeners(0)

let listenerClient: PoolClient | null = null
let listenerStarting: Promise<void> | null = null
let removeListenerErrorLogger: (() => void) | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
// True once we've successfully connected at least once, so we can
// distinguish a first connect (no resync needed — SSE clients fetch
// on open) from a reconnect after a gap (resync needed).
let hasConnectedBefore = false
let stopped = false

/**
 * Schedule a reconnect that (a) never keeps the process alive
 * (`unref`, so the SPA smoke + clean shutdown aren't blocked) and
 * (b) is cancellable from `stop()` so it can't resurrect a stopped
 * listener.
 */
function scheduleReconnect(): void {
  if (stopped || reconnectTimer !== null) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!stopped) void startVisitorScansNotifyListener()
  }, RECONNECT_BACKOFF_MS)
  reconnectTimer.unref?.()
}

/**
 * Lazily open the dedicated LISTEN connection and route inbound
 * notifications through the in-process emitter. Idempotent. On
 * connection error the listener resets and reconnects after
 * `RECONNECT_BACKOFF_MS`, emitting 'resync' once it's back so SSE
 * clients reconcile any notifications missed during the gap.
 */
export function startVisitorScansNotifyListener(): Promise<void> {
  stopped = false
  if (listenerClient !== null) return Promise.resolve()
  if (listenerStarting !== null) return listenerStarting

  listenerStarting = (async () => {
    try {
      const client = await getPool().connect()
      removeListenerErrorLogger = attachPoolClientErrorLogger(
        client,
        'visitorScansNotifyListener',
      )
      client.on('notification', (msg: Notification) => {
        if (msg.channel !== CHANNEL) return
        const payload = parsePayload(msg.payload)
        if (payload !== null) {
          emitter.emit('change', payload)
        }
      })
      client.on('error', (error) => {
        // eslint-disable-next-line no-console
        console.error(
          '[visitor-scans-notify] LISTEN connection error; will reconnect:',
          error instanceof Error ? error.message : error,
        )
        teardownListenerClient()
        scheduleReconnect()
      })
      await client.query(`listen ${CHANNEL}`)
      listenerClient = client
      if (hasConnectedBefore) {
        // Reconnect after a gap — tell SSE clients to refetch.
        emitter.emit('resync')
      }
      hasConnectedBefore = true
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '[visitor-scans-notify] failed to open LISTEN connection; will retry:',
        error instanceof Error ? error.message : error,
      )
      teardownListenerClient()
      scheduleReconnect()
    } finally {
      listenerStarting = null
    }
  })()
  return listenerStarting
}

/** Release the dedicated LISTEN connection (server shutdown). */
export function stopVisitorScansNotifyListener(): void {
  stopped = true
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  teardownListenerClient()
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
      // Releasing an already-broken client can throw; the pool drops
      // the connection either way.
    }
  }
}

function parsePayload(raw: string | undefined): VisitorScanChangedPayload | null {
  if (raw === undefined || raw.length === 0) return null
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const scanId = typeof obj.scanId === 'number' ? obj.scanId : Number(obj.scanId)
    const kind = obj.kind === 'link_updated' ? 'link_updated' : 'inserted'
    if (!Number.isFinite(scanId)) return null
    return { scanId, kind }
  } catch {
    return null
  }
}

export interface VisitorScanSubscription {
  close(): void
}

/**
 * Subscribe to visitor-scan change notifications. `onChange` fires
 * per NOTIFY; `onResync` fires when the underlying LISTEN connection
 * reconnects after a gap (the subscriber should do a full refetch).
 * Returns a handle whose `close()` removes both listeners — callers
 * MUST call it on client disconnect to avoid leaking handlers.
 */
export function subscribeToVisitorScanChanges(handlers: {
  onChange: (payload: VisitorScanChangedPayload) => void
  onResync: () => void
}): VisitorScanSubscription {
  emitter.on('change', handlers.onChange)
  emitter.on('resync', handlers.onResync)
  return {
    close(): void {
      emitter.removeListener('change', handlers.onChange)
      emitter.removeListener('resync', handlers.onResync)
    },
  }
}

/**
 * Emit `NOTIFY visitor_scans_changed` carrying a small JSON payload.
 * Callers pass the transactional `Queryable` they're already using
 * so the NOTIFY shares the commit boundary of the row write that
 * triggered it (a rolled-back write drops the wakeup, which is
 * correct). Uses `pg_notify(...)` parameterised — never interpolate
 * the payload into SQL.
 */
export async function notifyVisitorScanChanged(
  db: Queryable,
  payload: VisitorScanChangedPayload,
): Promise<void> {
  await db.query('select pg_notify($1, $2)', [CHANNEL, JSON.stringify(payload)])
}

/** Test-only: emit a synthetic change as if a NOTIFY arrived. */
export function __emitVisitorScanChangeForTests(payload: VisitorScanChangedPayload): void {
  emitter.emit('change', payload)
}
