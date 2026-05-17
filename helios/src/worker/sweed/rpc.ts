import { z } from 'zod'

import {
  getCurrentSweedDealerId,
  hasActiveSweedSession,
  setCurrentSweedDealerId,
} from './session.js'
import { runWithSweedSessionLock } from './sessionLock.js'
import { postSweedRpc } from './transport.js'

/**
 * Switch the Sweed session to `dealerId` and issue an RPC.
 *
 * When the caller has opened a per-job session via `withSweedSession()`,
 * this job owns its own private auth token, so no other job can race
 * the dealer context: the dealer-set + follow-up RPC pair is naturally
 * atomic-per-job and no extra serialization is needed.
 *
 * When the caller is still using the legacy shared SWEED_AUTH_TOKEN
 * (no active session in the AsyncLocalStorage cell), we fall back to
 * the process-wide mutex (`runWithSweedSessionLock`) so that two
 * concurrent jobs sharing one token cannot clobber each other's
 * server-side dealer context.
 */
export async function callSweedRpc<TResult>(
  dealerId: number,
  name: string,
  params: Record<string, unknown>,
): Promise<TResult> {
  return runWithDealerSerialization(async () => {
    await setDealerContextLocked(dealerId)
    return postSweedRpc<TResult>({ name, params })
  })
}

export async function ensureDealerContext(dealerId: number): Promise<void> {
  await runWithDealerSerialization(() => setDealerContextLocked(dealerId))
}

async function setDealerContextLocked(dealerId: number): Promise<void> {
  // Sweed keeps the dealer context sticky per session token, so once
  // we've pinned this session to `dealerId` there's no need to issue
  // another `store.auth.dealer.set` for the same dealer. This avoids
  // doubling the RPC count on hot paths that issue many calls in a
  // row against the same dealer (e.g. the catalog maintenance write
  // flow, which previously called dealer.set before every single
  // Sweed call even though it always targets the state dealer).
  if (hasActiveSweedSession() && getCurrentSweedDealerId() === dealerId) {
    return
  }

  const result = await postSweedRpc<unknown>({ name: 'store.auth.dealer.set', params: { dealerId } })
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

  setCurrentSweedDealerId(dealerId)
}

export async function callSweedRpcRaw<TResult>(
  name: string,
  params?: Record<string, unknown>,
): Promise<TResult> {
  return postSweedRpc<TResult>({ name, params })
}

function runWithDealerSerialization<T>(fn: () => Promise<T>): Promise<T> {
  if (hasActiveSweedSession()) {
    return fn()
  }
  return runWithSweedSessionLock(fn)
}
