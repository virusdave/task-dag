import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

import { z } from 'zod'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'

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
 * No sign-out is issued; tokens are left to expire on the Sweed side.
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
    const authToken = await issueFreshSweedSession(env.sweedLoginEmail as string, env.sweedLoginPassword as string)
    context = { authToken, origin: 'fresh' }
  } else {
    context = { authToken: env.sweedAuthToken as string, origin: 'legacy' }
  }

  return sessionStorage.run(context, fn)
}

async function issueFreshSweedSession(login: string, password: string): Promise<string> {
  const env = getWorkerEnv()
  const body = {
    auth: '',
    id: randomUUID(),
    name: 'store.auth.user',
    params: { login, password, profileTypeId: 1 },
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
    throw new RetryableWorkerError(
      `store.auth.user transport failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const responseText = await response.text()
  if (!response.ok) {
    const message = `store.auth.user returned HTTP ${response.status}: ${truncate(responseText)}`
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableWorkerError(message)
    }
    throw new Error(message)
  }

  let envelope: { error?: { message?: string }; result?: unknown }
  try {
    envelope = JSON.parse(responseText) as { error?: { message?: string }; result?: unknown }
  } catch {
    throw new RetryableWorkerError(`store.auth.user returned invalid JSON: ${truncate(responseText)}`)
  }
  if (envelope.error) {
    throw new Error(`store.auth.user failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`)
  }
  if (envelope.result === undefined) {
    throw new Error('store.auth.user returned no result payload.')
  }

  const parsed = SignInResultSchema.parse(envelope.result)
  return parsed.auth
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 239)}…`
}
