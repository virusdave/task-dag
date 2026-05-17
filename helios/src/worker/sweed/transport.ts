import { randomUUID } from 'node:crypto'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { expireClaimedSweedToken } from './activeSessionToken.js'
import {
  looksLikeAuthError,
  recordAuthEvent,
  type SweedAuthEventKind,
} from './authLog.js'
import {
  getCurrentSweedAuthToken,
  getCurrentSweedDealerId,
  getCurrentSweedSessionClaim,
  getCurrentSweedSessionOrigin,
} from './session.js'

// RPCs whose every invocation we always log — they make up the
// per-job auth lifecycle and the dealer-pin sequence that follows.
// Anything else is only persisted to sweed_auth_events when its
// response looks like an auth error (see looksLikeAuthError + the
// rpc_auth_error event kind).
const AUTH_RPC_EVENT_KINDS: Readonly<Record<string, SweedAuthEventKind>> = {
  'store.auth.user': 'login',
  'store.auth.end': 'logout',
  'store.auth.dealer.set': 'dealer_set',
  'store.auth.initial.data.get': 'initial_data',
}

/**
 * Single low-level Sweed JSON-RPC POST. Resolves the auth token in
 * this order:
 *   1. explicit `authToken` arg (dependency probe / one-off scripts
 *      that already hold a token they want to validate directly)
 *   2. the AsyncLocalStorage claim populated by withSweedSession()
 *   3. the legacy env.sweedAuthToken (smoke-test / bootstrap fallback)
 *
 * If nothing resolves an auth token, throws a clear configuration
 * error. Most worker code paths should be inside a withSweedSession
 * block; (3) only kicks in for early-boot probes / dev scripts.
 */
export interface PostSweedRpcOptions {
  name: string
  params?: Record<string, unknown>
  authToken?: string | null
}

