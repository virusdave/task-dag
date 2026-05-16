import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { runWithSweedSessionLock } from './sessionLock.js'

/**
 * Switch the shared Sweed session to `dealerId` and issue an RPC,
 * atomically with respect to other helios workers/jobs sharing the
 * same SWEED_AUTH_TOKEN. See sessionLock.ts for why this matters.
 */
export async function callSweedRpc<TResult>(
  dealerId: number,
  name: string,
  params: Record<string, unknown>,
): Promise<TResult> {
  return runWithSweedSessionLock(async () => {
    await setDealerContextLocked(dealerId)
    return callSweedRpcRaw<TResult>(name, params)
  })
}

export async function ensureDealerContext(dealerId: number): Promise<void> {
  await runWithSweedSessionLock(() => setDealerContextLocked(dealerId))
}

async function setDealerContextLocked(dealerId: number): Promise<void> {
  const result = await callSweedRpcRaw<unknown>('store.auth.dealer.set', { dealerId })
  const parsed = z
    .object({
      user: z.object({
        currentDealerId: z.coerce.number().int(),
        currentDealerName: z.string().nullable().optional(),
      }),
    })
    .parse(result)

  if (parsed.user.currentDealerId !== dealerId) {
    throw new Error(
      `Sweed dealer context mismatch. Expected ${dealerId}, got ${parsed.user.currentDealerId} ${parsed.user.currentDealerName ?? ''}`.trim(),
    )
  }
}

export async function callSweedRpcRaw<TResult>(name: string, params: Record<string, unknown>): Promise<TResult> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required to call the Sweed JSON-RPC API.')
  }

  let response: Response
  try {
    response = await fetch(env.sweedApiUrl, {
      body: JSON.stringify({
        auth: env.sweedAuthToken,
        id: randomUUID(),
        name,
        params,
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
