import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

import { z } from 'zod'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { getCurrentJobAuthContext, recordAuthEvent } from './authLog.js'
import { runWithSweedSessionLock } from './sessionLock.js'

/**
 * Per-job Sweed session: instead of every helios worker job sharing one
 * pre-acquired SWEED_AUTH_TOKEN (and racing each other over the
 * server-side dealer context Sweed keeps for that token), each Sweed-
 * backed job opens its OWN fresh session up front by logging in with
 * credentials, then stashes the resulting auth token in an
 * AsyncLocalStorage cell. Every subsequent Sweed RPC inside that job
 * reads its auth token from the ALS cell instead of the shared env
 * token, so two concurrent jobs literally cannot clobber each other's
 * dealer context.
 *
 * Login flow (verified from a Sweed Prime HAR):
 *   POST https://prime.sweedpos.com/api/
 *   body: {
 *     name:   "store.auth.user",
 *     params: { profileTypeId: 1, login, password },
 *     id:     "<uuid>"
 *   }
 *   response.result.auth = "<new session UUID>"
 *
 * The returned token is then passed as `auth` on subsequent JSON-RPC
 * bodies.
 */

interface SweedSessionContext {
  authToken: string
  origin: 'fresh' | 'legacy'
  /**
   * Last dealer the session was pinned to via `store.auth.dealer.set`.
   * Used to skip redundant dealer-set RPCs when subsequent calls
   * target the same dealer. Sweed's session keeps the dealer context
   * sticky on the server side so we don't need to re-pin it for every
   * call. Mutated via setCurrentSweedDealerId().
   */
  currentDealerId: number | null
}

const sessionStorage = new AsyncLocalStorage<SweedSessionContext>()

