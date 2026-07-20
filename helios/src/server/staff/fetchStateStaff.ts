import { z } from 'zod'

import { callSweedRpcRaw } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'
import { getServerEnv } from '../config/env.js'
import type { UpstreamStaffDirectoryRow } from '../db/queries/staffQueries.js'

const SweedDealerAssignmentSchema = z
  .object({
    dealerId: z.coerce.number().int().nullable().optional(),
    dealerName: z.string().nullable().optional(),
  })
  .passthrough()

export const SweedComplianceUserSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().nullable().optional(),
    photoUrl: z.string().nullable().optional(),
    currentDealerId: z.coerce.number().int().nullable().optional(),
    currentDealerName: z.string().nullable().optional(),
    blocked: z.boolean(),
    userStatus: z.coerce.number().int().nullable().optional(),
    dealers: z.array(SweedDealerAssignmentSchema).optional(),
  })
  .passthrough()

const SweedComplianceListResultSchema = z.object({
  page: z.coerce.number().int(),
  pageSize: z.coerce.number().int(),
  totalCount: z.coerce.number().int(),
  data: z.array(SweedComplianceUserSchema),
})

const PAGE_SIZE = 200

function nonEmpty(s: string | null | undefined): string | null {
  if (!s) return null
  const t = s.trim()
  return t.length === 0 ? null : t
}

function deriveFirstName(parsed: z.infer<typeof SweedComplianceUserSchema>): string {
  if (parsed.firstName && parsed.firstName.trim().length > 0) return parsed.firstName.trim()
  if (parsed.name && parsed.name.trim().length > 0) {
    const head = parsed.name.trim().split(/\s+/)[0]
    if (head) return head
  }
  return parsed.id
}

function deriveFullName(parsed: z.infer<typeof SweedComplianceUserSchema>): string {
  if (parsed.name && parsed.name.trim().length > 0) return parsed.name.trim()
  const first = (parsed.firstName ?? '').trim()
  const last = (parsed.lastName ?? '').trim()
  const joined = `${first} ${last}`.trim()
  return joined.length > 0 ? joined : parsed.id
}

/**
 * Fetch every state-level employee from Sweed via
 * `user.compliance.list` against the state dealer. The state dealer is
 * the umbrella account (e.g. "Freshly Baked NY", id 210248) — its
 * employee list is the union across all per-site dealers, which is
 * what the Utilities → Staff page wants to reason about.
 */
export async function fetchStateStaffDirectory(): Promise<UpstreamStaffDirectoryRow[]> {
  const stateDealerId = getServerEnv().sweedStateDealerId
  const collected: UpstreamStaffDirectoryRow[] = []
  const seenStaffIds = new Set<string>()

  await withSweedSession(async () => {
    const dealerSet = await callSweedRpcRaw<{ user?: { currentDealerId?: unknown } }>(
      'store.auth.dealer.set',
      { dealerId: stateDealerId },
    )
    if (Number(dealerSet.user?.currentDealerId) !== stateDealerId) {
      throw new Error(
        `[fetchStateStaffDirectory] dealer.set mismatch: expected ${stateDealerId}, got ${dealerSet.user?.currentDealerId}`,
      )
    }

    let page = 1
    let totalCount: number | null = null
    while (true) {
      const raw = await callSweedRpcRaw<unknown>('user.compliance.list', {
        page,
        pageSize: PAGE_SIZE,
        enabled: true,
      })
      const parsed = SweedComplianceListResultSchema.parse(raw)
      if (parsed.page !== page) {
        throw new Error(
          `[fetchStateStaffDirectory] page mismatch: requested ${page}, received ${parsed.page}`,
        )
      }
      if (totalCount === null) totalCount = parsed.totalCount
      else if (parsed.totalCount !== totalCount) {
        throw new Error(
          `[fetchStateStaffDirectory] totalCount changed during pagination: expected ${totalCount}, received ${parsed.totalCount}`,
        )
      }
      for (const user of parsed.data) {
        if (seenStaffIds.has(user.id)) {
          throw new Error(`[fetchStateStaffDirectory] duplicate staff id across pages: ${user.id}`)
        }
        seenStaffIds.add(user.id)
        collected.push({
          staffId: user.id,
          fullName: deriveFullName(user),
          firstName: deriveFirstName(user),
          lastName: nonEmpty(user.lastName ?? null),
          email: nonEmpty(user.email ?? null),
          photoUrl: nonEmpty(user.photoUrl ?? null),
          currentDealerId: user.currentDealerId ?? null,
          currentDealerName: nonEmpty(user.currentDealerName ?? null),
          blocked: user.blocked,
          userStatus: user.userStatus ?? null,
          raw: user,
        })
      }
      if (collected.length > (totalCount ?? 0)) {
        throw new Error(
          `[fetchStateStaffDirectory] received ${collected.length} rows for totalCount ${totalCount}`,
        )
      }
      if (collected.length === (totalCount ?? 0)) break
      if (parsed.data.length === 0) {
        throw new Error(
          `[fetchStateStaffDirectory] incomplete pagination: received ${collected.length} of ${totalCount}`,
        )
      }
      page += 1
      if (page > 100) {
        throw new Error('[fetchStateStaffDirectory] pagination safeguard exceeded (>100 pages)')
      }
    }
    if (collected.length !== totalCount) {
      throw new Error(
        `[fetchStateStaffDirectory] incomplete snapshot: received ${collected.length} of ${totalCount}`,
      )
    }
  })

  return collected
}