export async function postSweedRpc<TResult>({ name, params, authToken }: PostSweedRpcOptions): Promise<TResult> {
  const env = getWorkerEnv()

  const sessionClaim = getCurrentSweedSessionClaim()
  let resolvedAuthToken: string | null = null
  let resolvedTokenRowId: number | null = null
  let resolvedTokenSource: 'explicit' | 'als' | 'db-pasted' | 'env-fallback' | null = null
  if (authToken) {
    resolvedAuthToken = authToken
    resolvedTokenSource = 'explicit'
  } else if (sessionClaim !== null) {
    resolvedAuthToken = sessionClaim.token
    resolvedTokenRowId = sessionClaim.rowId
    // Distinguish 'db-pasted' (real pool row, eligible for auth-error
    // retirement) from 'env-fallback' (env var, nothing to retire).
    resolvedTokenSource = sessionClaim.source
  } else {
    const alsToken = getCurrentSweedAuthToken()
    if (alsToken) {
      resolvedAuthToken = alsToken
      resolvedTokenSource = 'als'
    } else if (env.sweedAuthToken) {
      resolvedAuthToken = env.sweedAuthToken
      resolvedTokenSource = 'env-fallback'
    }
  }

  if (!resolvedAuthToken) {
    throw new Error(
      `${name}: no Sweed auth token available. Paste a session UUID at /config/sweed/sessions ` +
        `(or set SWEED_AUTH_TOKEN as a bootstrap fallback), or wrap the call in withSweedSession().`,
    )
  }

  const startedAt = Date.now()
  const rpcId = randomUUID()
  // Snapshot the session origin / dealer at the moment the call
  // fires so the log row reflects context that's stable for this
  // exact RPC (rather than whatever the AsyncLocalStorage holds
  // when the deferred logger eventually runs).
  const sessionOrigin =
    getCurrentSweedSessionOrigin() ??
    (resolvedTokenSource === 'db-pasted' || resolvedTokenSource === 'env-fallback' ? 'legacy' : null)
  const sessionDealerId = getCurrentSweedDealerId()
  const explicitEventKind = AUTH_RPC_EVENT_KINDS[name] ?? null
  let httpStatus: number | null = null
  let outcome: 'ok' | 'error' | 'retryable' = 'error'
  let errorMessage: string | null = null

  // `dealerId` is provided by callers of store.auth.dealer.set via
  // params.dealerId; pull it out for the log row when we have it.
  const dealerSetTarget =
    typeof (params as { dealerId?: unknown } | undefined)?.dealerId === 'number'
      ? ((params as { dealerId: number }).dealerId)
      : null

  const emit = (extraContext?: Record<string, unknown>): void => {
    const isAuthRpc = explicitEventKind !== null
    const failed = outcome !== 'ok'
    // We always emit for auth-lifecycle RPCs (login/logout/dealer_set/
    // initial_data), and for ANY failure of any RPC. Successful non-
    // auth RPCs are intentionally NOT persisted to keep the table
    // bounded — there can be thousands of them per job.
    if (!isAuthRpc && !failed) {
      return
    }
    let eventKind: SweedAuthEventKind
    if (explicitEventKind !== null) {
      eventKind = explicitEventKind
    } else if (looksLikeAuthError(errorMessage, httpStatus)) {
      eventKind = 'rpc_auth_error'
    } else {
      eventKind = 'rpc_error'
    }
    recordAuthEvent({
      rpcName: name,
      eventKind,
      sessionOrigin,
      authToken: resolvedAuthToken,
      dealerId: dealerSetTarget ?? sessionDealerId,
      outcome,
      httpStatus,
      errorMessage,
      durationMs: Date.now() - startedAt,
      context: {
        rpcId,
        tokenSource: resolvedTokenSource,
        tokenRowId: resolvedTokenRowId,
        paramKeys: params ? Object.keys(params) : [],
        ...extraContext,
      },
    })
  }

  // When a DB-pasted pool token sees an auth-error response, retire
  // it permanently so the next claim attempt skips it and the
  // operator gets prompted to paste a fresh one. The claim row is
  // never returned to the pool in that case.
  const maybeExpireDbToken = (): void => {
    if (sessionClaim === null || sessionClaim.source !== 'db-pasted') {
      return
    }
    if (!looksLikeAuthError(errorMessage, httpStatus)) {
      return
    }
    void expireClaimedSweedToken(
      sessionClaim,
      `${name} returned auth error: ${errorMessage ?? 'unknown'}`,
    )
  }

  let response: Response
  try {
    response = await fetch(env.sweedApiUrl, {
      body: JSON.stringify({
        auth: resolvedAuthToken,
        id: rpcId,
        name,
        ...(params === undefined ? {} : { params }),
      }),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'helios-worker/1.0',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.sweedRequestTimeoutMs),
    })
  } catch (error) {
    outcome = 'retryable'
    errorMessage = buildTransportErrorMessage(name, error)
    emit({ transportFailure: true })
    throw new RetryableWorkerError(errorMessage)
  }
  httpStatus = response.status

  const responseText = await response.text()
  if (!response.ok) {
    errorMessage = `${name} returned HTTP ${response.status}: ${truncate(responseText)}`
    if (isRetryableStatusCode(response.status)) {
      outcome = 'retryable'
      emit()
      maybeExpireDbToken()
      throw new RetryableWorkerError(errorMessage)
    }
    outcome = 'error'
    emit()
    maybeExpireDbToken()
    throw new Error(errorMessage)
  }

  let envelope: { error?: { message?: string }; result?: TResult }
  try {
    envelope = JSON.parse(responseText) as { error?: { message?: string }; result?: TResult }
  } catch {
    outcome = 'retryable'
    errorMessage = `${name} returned an invalid JSON response: ${truncate(responseText)}`
    emit()
    throw new RetryableWorkerError(errorMessage)
  }

  // Sweed wraps some pre-auth failures in a NESTED result.error
  // envelope (see session.ts for the same handling on store.auth.user).
  // Treat both shapes as RPC errors so an "Auth expired" hiding
  // inside { result: { error: {...} } } still retires the token.
  const nestedError =
    envelope.result && typeof envelope.result === 'object' && envelope.result !== null
      ? (envelope.result as { error?: { message?: string } }).error
      : undefined
  const rpcError = envelope.error ?? nestedError
  if (rpcError) {
    outcome = 'error'
    errorMessage = `${name} failed: ${rpcError.message ?? 'Unknown Sweed RPC error.'}`
    emit()
    maybeExpireDbToken()
    throw new Error(errorMessage)
  }
  if (envelope.result === undefined) {
    outcome = 'error'
    errorMessage = `${name} returned no result payload.`
    emit()
    throw new Error(errorMessage)
  }

  outcome = 'ok'
  emit()
  return envelope.result
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 403 || statusCode === 429 || (statusCode >= 500 && statusCode <= 504)
}

function buildTransportErrorMessage(name: string, error: unknown): string {
  if (error instanceof Error && error.message) {
    return `${name} transport failed: ${error.message}`
  }
  return `${name} transport failed.`
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 239)}…`
}
