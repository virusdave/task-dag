import { randomUUID } from 'node:crypto'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import {
  looksLikeAuthError,
  recordAuthEvent,
  type SweedAuthEventKind,
} from './authLog.js'
import {
  getCurrentSweedAuthToken,
  getCurrentSweedDealerId,
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
 *   1. explicit `authToken` passed in (used by the login flow itself
 *      and by callers that already hold a session token)
 *   2. the AsyncLocalStorage cell populated by withSweedSession()
 *   3. the legacy env.sweedAuthToken (shared-token mode)
 *
 * If nothing resolves an auth token, throws a clear configuration
 * error. If we silently fall back to the legacy shared token while a
 * job has been migrated to withSweedSession, that's a bug we want to
 * surface, not paper over.
 */
export interface PostSweedRpcOptions {
  name: string
  params?: Record<string, unknown>
  authToken?: string | null
}

export async function postSweedRpc<TResult>({ name, params, authToken }: PostSweedRpcOptions): Promise<TResult> {
  const env = getWorkerEnv()
  const resolvedAuthToken = authToken ?? getCurrentSweedAuthToken() ?? env.sweedAuthToken

  if (!resolvedAuthToken) {
    throw new Error(
      `${name}: no Sweed auth token available. Configure SWEED_LOGIN_EMAIL+SWEED_LOGIN_PASSWORD or SWEED_AUTH_TOKEN, ` +
        `or wrap the call in withSweedSession().`,
    )
  }

  // Diagnostic: legacy shared-token path is racy; log once-per-job so
  // missed withSweedSession() wrappers don't pass silently.
  if (
    getCurrentSweedAuthToken() === null &&
    getCurrentSweedSessionOrigin() === null &&
    !authToken &&
    !warnedAboutLegacyTokenUse
  ) {
    warnedAboutLegacyTokenUse = true
    console.warn(
      '[sweed] Using legacy shared SWEED_AUTH_TOKEN. Wrap the caller in withSweedSession() to remove the dealer-context race.',
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
    (resolvedAuthToken === env.sweedAuthToken ? 'legacy' : null)
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
        paramKeys: params ? Object.keys(params) : [],
        ...extraContext,
      },
    })
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
      throw new RetryableWorkerError(errorMessage)
    }
    outcome = 'error'
    emit()
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

  if (envelope.error) {
    outcome = 'error'
    errorMessage = `${name} failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`
    emit()
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

let warnedAboutLegacyTokenUse = false

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
