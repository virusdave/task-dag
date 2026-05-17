import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

import { z } from 'zod'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { recordAuthEvent } from './authLog.js'

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

  let context: SweedSessionContext
  if (hasCredentials) {
    const login = await issueFreshSweedSession(env.sweedLoginEmail as string, env.sweedLoginPassword as string)
    context = {
      authToken: login.authToken,
      origin: 'fresh',
      currentDealerId: login.initialDealerId,
    }
  } else {
    context = { authToken: env.sweedAuthToken as string, origin: 'legacy', currentDealerId: null }
  }

  try {
    return await sessionStorage.run(context, fn)
  } finally {
    if (context.origin === 'fresh') {
      await tearDownFreshSweedSession(context.authToken)
    }
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
  const body = {
    auth: '',
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
      context: { rpcId, loginEmail: login, ...extra },
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

  let envelope: { error?: { message?: string }; result?: unknown }
  try {
    envelope = JSON.parse(responseText) as { error?: { message?: string }; result?: unknown }
  } catch {
    outcome = 'retryable'
    errorMessage = `store.auth.user returned invalid JSON: ${truncate(responseText)}`
    finish()
    throw new RetryableWorkerError(errorMessage)
  }
  if (envelope.error) {
    outcome = 'error'
    errorMessage = `store.auth.user failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`
    finish()
    throw new Error(errorMessage)
  }
  if (envelope.result === undefined) {
    outcome = 'error'
    errorMessage = 'store.auth.user returned no result payload.'
    finish()
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
