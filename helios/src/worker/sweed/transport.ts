import { randomUUID } from 'node:crypto'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { getCurrentSweedAuthToken, getCurrentSweedSessionOrigin } from './session.js'

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

  let response: Response
  try {
    response = await fetch(env.sweedApiUrl, {
      body: JSON.stringify({
        auth: resolvedAuthToken,
        id: randomUUID(),
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
    throw new RetryableWorkerError(buildTransportErrorMessage(name, error))
  }

  const responseText = await response.text()
  if (!response.ok) {
    const message = `${name} returned HTTP ${response.status}: ${truncate(responseText)}`
    if (isRetryableStatusCode(response.status)) {
      throw new RetryableWorkerError(message)
    }
    throw new Error(message)
  }

  let envelope: { error?: { message?: string }; result?: TResult }
  try {
    envelope = JSON.parse(responseText) as { error?: { message?: string }; result?: TResult }
  } catch {
    throw new RetryableWorkerError(`${name} returned an invalid JSON response: ${truncate(responseText)}`)
  }

  if (envelope.error) {
    throw new Error(`${name} failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`)
  }
  if (envelope.result === undefined) {
    throw new Error(`${name} returned no result payload.`)
  }
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