const SignInResultSchema = z
  .object({
    auth: z.string().min(1),
    initialData: z
      .object({
        user: z
          .object({
            id: z.coerce.string().optional(),
            login: z.string().optional(),
            currentDealerId: z.coerce.number().int().optional(),
            currentDealerName: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export function getCurrentSweedAuthToken(): string | null {
  return sessionStorage.getStore()?.authToken ?? null
}

export function hasActiveSweedSession(): boolean {
  return sessionStorage.getStore() !== undefined
}

export function getCurrentSweedSessionOrigin(): 'fresh' | 'legacy' | null {
  return sessionStorage.getStore()?.origin ?? null
}

export function getCurrentSweedDealerId(): number | null {
  return sessionStorage.getStore()?.currentDealerId ?? null
}

export function setCurrentSweedDealerId(dealerId: number | null): void {
  const store = sessionStorage.getStore()
  if (store === undefined) {
    return
  }
  store.currentDealerId = dealerId
}

/**
 * Run `fn` inside a fresh Sweed session.
 *
 * - If credentials are configured (SWEED_LOGIN_EMAIL + SWEED_LOGIN_PASSWORD),
 *   logs in and uses the returned per-call auth token.
 * - Else if the legacy SWEED_AUTH_TOKEN is configured, uses that token (and
 *   marks the session origin as 'legacy', so callers can still serialize
 *   with the shared-token mutex if they want).
 * - Else throws a clear configuration error.
 *
 * Nested calls reuse the outer session; we never open a session inside a
 * session.
 *
 * For sessions opened via `'fresh'` login, we make a best-effort
 * sign-out attempt when `fn` finishes (success or failure). Sweed
 * does not document a logout RPC; if/when one is confirmed it should
 * be wired into `tearDownFreshSweedSession()` below. Until then we
 * just clear our ALS context and let the token expire server-side.
 * Tracked by task-dag task: `sweed-research-session-teardown`.
 */
export async function withSweedSession<T>(fn: () => Promise<T>): Promise<T> {
  if (sessionStorage.getStore() !== undefined) {
    return fn()
  }

  const env = getWorkerEnv()
  const hasCredentials = env.sweedLoginEmail !== null && env.sweedLoginPassword !== null
  if (!hasCredentials && !env.sweedAuthToken) {
    throw new Error(
      'No Sweed authentication configured. Set SWEED_LOGIN_EMAIL+SWEED_LOGIN_PASSWORD (preferred) or SWEED_AUTH_TOKEN.',
    )
  }

  // Fresh-session mode: serialize the ENTIRE login → fn() → logout
  // lifecycle behind the process-wide Sweed mutex.
  //
  // Rationale: we kept seeing "store.auth.initial.data.get failed:
  // Auth expired" immediately after a successful store.auth.user.
  // The only way that happens with a brand-new token is if another
  // login (or logout) from this same Sweed user landed in between —
  // Sweed appears to invalidate the previous session-token when a
  // second login for the same login_email is issued, and to take
  // user-level effect when store.auth.end fires. With the lock in
  // place each ephemeral session lives end-to-end without any other
  // login/logout for this user racing it from within this worker
  // process. (Multi-process / multi-host parallelism is still
  // bounded by whatever Sweed's per-user session model actually
  // permits; the auth-event log surfaces the cross-process picture.)
  //
  // The legacy shared-token path still goes through the same lock
  // via runWithDealerSerialization() in rpc.ts, so a legacy job and
  // a fresh-session job cannot interleave either.
  if (hasCredentials) {
    return runWithSweedSessionLock(() => runFreshSession(env.sweedLoginEmail as string, env.sweedLoginPassword as string, fn))
  }

  const context: SweedSessionContext = {
    authToken: env.sweedAuthToken as string,
    origin: 'legacy',
    currentDealerId: null,
  }
  return sessionStorage.run(context, fn)
}

async function runFreshSession<T>(login: string, password: string, fn: () => Promise<T>): Promise<T> {
  const result = await issueFreshSweedSession(login, password)
  const context: SweedSessionContext = {
    authToken: result.authToken,
    origin: 'fresh',
    currentDealerId: result.initialDealerId,
  }
  try {
    return await sessionStorage.run(context, fn)
  } finally {
    await tearDownFreshSweedSession(context.authToken)
  }
}

/**
 * Best-effort sign-out for a fresh Sweed session via the `store.auth.end`
 * RPC. This is fire-and-forget: any failure (network blip, Sweed
 * rejecting the call, malformed response, etc.) must NEVER propagate
 * because it would mask the real outcome of the caller's work. The
 * session will eventually expire server-side either way; this call
 * just makes that immediate so we don't leak short-lived tokens.
 */
async function tearDownFreshSweedSession(authToken: string): Promise<void> {
  const env = getWorkerEnv()
  const startedAt = Date.now()
  let httpStatus: number | null = null
  let errorMessage: string | null = null
  try {
    const response = await fetch(env.sweedApiUrl, {
      body: JSON.stringify({
        auth: authToken,
        id: randomUUID(),
        name: 'store.auth.end',
      }),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'helios-worker/1.0',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.sweedRequestTimeoutMs),
    })
    httpStatus = response.status
    // Drain the body so the underlying HTTP connection can be reused
    // and we don't leak a half-read response. Capture a snippet for
    // the auth log if Sweed surfaced an error envelope.
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      errorMessage = `HTTP ${response.status}: ${text.slice(0, 240)}`
    } else if (text.length > 0) {
      try {
        const envelope = JSON.parse(text) as { error?: { message?: string } }
        if (envelope.error?.message) {
          errorMessage = `sweed error: ${envelope.error.message}`
        }
      } catch {
        // Non-JSON body; ignore.
      }
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
    // Logout is best-effort; never propagate. Log so a persistent
    // failure (e.g. Sweed renamed the RPC) is at least observable.
    console.warn('[sweed] store.auth.end best-effort logout failed:', errorMessage)
  } finally {
    recordAuthEvent({
      rpcName: 'store.auth.end',
      eventKind: 'logout',
      sessionOrigin: 'fresh',
      authToken,
      dealerId: null,
      outcome: errorMessage ? 'error' : 'ok',
      httpStatus,
      errorMessage,
      durationMs: Date.now() - startedAt,
      context: { trigger: 'withSweedSession-teardown' },
    })
  }
}

async function issueFreshSweedSession(login: string, password: string): Promise<FreshSweedSessionLogin> {
  const env = getWorkerEnv()
  const startedAt = Date.now()
  const rpcId = randomUUID()
  // Sweed's JSON-RPC envelope requires `auth` to be either absent
  // (the pre-login case) OR a UUID-formatted session token. Sending
  // `auth: ""` triggers "Request validation error" with details
  // `Value does not match format "uuid"` and the login never gets
  // routed to the auth handler. The HAR snippet at the top of this
  // file accidentally implied an empty string was acceptable — it
  // isn't. Omit the field entirely on the login call.
  const body = {
    id: rpcId,
    name: 'store.auth.user',
    params: { login, password, profileTypeId: 1 },
  }

  // We log exactly one event for the whole login attempt, populated
  // by whichever exit path fires. The token (success path) or error
  // message (failure paths) feeds into the auth log so an operator
  // can see "did the login succeed, and what token did this job get".
  let httpStatus: number | null = null
  let outcome: 'ok' | 'error' | 'retryable' = 'error'
  let errorMessage: string | null = null
  let issuedToken: string | null = null

  // `trigger` makes it obvious in the UI / log whether this login
  // was initiated by a real worker job vs the per-job dependency
  // probe (`verifySweedSession()` from assertSweedReady) vs the
  // boot-time warm probe. The job context AsyncLocalStorage is only
  // populated for the first case, so we use its presence to label.
  const jobCtx = getCurrentJobAuthContext()
  const trigger = jobCtx ? 'job' : 'probe-or-warm-boot'

  const finish = (extra?: Record<string, unknown>): void => {
    recordAuthEvent({
      rpcName: 'store.auth.user',
      eventKind: 'login',
      // Origin of the session being created. The token doesn't exist
      // yet on the failure paths; the field is still 'fresh' because
      // this is the fresh-login codepath.
      sessionOrigin: 'fresh',
      authToken: issuedToken,
      dealerId: null,
      outcome,
      httpStatus,
      errorMessage,
      durationMs: Date.now() - startedAt,
      context: { rpcId, loginEmail: login, trigger, ...extra },
    })
  }

  let response: Response
  try {
    response = await fetch(env.sweedApiUrl, {
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'helios-worker/1.0',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.sweedRequestTimeoutMs),
    })
  } catch (error) {
    outcome = 'retryable'
    errorMessage = `store.auth.user transport failed: ${error instanceof Error ? error.message : String(error)}`
    finish()
    throw new RetryableWorkerError(errorMessage)
  }
  httpStatus = response.status

  const responseText = await response.text()
  if (!response.ok) {
    errorMessage = `store.auth.user returned HTTP ${response.status}: ${truncate(responseText)}`
    if (response.status === 429 || response.status >= 500) {
      outcome = 'retryable'
      finish()
      throw new RetryableWorkerError(errorMessage)
    }
    outcome = 'error'
    finish()
    throw new Error(errorMessage)
  }

  let envelope: {
    error?: { message?: string; code?: number; data?: unknown }
    result?: unknown
  }
  try {
    envelope = JSON.parse(responseText) as typeof envelope
  } catch {
    outcome = 'retryable'
    errorMessage = `store.auth.user returned invalid JSON: ${truncate(responseText)}`
    finish()
    throw new RetryableWorkerError(errorMessage)
  }
  // Sweed wraps reCAPTCHA / pre-auth validation failures in a NESTED
  // `result.error` envelope (`{ result: { error: {...} } }`) instead
  // of the top-level `{ error: {...} }` shape we see for normal RPC
  // errors. Check both so login failures don't fall through to the
  // SignInResultSchema parser, which would then explode with an
  // unhelpful zod "expected string, received undefined" trace.
  const nestedError =
    envelope.result && typeof envelope.result === 'object' && envelope.result !== null
      ? (envelope.result as { error?: { message?: string; code?: number; data?: unknown } }).error
      : undefined
  const rpcError = envelope.error ?? nestedError
  if (rpcError) {
    outcome = 'error'
    errorMessage = `store.auth.user failed: ${rpcError.message ?? 'Unknown Sweed RPC error.'}`
    finish({
      sweedErrorCode: rpcError.code ?? null,
      sweedErrorData: rpcError.data ?? null,
      sweedRawSnippet: truncate(responseText),
    })
    throw new Error(errorMessage)
  }
  if (envelope.result === undefined) {
    outcome = 'error'
    errorMessage = 'store.auth.user returned no result payload.'
    finish({ sweedRawSnippet: truncate(responseText) })
    throw new Error(errorMessage)
  }

  const parsed = SignInResultSchema.parse(envelope.result)
  const initialDealerIdRaw = parsed.initialData?.user?.currentDealerId
  issuedToken = parsed.auth
  outcome = 'ok'
  finish({
    initialDealerId: typeof initialDealerIdRaw === 'number' ? initialDealerIdRaw : null,
    initialDealerName: parsed.initialData?.user?.currentDealerName ?? null,
  })
  return {
    authToken: parsed.auth,
    initialDealerId: typeof initialDealerIdRaw === 'number' ? initialDealerIdRaw : null,
  }
}

interface FreshSweedSessionLogin {
  authToken: string
  initialDealerId: number | null
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 239)}…`
}
